import type { Repos } from '../db/repos.js';
import type { AccessNeed, Concept } from '../domain/types.js';
import type { ModelRouter } from '../llm/router.js';
import { SceneAuthor, type AuthorRequest, type AuthorResult } from './animation/author.js';
import { narrationScript, segmentScene, type SceneSegment } from './animation/compiler.js';
import { renderSvg } from './animation/svg.js';
import type { Scene } from './animation/primitives.js';
import { buildAudioScript, toWebVtt, type AudioScript } from '../accessibility/ssml.js';
import { resolveSpec } from '../accessibility/profiles.js';
import { labsForConcept } from './sim/lab.js';
import { round } from '../core/mathx.js';
import { metrics, timedAsync } from '../core/metrics.js';
import { bus } from '../core/events.js';

/** THE VISUAL ENGINE
 *
 *  One call in: which concept, for which learner. Out: an animation, a still
 *  diagram, the narration, the captions, the spoken description, and whatever
 *  interactive lab backs the same idea - all consistent with each other because
 *  they are generated from one scene. */

export interface VisualRequest {
  conceptId?: string;
  conceptSlug?: string;
  /** Free-form topic, for content that is not in the graph yet. */
  topic?: string;
  description?: string;
  learnerId?: string;
  grade?: number;
  needs?: AccessNeed[];
  misconception?: string;
  mode?: AuthorRequest['mode'];
  /** Render a still frame at this time instead of an animation. */
  frozenAt?: number;
  seed?: string;
}

export interface VisualAsset {
  sceneId: string;
  title: string;
  /** Self-contained animated SVG. */
  svg: string;
  /** Single-frame SVG, for print, previews and reduced motion. */
  stillSvg: string;
  scene: Scene;
  narration: string;
  audio: { ssml: string; totalMs: number; wordCount: number };
  captionsVtt: string;
  audioDescription: string;
  durationSec: number;
  /** Attention-sized chapters. One entry means it fits in a single sitting. */
  segments: SceneSegment[];
  bytes: number;
  source: AuthorResult['source'];
  audit: AuthorResult['audit'];
  repairs: string[];
  rejected: string[];
  notes: string[];
  reduceMotion: boolean;
  /** Interactive labs that teach the same concept, if any. */
  relatedLabs: { id: string; label: string; question: string }[];
  provider?: string;
  model?: string;
  costUsd?: number;
}

export class VisualEngine {
  private author: SceneAuthor;

  constructor(private repos: Repos, router: ModelRouter) {
    this.author = new SceneAuthor(router);
  }

  async build(req: VisualRequest): Promise<VisualAsset> {
    return timedAsync('lumen_visual_build_ms', { mode: req.mode ?? 'auto' }, async () => {
      const concept = this.resolveConcept(req);
      const learner = req.learnerId ? this.repos.learners.get(req.learnerId) : undefined;
      const grade = req.grade ?? learner?.grade ?? concept?.gradeMin ?? 6;
      const needs = req.needs ?? learner?.needs ?? [];
      const spec = resolveSpec(needs, grade);

      const topic = req.topic ?? concept?.label ?? 'this idea';
      const description = req.description ?? concept?.description;
      const keyTerms = concept ? this.repos.terms.forConcept(concept.id).map((t) => t.term) : undefined;
      const misconception = req.misconception ?? this.firstMisconception(concept);

      const authored = await this.author.author({
        topic,
        description,
        conceptSlug: concept?.slug ?? req.conceptSlug,
        subject: concept?.subject,
        grade: spec.targetGrade,
        misconception,
        keyTerms,
        // A learner who needs processing time gets a slower scene, not a
        // faster one they are expected to keep up with.
        paceMultiplier: round(1 + spec.severity * 0.55, 2),
        reduceMotion: spec.reduceMotion,
        mode: req.mode,
        seed: req.seed,
      });

      const scene = authored.scene;
      // If the explanation outruns this learner's attention block, chapter it.
      // Speeding it up would punish exactly the learners who need it slowest.
      const segments = segmentScene(scene, spec.segmentSeconds);

      const narration = narrationScript(scene);
      const audio: AudioScript = buildAudioScript(narration, {
        grade: spec.targetGrade,
        rate: spec.ttsRate,
        emphasizeTerms: keyTerms,
        mathReadAloud: true,
      });

      const svg = renderSvg(scene, {
        showCaptions: spec.requireCaptions || needs.includes('deaf') || needs.includes('hard_of_hearing'),
        reduceMotion: spec.reduceMotion,
        background: spec.colorProfile === 'dark' ? '#1B1B1F' : undefined,
      });
      const stillSvg = renderSvg(scene, {
        reduceMotion: true,
        frozenAt: req.frozenAt ?? scene.durationSec,
      });

      metrics.counter('lumen_visuals_built_total').inc({ source: authored.source });
      if (concept) {
        bus.emit('lesson.generated', {
          lessonId: scene.id, conceptId: concept.id, modality: 'animation', learnerId: req.learnerId,
        });
      }

      return {
        sceneId: scene.id,
        title: scene.title,
        svg,
        stillSvg,
        scene,
        narration,
        audio: { ssml: audio.ssml, totalMs: audio.totalMs, wordCount: audio.timings.length },
        captionsVtt: toWebVtt(audio),
        audioDescription: scene.audioDescription,
        durationSec: scene.durationSec,
        segments,
        bytes: svg.length,
        source: authored.source,
        audit: authored.audit,
        repairs: authored.repairs,
        rejected: authored.rejected,
        notes: authored.notes,
        reduceMotion: spec.reduceMotion,
        relatedLabs: (concept ? labsForConcept(concept.slug) : []).map((l) => ({
          id: l.id, label: l.label, question: l.question,
        })),
        provider: authored.provider,
        model: authored.model,
        costUsd: authored.costUsd,
      };
    });
  }

  private resolveConcept(req: VisualRequest): Concept | undefined {
    if (req.conceptId) return this.repos.concepts.get(req.conceptId);
    if (req.conceptSlug) return this.repos.concepts.bySlug(req.conceptSlug);
    return undefined;
  }

  private firstMisconception(concept?: Concept): string | undefined {
    if (!concept) return undefined;
    const m = this.repos.misconceptions.forConcept(concept.id)
      .sort((a, b) => (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0))[0];
    return m ? `${m.label}: ${m.description}` : undefined;
  }
}
