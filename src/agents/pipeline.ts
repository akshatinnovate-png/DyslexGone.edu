import type { Agent, AgentRunResult } from './runtime.js';
import { AgentRuntime } from './runtime.js';
import type { AppContext } from '../api/context.js';
import type { AccessNeed, Concept, Modality } from '../domain/types.js';
import { transform } from '../accessibility/transformer.js';
import { resolveSpec } from '../accessibility/profiles.js';
import { buildAudioScript, toWebVtt } from '../accessibility/ssml.js';
import { labsForConcept } from '../engines/sim/lab.js';
import { verify, redactPii, checkInjection, type VerificationResult } from '../safety/verifier.js';
import { round } from '../core/mathx.js';

/** THE LESSON FORGE
 *
 *  Seven agents, each answering exactly one question, writing to a shared
 *  blackboard:
 *
 *    Curriculum    what must be taught, and what must come first?
 *    Learner       what does THIS student need right now?
 *    Accessibility how should it be presented?
 *    Language      what do the words have to become?
 *    Animation     how can it be shown?
 *    Assessment    how will we know it landed?
 *    QA / Safety   is this fit to put in front of a child?
 *
 *  The QA agent has veto. Nothing ships that it rejects. */

export interface ForgeRequest {
  conceptId?: string;
  conceptSlug?: string;
  learnerId?: string;
  grade?: number;
  needs?: AccessNeed[];
  modality?: Modality;
  includeVisual?: boolean;
}

export interface ForgedLesson {
  concept: { id: string; slug: string; label: string; subject: string };
  grade: number;
  modality: Modality;
  prerequisites: { id: string; label: string; mastery?: number }[];
  misconception?: { code: string; label: string; description: string };
  content: {
    hook: string;
    objective: string;
    text: string;
    elementary: string;
    bullets: string[];
    socratic: string[];
    summary: string;
    glossary: { term: string; plain: string; syllables: string }[];
  };
  presentation: Record<string, unknown>;
  audio: { ssml: string; totalMs: number; vtt: string };
  visual?: { sceneId: string; svg: string; durationSec: number; audioDescription: string; auditOk: boolean };
  check?: { itemId: string; stem: string; choices: { key: string; text: string }[] };
  labs: { id: string; label: string; question: string }[];
  verification: VerificationResult;
  safety: { piiRedacted: boolean; injectionSuspected: boolean };
}

