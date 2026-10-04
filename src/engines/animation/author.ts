import type { ModelRouter } from '../../llm/router.js';
import { deterministic } from '../../llm/providers/deterministic.js';
import { auditScene, type SceneAudit } from './compiler.js';
import type { Scene } from './primitives.js';
import { buildAnimation, hasAnimation, listAnimations } from './library.js';
import {
  ANIMATABLE_CHANNELS, PRIMITIVE_KINDS, STORYBOARD_SCHEMA, compileStoryboard,
  sanitizeStoryboard, type ElementSpec, type SanitizeResult, type Storyboard,
} from './storyboard.js';
import { keyphrases, sentences, truncate, words } from '../../core/textkit.js';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { round } from '../../core/mathx.js';

/** THE SCENE AUTHOR
 *
 *  A hand-written animation per concept does not scale: 21 builders cannot
 *  cover 109 concepts, let alone an uploaded textbook chapter. So the model
 *  becomes the AUTHOR and the compiler stays the RUNTIME.
 *
 *  The model never emits SVG. It emits a storyboard of named teaching
 *  primitives, which is then sanitized, clamped, compiled and audited by code.
 *  If the audit fails, the issues go back to the model once. If that fails too,
 *  it falls back to the curated builder, and failing that to a deterministic
 *  structural animation. Something always renders, and nothing unaudited ever
 *  reaches a learner. */

export interface AuthorRequest {
  /** Concept label, e.g. "Photosynthesis" or "Supply and demand". */
  topic: string;
  /** A paragraph of source material, if there is one. */
  description?: string;
  conceptSlug?: string;
  subject?: string;
  grade?: number;
  /** The wrong idea this should attack head-on, if known. */
  misconception?: string;
  /** Vocabulary the learner must keep. */
  keyTerms?: string[];
  /** Accessibility: slow the pacing, kill the motion. */
  paceMultiplier?: number;
  reduceMotion?: boolean;
  background?: string;
  /** 'auto' prefers a curated builder when one exists; 'model' always authors. */
  mode?: 'auto' | 'model' | 'curated';
  seed?: string;
}

export interface AuthorResult {
  scene: Scene;
  source: 'curated' | 'model' | 'model_repaired' | 'offline_structural';
  audit: SceneAudit;
  attempts: number;
  repairs: string[];
  rejected: string[];
  notes: string[];
  provider?: string;
  model?: string;
  costUsd?: number;
}

/* ------------------------------ the prompt -------------------------------- */

const PRIMITIVE_GUIDE = `
AVAILABLE PRIMITIVES (use "kind"):
  label        text. {text, x, y, size, anchor:start|middle|end, weight}
  arrow        {x, y, x2, y2, label}            line with a head; use for cause, flow, force direction
  line         {x, y, x2, y2, dashed}
  circle       {x, y, r, label}
  rect         {x, y, w, h, label}
  polygon      {points:"x,y x,y x,y", label}    triangles, shapes
  curve        {points:"x,y x,y ...", closed}   graphs, paths, trajectories
  highlight    {x, y, w, h}                     translucent box to draw the eye
  numberLine   {x, y, width, min, max, step, marks:"0.5:a half", pointer}
  fractionBar  {x, y, width, height, parts, shaded, label, showLabels}
  areaModel    {x, y, rows, cols, cell, shadedRows, shadedCols, label}   arrays, area, multiplication
  barChart     {x, y, width, height, bars:"before:4, after:6"}
  axes         {x, y, width, height, xMin, xMax, yMin, yMax, xLabel, yLabel}
  forceVector  {x, y, magnitude, angleDeg, label}   length means size; 0deg is right, 90deg is up
  particle     {x, y, r, charge:+|-|neutral, label}
  spring       {x, y, x2, y2, coils}
  wave         {x, y, width, amplitude, wavelength, phase}
  orbit        {x, y, rx, ry, r, angleDeg}
  beam         {x, y, x2, y2, rays, spread}     light, radiation
  molecule     {x, y, atoms:"C:0,0 O:-28,0 O:28,0", bonds:"0-1:2 0-2:2", label}
  cell         {x, y, rx, ry, organelles:"nucleus:-60,-20,30 chloroplast:70,30,26"}
  timeline     {x, y, width, events:"1905:special relativity, 1915:general relativity"}
  bracket      {x, y, x2, y2, label}            group and name a span
  angleArc     {x, y, r, startDeg, endDeg, label}
  balance      {x, y, width, tilt, left:"2x:2, 3:3", right:"11:11"}   equations as a scale
  counter      {x, y, value, decimals, prefix, suffix}
  grid         {x, y, w, h, cell}

COLOURS (names only, never hex): ink, muted, paper, primary, secondary, tertiary,
accent, warn, good, highlight, grid.
Use "warn" for the wrong idea, "good" for the correct result, "primary" and
"secondary" to distinguish two things being compared.

ANIMATABLE CHANNELS: ${ANIMATABLE_CHANNELS.join(', ')}.
  shaded      fill a fractionBar up
  pointer     move a marker along a numberLine
  x / y       move an element
  angleDeg    rotate an orbit, swing a forceVector
  phase       make a wave travel
  value       count a counter up
  tilt        tip a balance
  opacity     fade in or out
`.trim();

const RULES = `
HOW TO BUILD A GOOD EXPLANATION:
1. Every beat must have narration in "say". A beat with no words is unusable by
   a learner who cannot see the screen. Keep it to one or two spoken sentences.
2. If there is a misconception, show it FAILING before you show the right
   answer. Watching your own rule break is what dislodges it; being told it is
   wrong is not.
3. Build one idea per beat. Introduce at most 3 or 4 new elements at a time.
4. Use concrete models before symbols: a bar before a fraction, an array before
   a product, a balance before an equation.
5. Finish with the result stated in "good" colour, and say it out loud too.
6. Canvas is 900 wide by 520 tall. y increases DOWNWARD. Keep everything inside
   40..860 horizontally and 40..470 vertically. Leave the top 70px for a title.
7. Give each element a short lowercase id and reuse that id to animate or hide it.
8. 4 to 6 beats is usually right. Never more than 8.
9. Put a "describe" on any element that carries meaning, saying what it shows.
`.trim();

/** One compact worked exemplar. Shows the shape AND the pedagogy. */
const EXEMPLAR = JSON.stringify({
  title: 'Why 1/3 is bigger than 1/8',
  goal: 'The denominator counts the cuts, so more parts means smaller parts.',
  misconception: '8 is bigger than 3, so 1/8 must be the bigger fraction',
  width: 900,
  height: 520,
  beats: [
    {
      say: 'Which is bigger: one third, or one eighth?',
      show: [{ id: 'q', kind: 'label', text: '1/3 or 1/8?', x: 450, y: 60, size: 32, anchor: 'middle', weight: 700 }],
    },
    {
      say: 'Eight is a bigger number than three, so it is tempting to pick one eighth. Hold that thought.',
      show: [{ id: 'guess', kind: 'label', text: '8 > 3, so 1/8 > 1/3?', x: 450, y: 120, size: 22, anchor: 'middle', color: 'warn' }],
    },
    {
      say: 'Here is one whole cut into three equal parts, with one part shaded.',
      show: [{
        id: 'third', kind: 'fractionBar', x: 90, y: 180, width: 320, height: 64,
        parts: 3, shaded: 0, label: '1/3', showLabels: true, fill: 'primary',
        describe: 'A bar cut into three equal parts with one shaded.',
      }],
      animate: [{ target: 'third', channel: 'shaded', from: 0, to: 1, easing: 'ease_out' }],
    },
    {
      say: 'And the same whole cut into eight equal parts, with one part shaded. The piece is visibly thinner.',
      show: [{
        id: 'eighth', kind: 'fractionBar', x: 480, y: 180, width: 320, height: 64,
        parts: 8, shaded: 0, label: '1/8', fill: 'secondary',
        describe: 'An identical bar cut into eight parts with one shaded.',
      }],
      animate: [{ target: 'eighth', channel: 'shaded', from: 0, to: 1, easing: 'ease_out' }],
    },
    {
      say: 'More cuts means each piece is smaller. So one third is the bigger fraction.',
      hide: ['guess'],
      show: [{ id: 'ans', kind: 'label', text: '1/3 > 1/8', x: 450, y: 420, size: 30, anchor: 'middle', color: 'good', weight: 700 }],
    },
  ],
});