export function buildForgeAgents(): Agent[] {
  /* ---------------------------- 1. CURRICULUM ---------------------------- */
  const curriculum: Agent = {
    name: 'curriculum',
    question: 'What must be taught, and what must come first?',
    requires: ['request'],
    provides: ['concept', 'prerequisites', 'terms', 'misconception'],
    run(ctx) {
      const req = ctx.get<ForgeRequest>('request')!;
      const concept = ctx.app.graph.resolve(req.conceptId ?? req.conceptSlug ?? '');
      ctx.put('concept', concept);

      const adj = ctx.app.graph.adjacency();
      const prereqs = adj.prerequisites(concept.id)
        .map((id) => ctx.app.repos.concepts.get(id))
        .filter(Boolean) as Concept[];
      ctx.put('prerequisites', prereqs);
      ctx.put('terms', ctx.app.repos.terms.forConcept(concept.id));

      const misc = ctx.app.repos.misconceptions.forConcept(concept.id)
        .sort((a, b) => (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0))[0];
      if (misc) ctx.put('misconception', misc);

      ctx.note(`${concept.label} (${concept.subject}), ${prereqs.length} prerequisite(s)`
        + `${misc ? `, attacks "${misc.code}"` : ', no documented misconception'}`);
    },
  };

  /* ------------------------------ 2. LEARNER ----------------------------- */
  const learner: Agent = {
    name: 'learner',
    question: 'What does this student need right now?',
    requires: ['request', 'concept'],
    provides: ['grade', 'needs', 'modality', 'learnerState'],
    run(ctx) {
      const req = ctx.get<ForgeRequest>('request')!;
      const concept = ctx.get<Concept>('concept')!;
      const l = req.learnerId ? ctx.app.repos.learners.get(req.learnerId) : undefined;

      const grade = req.grade ?? l?.grade ?? Math.round((concept.gradeMin + concept.gradeMax) / 2);
      const needs = req.needs ?? l?.needs ?? [];
      ctx.put('grade', grade);
      ctx.put('needs', needs);

      if (l) {
        const mastery = ctx.app.repos.mastery.get(l.id, concept.id);
        const trace = ctx.app.graph.traceGaps(l.id, concept.id);
        ctx.put('learnerState', {
          mastery: mastery?.pKnown ?? 0.15,
          gaps: trace.gapConcepts.map((g) => ({ label: g.concept.label, mastery: g.mastery })),
          activeMisconceptions: ctx.app.twin.activeMisconceptions(l.id).map((m) => m.code),
        });
        // The bandit owns modality: it is the only part of the system with
        // evidence about what has actually worked for this learner.
        const choice = ctx.app.twin.chooseModality(l.id, { seed: `forge:${concept.id}` });
        ctx.put('modality', req.modality ?? choice.chosen);
        ctx.note(`${l.name}: mastery ${round(mastery?.pKnown ?? 0.15, 2)}, `
          + `${trace.gapConcepts.length} upstream gap(s). Modality: ${choice.chosen} (${choice.strategy}).`);
      } else {
        ctx.put('modality', req.modality ?? 'worked_example');
        ctx.note(`No learner supplied; using grade ${grade} defaults.`);
      }
    },
  };

  /* --------------------------- 3. ACCESSIBILITY -------------------------- */
  const accessibility: Agent = {
    name: 'accessibility',
    question: 'How should this be presented?',
    requires: ['grade', 'needs'],
    provides: ['spec'],
    run(ctx) {
      const spec = resolveSpec(ctx.get<AccessNeed[]>('needs')!, ctx.get<number>('grade')!);
      ctx.put('spec', spec);
      ctx.note(`target grade ${spec.targetGrade}, ${spec.maxChunkWords}-word chunks, ${spec.colorProfile} palette`
        + `${spec.reduceMotion ? ', reduced motion' : ''}${spec.requireCaptions ? ', captions required' : ''}`);
    },
  };

  /* ----------------------------- 4. LANGUAGE ----------------------------- */
  const language: Agent = {
    name: 'language',
    question: 'What do the words have to become?',
    requires: ['concept', 'spec', 'terms'],
    provides: ['content', 'presentation', 'audio'],
    run(ctx) {
      const concept = ctx.get<Concept>('concept')!;
      const spec = ctx.get<ReturnType<typeof resolveSpec>>('spec')!;
      const terms = ctx.get<{ term: string; definition: string }[]>('terms') ?? [];
      const misc = ctx.get<{ label: string; remediation: { contrastPair?: { wrong: string; right: string } } }>('misconception');

      const source = [concept.description, ...terms.map((t) => `${t.term} is ${t.definition}.`)]
        .filter(Boolean).join(' ') || concept.label;

      // Untrusted source material cannot smuggle instructions through.
      const injection = checkInjection(source);
      const clean = injection.sanitized;

      const t = transform({
        text: clean,
        title: concept.label,
        grade: spec.targetGrade,
        needs: spec.needs,
        keepTerms: terms.map((x) => x.term),
      });

      const hook = misc
        ? `Before we start: is this true? "${misc.remediation.contrastPair?.wrong ?? misc.label}"`
        : `Where have you already seen ${concept.label.toLowerCase()} without knowing its name?`;

      ctx.put('content', {
        hook,
        objective: `Explain ${concept.label.toLowerCase()} in your own words, and use it once.`,
        text: t.variants.plain,
        elementary: t.variants.elementary,
        bullets: t.variants.bullets,
        socratic: t.variants.socratic.slice(0, 4),
        summary: t.variants.oneLine,
        glossary: t.glossary.slice(0, 6).map((g) => ({ term: g.term, plain: g.plain, syllables: g.syllables })),
      });
      ctx.put('presentation', {
        typography: t.render.typography,
        colour: t.render.color,
        chunks: t.render.chunks.length,
        supports: t.render.supports,
        pacing: t.render.pacing,
        readability: { before: t.gains.gradeBefore, after: t.gains.gradeAfter },
      });

      const audio = buildAudioScript(t.variants.plain, {
        grade: spec.targetGrade, rate: spec.ttsRate,
        emphasizeTerms: terms.map((x) => x.term),
        spellOutHardWords: spec.needs.includes('dyslexia'),
      });
      ctx.put('audio', { ssml: audio.ssml, totalMs: audio.totalMs, vtt: toWebVtt(audio) });
      ctx.put('injectionSuspected', injection.suspicious);

      ctx.note(`grade ${t.gains.gradeBefore} → ${t.gains.gradeAfter}, ${t.glossary.length} glossary terms, `
        + `${Math.round(audio.totalMs / 1000)}s narration`
        + `${injection.suspicious ? '. INSTRUCTION-LIKE TEXT FOUND IN SOURCE AND NEUTRALISED.' : ''}`);
    },
  };

  /* ----------------------------- 5. ANIMATION ---------------------------- */
  const animation: Agent = {
    name: 'animation',
    question: 'How can this be shown?',
    requires: ['concept', 'grade'],
    provides: ['visual'],
    when: (ctx) => ctx.get<ForgeRequest>('request')?.includeVisual !== false,
    async run(ctx) {
      const concept = ctx.get<Concept>('concept')!;
      const misc = ctx.get<{ label: string; description: string }>('misconception');
      try {
        const asset = await ctx.app.visual.build({
          conceptId: concept.id,
          grade: ctx.get<number>('grade'),
          needs: ctx.get<AccessNeed[]>('needs'),
          misconception: misc ? `${misc.label}: ${misc.description}` : undefined,
        });
        ctx.put('visual', {
          sceneId: asset.sceneId, svg: asset.svg, durationSec: asset.durationSec,
          audioDescription: asset.audioDescription, auditOk: asset.audit.ok,
        });
        ctx.note(`${Math.round(asset.durationSec)}s via "${asset.source}", audit ${asset.audit.ok ? 'passed' : 'FAILED'}`);
      } catch (e) {
        // A missing visual is a degraded lesson, not a failed one.
        ctx.note(`no visual produced: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  /* ---------------------------- 6. ASSESSMENT ---------------------------- */
  const assessment: Agent = {
    name: 'assessment',
    question: 'How will we know it landed?',
    requires: ['concept'],
    provides: ['check', 'labs'],
    run(ctx) {
      const concept = ctx.get<Concept>('concept')!;
      const req = ctx.get<ForgeRequest>('request')!;
      const items = ctx.app.assessment.ensureItems(concept.id, 3);

      const pick = req.learnerId
        ? ctx.app.assessment.nextItem(req.learnerId, concept.id)
        : null;
      const item = pick?.item ?? items[0];

      if (item) {
        ctx.put('check', {
          itemId: item.id,
          stem: item.stem,
          choices: item.choices.map((c) => ({ key: c.key, text: c.text })),
        });
        ctx.note(`${items.length} items available; chose "${item.stem.slice(0, 50)}"`
          + `${Object.keys(item.misconceptionMap).length ? ' (diagnostic)' : ''}`);
      } else {
        ctx.note('no item could be produced for this concept');
      }

      ctx.put('labs', labsForConcept(concept.slug).map((l) => ({
        id: l.id, label: l.label, question: l.question,
      })));
    },
  };

  /* ---------------------------- 7. QA / SAFETY --------------------------- */
  const qa: Agent = {
    name: 'qa_safety',
    question: 'Is this fit to put in front of a child?',
    requires: ['content', 'concept', 'grade'],
    provides: ['verification', 'safety'],
    run(ctx) {
      const content = ctx.get<ForgedLesson['content']>('content')!;
      const concept = ctx.get<Concept>('concept')!;
      const terms = ctx.get<{ term: string }[]>('terms') ?? [];
      const misc = ctx.get<{ label: string }>('misconception');

      const whole = [content.hook, content.text, content.summary].join('\n\n');
      const pii = redactPii(whole);

      const result = verify({
        text: whole,
        concept,
        grade: ctx.get<number>('grade')!,
        keyTerms: terms.map((t) => t.term).slice(0, 5),
        misconception: misc?.label,
        kind: 'lesson',
      });

      ctx.put('verification', result);
      ctx.put('safety', {
        piiRedacted: pii.redacted,
        injectionSuspected: Boolean(ctx.get<boolean>('injectionSuspected')),
      });

      ctx.note(`${result.verdict} (score ${result.score}) after ${result.checked.length} checks`
        + `${result.findings.length ? `: ${result.findings.map((f) => `[${f.severity}] ${f.check}`).join(', ')}` : ''}`);

      // Veto. A rejected lesson does not ship, whatever the other agents produced.
      if (result.verdict === 'rejected') {
        throw new Error(`QA rejected this lesson: ${result.summary}`);
      }
    },
  };

  return [curriculum, learner, accessibility, language, animation, assessment, qa];
}

/** Run the forge and assemble the result. */
export async function forgeLesson(app: AppContext, req: ForgeRequest): Promise<AgentRunResult<ForgedLesson>> {
  const runtime = new AgentRuntime(app);
  const result = await runtime.run<Record<string, unknown>>('lesson_forge', buildForgeAgents(), {
    request: req,
    __spendAtStart: app.router.stats().spendUsd,
  });

  const board = result.board;
  const concept = board.concept as Concept | undefined;
  const misc = board.misconception as { code: string; label: string; description: string } | undefined;

  const output: ForgedLesson = {
    concept: concept
      ? { id: concept.id, slug: concept.slug, label: concept.label, subject: concept.subject }
      : { id: '', slug: '', label: 'unknown', subject: 'general' },
    grade: (board.grade as number) ?? 6,
    modality: (board.modality as Modality) ?? 'text',
    prerequisites: ((board.prerequisites as Concept[]) ?? []).map((p) => ({ id: p.id, label: p.label })),
    misconception: misc ? { code: misc.code, label: misc.label, description: misc.description } : undefined,
    content: board.content as ForgedLesson['content'],
    presentation: (board.presentation as Record<string, unknown>) ?? {},
    audio: (board.audio as ForgedLesson['audio']) ?? { ssml: '', totalMs: 0, vtt: '' },
    visual: board.visual as ForgedLesson['visual'],
    check: board.check as ForgedLesson['check'],
    labs: (board.labs as ForgedLesson['labs']) ?? [],
    verification: (board.verification as VerificationResult) ?? {
      verdict: 'rejected', score: 0, findings: [], checked: [],
      summary: 'Verification never ran, so this lesson is not approved.',
    },
    safety: (board.safety as ForgedLesson['safety']) ?? { piiRedacted: false, injectionSuspected: false },
  };

  return { ...result, output };
}