function buildPrompt(req: AuthorRequest): string {
  const parts: string[] = [`CONCEPT: ${req.topic}`];
  if (req.subject) parts.push(`SUBJECT: ${req.subject}`);
  if (req.grade) parts.push(`AUDIENCE: around grade ${req.grade} (age ${req.grade + 5}). Use words they already have.`);
  if (req.description) parts.push(`SOURCE MATERIAL:\n${truncate(req.description, 1400)}`);
  if (req.keyTerms?.length) parts.push(`KEEP THIS VOCABULARY (do not simplify it away): ${req.keyTerms.join(', ')}`);
  if (req.misconception) {
    parts.push(`MISCONCEPTION TO ATTACK: ${req.misconception}\nShow this failing on a concrete example before you give the right answer.`);
  }
  if (req.reduceMotion) parts.push('This learner needs reduced motion: prefer appearing and highlighting over travel.');
  parts.push('', PRIMITIVE_GUIDE, '', RULES, '', `EXAMPLE OF A GOOD STORYBOARD:\n${EXEMPLAR}`);
  parts.push('', `Now write the storyboard for "${req.topic}". Return JSON only.`);
  return parts.join('\n');
}

const SYSTEM = 'You design animated explanations for school students. You are given a drawing '
  + 'vocabulary and you compose a storyboard from it. You never write SVG, code or markup - only the '
  + 'storyboard JSON. You care about one thing: that a student who did not understand the idea before '
  + 'understands it after. You always narrate, you always build from something concrete, and when a '
  + 'misconception is named you make it fail on screen before correcting it.';

/* -------------------------------- the author ------------------------------ */

export class SceneAuthor {
  constructor(private router: ModelRouter) {
    registerOfflineAuthor();
  }

  async author(req: AuthorRequest): Promise<AuthorResult> {
    const notes: string[] = [];
    const mode = req.mode ?? config.animation.authorMode;

    // A hand-tuned builder, where one exists, beats a generated one: it is
    // instant, free, and already pedagogically checked.
    if (mode !== 'model' && req.conceptSlug && hasAnimation(req.conceptSlug)) {
      const scene = buildAnimation({
        conceptSlug: req.conceptSlug,
        grade: req.grade,
        paceMultiplier: req.paceMultiplier,
        reduceMotion: req.reduceMotion,
        background: req.background,
      });
      if (scene) {
        return {
          scene, source: 'curated', audit: auditScene(scene), attempts: 0,
          repairs: [], rejected: [],
          notes: [`used the curated builder for "${req.conceptSlug}"`],
        };
      }
    }
    if (mode === 'curated') {
      notes.push(`no curated builder for "${req.conceptSlug ?? req.topic}", falling back to a structural animation`);
      return this.structural(req, notes);
    }

    let lastIssues: string[] = [];
    let best: { result: AuthorResult; score: number } | null = null;

    const maxAttempts = Math.max(1, config.animation.repairAttempts);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt = attempt === 1
        ? buildPrompt(req)
        : `${buildPrompt(req)}\n\nYour previous attempt was rejected by the quality check:\n`
          + lastIssues.map((i) => `- ${i}`).join('\n')
          + '\nFix every one of these and return the corrected storyboard JSON.';

      try {
        const { value, res } = await this.router.structured<Storyboard>({
          purpose: 'animation.storyboard',
          tier: 'balanced',
          schema: STORYBOARD_SCHEMA,
          system: SYSTEM,
          messages: [{ role: 'user', content: prompt }],
          seed: `${req.seed ?? req.conceptSlug ?? req.topic}:${attempt}`,
          temperature: attempt === 1 ? 0.4 : 0.15,
          maxTokens: 6000,
          offlineContext: {
            topic: req.topic,
            description: req.description,
            grade: req.grade,
            keyTerms: req.keyTerms,
            misconception: req.misconception,
          },
        });

        const sanitized = sanitizeStoryboard(value, {
          maxBeats: config.animation.maxBeats,
          maxTotalSeconds: config.animation.maxRuntimeSec,
        });
        const scene = compileStoryboard(sanitized, {
          paceMultiplier: req.paceMultiplier,
          reduceMotion: req.reduceMotion,
          background: req.background,
          meta: { conceptSlug: req.conceptSlug, authoredBy: res.provider, model: res.model },
        });
        const audit = auditScene(scene);

        const result: AuthorResult = {
          scene,
          // An offline-engine storyboard is structural, not model-authored -
          // say so, rather than crediting a model that never ran.
          source: res.degraded ? 'offline_structural' : attempt === 1 ? 'model' : 'model_repaired',
          audit,
          attempts: attempt,
          repairs: sanitized.repairs,
          rejected: sanitized.rejected,
          notes: [...notes, res.degraded ? 'authored by the offline engine (no hosted model configured)' : `authored by ${res.provider}/${res.model}`],
          provider: res.provider,
          model: res.model,
          costUsd: res.usage.costUsd,
        };

        // Score so a second attempt only wins if it is genuinely better.
        const score = audit.score - sanitized.rejected.length * 0.05;
        if (!best || score > best.score) best = { result, score };

        // The offline engine is deterministic: a second attempt would return
        // byte-for-byte the same thing, so stop rather than burn a round.
        if (res.degraded) return result;
        if (audit.ok && !sanitized.rejected.length) return result;

        lastIssues = [...audit.issues, ...sanitized.rejected.slice(0, 6)];
        logger.debug('storyboard failed the quality check, retrying', {
          topic: req.topic, attempt, issues: lastIssues.length,
        });
      } catch (e) {
        lastIssues = [`generation failed: ${e instanceof Error ? e.message : String(e)}`];
        logger.warn('scene authoring failed', { topic: req.topic, attempt, err: String(e) });
      }
    }

    if (best && best.result.audit.score >= 0.5) {
      best.result.notes.push('shipped after a repair pass; residual issues are listed in the audit');
      return best.result;
    }

    // Last resort: a curated builder, then a deterministic structural scene.
    if (req.conceptSlug && hasAnimation(req.conceptSlug)) {
      const scene = buildAnimation({ conceptSlug: req.conceptSlug, grade: req.grade, reduceMotion: req.reduceMotion });
      if (scene) {
        return {
          scene, source: 'curated', audit: auditScene(scene), attempts: 2, repairs: [], rejected: [],
          notes: [...notes, 'model output failed the quality check twice; fell back to the curated builder'],
        };
      }
    }
    notes.push('model output failed the quality check; fell back to a deterministic structural animation');
    return this.structural(req, notes);
  }

  private structural(req: AuthorRequest, notes: string[]): AuthorResult {
    const sanitized = sanitizeStoryboard(structuralStoryboard(req));
    const scene = compileStoryboard(sanitized, {
      paceMultiplier: req.paceMultiplier,
      reduceMotion: req.reduceMotion,
      background: req.background,
      meta: { conceptSlug: req.conceptSlug, authoredBy: 'structural' },
    });
    return {
      scene, source: 'offline_structural', audit: auditScene(scene), attempts: 0,
      repairs: sanitized.repairs, rejected: sanitized.rejected, notes,
    };
  }
}

/* --------------------------- structural fallback -------------------------- */

/** A real, if generic, explanation built from the source text alone.
 *
 *  Title, the vocabulary that matters, the idea broken into numbered steps with
 *  a highlight walking down them, and a closing statement. No model, no network,
 *  no guessing - it says only what the source text already said. */
export function structuralStoryboard(req: AuthorRequest): Storyboard {
  const source = req.description?.trim() || `${req.topic}.`;
  const steps = sentences(source).filter((s) => words(s).length >= 4).slice(0, 4);
  const terms = (req.keyTerms?.length ? req.keyTerms : keyphrases(source, 4).map((k) => k.phrase))
    .slice(0, 4)
    .map((t) => truncate(t, 28));

  const beats: Storyboard['beats'] = [{
    say: `Let us look at ${req.topic}.`,
    show: [{
      id: 'title', kind: 'label', text: truncate(req.topic, 46),
      x: 450, y: 62, size: 32, anchor: 'middle', weight: 700,
      describe: `Title card reading ${req.topic}.`,
    } as ElementSpec],
  }];

  if (terms.length) {
    beats.push({
      say: `First, the words that carry the meaning: ${terms.join(', ')}.`,
      show: terms.map((t, i) => ({
        id: `term${i}`, kind: 'label', text: `• ${t}`,
        x: 120, y: 140 + i * 38, size: 21, color: 'accent',
      } as ElementSpec)),
    });
  }

  const stepTop = 140 + terms.length * 38 + 30;
  steps.forEach((s, i) => {
    beats.push({
      say: truncate(s, 200),
      show: [
        {
          id: `mark${i}`, kind: 'highlight',
          x: 96, y: stepTop + i * 46 - 24, w: 710, h: 36, fill: 'highlight', opacity: 0.45,
        } as ElementSpec,
        {
          id: `step${i}`, kind: 'label', text: `${i + 1}. ${truncate(s, 74)}`,
          x: 110, y: stepTop + i * 46, size: 19,
          describe: s,
        } as ElementSpec,
      ],
    });
  });

  beats.push({
    say: req.misconception
      ? `Remember: ${req.misconception} is the trap here. Check your reasoning against the steps above.`
      : `So that is ${req.topic}. Say it back in your own words before moving on.`,
    show: [{
      id: 'close', kind: 'label',
      text: truncate(req.misconception ? `Watch out: ${req.misconception}` : `${req.topic} — in your own words?`, 60),
      x: 450, y: 470, size: 22, anchor: 'middle',
      color: req.misconception ? 'warn' : 'good', weight: 700,
    } as ElementSpec],
  });

  return {
    title: truncate(req.topic, 70),
    goal: `Describe ${req.topic} accurately in your own words.`,
    misconception: req.misconception,
    width: 900,
    height: 520,
    beats: beats.slice(0, 8),
  };
}

/** The offline engine's answer for storyboard requests. */
function registerOfflineAuthor(): void {
  deterministic.register('animation.storyboard', (ctx) => {
    // Only ever use terms supplied explicitly by the caller. ctx.keyTerms is
    // extracted from the assembled prompt, which contains the primitive guide -
    // using it would put "charge neutral label spring" in front of a learner.
    const supplied = Array.isArray(ctx.extra.keyTerms)
      ? (ctx.extra.keyTerms as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 1)
      : [];
    return structuralStoryboard({
      topic: String(ctx.extra.topic ?? ctx.topic),
      description: typeof ctx.extra.description === 'string' ? ctx.extra.description : undefined,
      grade: ctx.grade,
      keyTerms: supplied.length ? supplied : undefined,
      misconception: typeof ctx.extra.misconception === 'string' ? ctx.extra.misconception : undefined,
    });
  });
}

/** What the author can do right now, for diagnostics and the API. */
export function authorCapabilities() {
  const curated = listAnimations();
  return {
    primitives: PRIMITIVE_KINDS,
    channels: ANIMATABLE_CHANNELS,
    curatedConcepts: curated.map((c) => c.conceptSlug),
    curatedCount: curated.length,
    maxBeats: config.animation.maxBeats,
    maxRuntimeSeconds: config.animation.maxRuntimeSec,
    mode: config.animation.authorMode,
    schemaVersion: 1,
  };
}

export { auditScene };
export type { SanitizeResult };
export const _internals = { buildPrompt, EXEMPLAR };
