import type { AccessNeed, Modality } from '../domain/types.js';
import { clamp, round } from '../core/mathx.js';

/** How each access need bends the presentation. Additive, then normalised -
 *  a learner with several needs gets the union of supports, not a conflict. */
export interface NeedPolicy {
  need: AccessNeed;
  label: string;
  gradeOffset: number;            // shift target reading grade
  severity: number;               // 0..1 how much formatting support
  maxChunkWords: number;
  colorProfile?: string;
  ttsRate: number;
  requireAudio: boolean;
  requireCaptions: boolean;
  requireAltText: boolean;
  reduceMotion: boolean;
  modalityBoost: Partial<Record<Modality, number>>;
  modalityBlock: Modality[];
  segmentSeconds: number;         // max continuous attention block
  notes: string[];
}

export const NEED_POLICIES: Record<AccessNeed, NeedPolicy> = {
  dyslexia: {
    need: 'dyslexia', label: 'Dyslexia',
    gradeOffset: -2, severity: 0.8, maxChunkWords: 7, colorProfile: 'cream', ttsRate: 0.85,
    requireAudio: true, requireCaptions: false, requireAltText: false, reduceMotion: false,
    modalityBoost: { audio: 0.35, animation: 0.3, diagram: 0.25, worked_example: 0.2, manipulative: 0.2 },
    modalityBlock: [],
    segmentSeconds: 90,
    notes: [
      'Pair every text block with synchronised audio.',
      'Never justify text; keep lines under ~60 characters.',
      'Mark syllable boundaries on words of 3+ syllables.',
    ],
  },
  adhd: {
    need: 'adhd', label: 'Attention regulation',
    gradeOffset: -1, severity: 0.5, maxChunkWords: 9, colorProfile: 'sky', ttsRate: 1.0,
    requireAudio: false, requireCaptions: false, requireAltText: false, reduceMotion: false,
    modalityBoost: { game: 0.4, simulation: 0.35, animation: 0.3, manipulative: 0.25 },
    modalityBlock: [],
    segmentSeconds: 55,
    notes: [
      'Short segments with an explicit finish line.',
      'One idea per screen; no parallel scroll regions.',
      'Make progress visible after every interaction.',
    ],
  },
  low_vision: {
    need: 'low_vision', label: 'Low vision',
    gradeOffset: 0, severity: 0.9, maxChunkWords: 8, colorProfile: 'high_contrast', ttsRate: 0.95,
    requireAudio: true, requireCaptions: false, requireAltText: true, reduceMotion: false,
    modalityBoost: { audio: 0.5, text: 0.2, worked_example: 0.15 },
    modalityBlock: ['spatial'],
    segmentSeconds: 120,
    notes: ['Minimum 24px type and 7:1 contrast.', 'Every figure needs a spoken description.'],
  },
  blind: {
    need: 'blind', label: 'Blind',
    gradeOffset: 0, severity: 1, maxChunkWords: 12, colorProfile: 'high_contrast', ttsRate: 1.1,
    requireAudio: true, requireCaptions: false, requireAltText: true, reduceMotion: true,
    modalityBoost: { audio: 0.8, story: 0.3, socratic: 0.25, worked_example: 0.2 },
    modalityBlock: ['diagram', 'animation', 'spatial', 'manipulative'],
    segmentSeconds: 150,
    notes: [
      'Visual-only modalities are replaced by structured audio descriptions.',
      'Spatial relationships must be expressed verbally and sequentially.',
    ],
  },
  deaf: {
    need: 'deaf', label: 'Deaf',
    gradeOffset: -1, severity: 0.4, maxChunkWords: 10, ttsRate: 1, colorProfile: undefined,
    requireAudio: false, requireCaptions: true, requireAltText: false, reduceMotion: false,
    modalityBoost: { diagram: 0.4, animation: 0.4, text: 0.3, simulation: 0.3 },
    modalityBlock: ['audio'],
    segmentSeconds: 110,
    notes: ['Caption everything; never carry meaning in sound alone.'],
  },
  hard_of_hearing: {
    need: 'hard_of_hearing', label: 'Hard of hearing',
    gradeOffset: 0, severity: 0.3, maxChunkWords: 10, ttsRate: 0.9, colorProfile: undefined,
    requireAudio: false, requireCaptions: true, requireAltText: false, reduceMotion: false,
    modalityBoost: { diagram: 0.25, animation: 0.2, text: 0.2 },
    modalityBlock: [],
    segmentSeconds: 110,
    notes: ['Captions on by default; boost speech clarity over background audio.'],
  },
  dyscalculia: {
    need: 'dyscalculia', label: 'Dyscalculia',
    gradeOffset: -2, severity: 0.6, maxChunkWords: 8, colorProfile: 'mint', ttsRate: 0.85,
    requireAudio: true, requireCaptions: false, requireAltText: false, reduceMotion: false,
    modalityBoost: { manipulative: 0.5, diagram: 0.4, simulation: 0.3, worked_example: 0.35 },
    modalityBlock: [],
    segmentSeconds: 80,
    notes: [
      'Always anchor number work to a concrete model (bars, arrays, number lines).',
      'Never show more than one new symbol at a time.',
    ],
  },
  language_learner: {
    need: 'language_learner', label: 'Language learner',
    gradeOffset: -3, severity: 0.5, maxChunkWords: 8, colorProfile: 'cream', ttsRate: 0.8,
    requireAudio: true, requireCaptions: true, requireAltText: true, reduceMotion: false,
    modalityBoost: { diagram: 0.4, animation: 0.35, story: 0.25, analogy: 0.3 },
    modalityBlock: [],
    segmentSeconds: 100,
    notes: ['Keep subject vocabulary, simplify everything around it.', 'Pre-teach 3-5 key words before the explanation.'],
  },
  processing_speed: {
    need: 'processing_speed', label: 'Processing speed',
    gradeOffset: -1, severity: 0.6, maxChunkWords: 7, colorProfile: 'cream', ttsRate: 0.75,
    requireAudio: true, requireCaptions: false, requireAltText: false, reduceMotion: true,
    modalityBoost: { worked_example: 0.35, audio: 0.25, text: 0.1 },
    modalityBlock: ['game'],
    segmentSeconds: 70,
    notes: ['No timers. Learner controls pace, including replay.'],
  },
  working_memory: {
    need: 'working_memory', label: 'Working memory',
    gradeOffset: -1, severity: 0.65, maxChunkWords: 6, colorProfile: 'cream', ttsRate: 0.85,
    requireAudio: true, requireCaptions: false, requireAltText: false, reduceMotion: false,
    modalityBoost: { worked_example: 0.45, manipulative: 0.3, diagram: 0.25 },
    modalityBlock: [],
    segmentSeconds: 60,
    notes: [
      'Keep every piece needed for the current step visible - no recall from memory.',
      'Use faded worked examples rather than open problems.',
    ],
  },
  autism: {
    need: 'autism', label: 'Autistic learner',
    gradeOffset: 0, severity: 0.4, maxChunkWords: 10, colorProfile: 'grey', ttsRate: 0.95,
    requireAudio: false, requireCaptions: true, requireAltText: false, reduceMotion: true,
    modalityBoost: { text: 0.3, diagram: 0.3, simulation: 0.25, worked_example: 0.3 },
    modalityBlock: [],
    segmentSeconds: 120,
    notes: [
      'Literal language. Flag idioms and figures of speech explicitly.',
      'State the structure up front and keep it stable.',
      'Low-stimulation palette, no surprise motion or sound.',
    ],
  },
  motor: {
    need: 'motor', label: 'Motor access',
    gradeOffset: 0, severity: 0.3, maxChunkWords: 10, ttsRate: 1, colorProfile: undefined,
    requireAudio: false, requireCaptions: false, requireAltText: false, reduceMotion: false,
    modalityBoost: { audio: 0.2, text: 0.2, socratic: 0.2 },
    modalityBlock: ['manipulative'],
    segmentSeconds: 120,
    notes: ['Large targets, no drag-and-drop, full keyboard and voice paths.'],
  },
  irlen: {
    need: 'irlen', label: 'Visual stress',
    gradeOffset: 0, severity: 0.7, maxChunkWords: 8, colorProfile: 'peach', ttsRate: 0.9,
    requireAudio: true, requireCaptions: false, requireAltText: false, reduceMotion: true,
    modalityBoost: { audio: 0.35 },
    modalityBlock: [],
    segmentSeconds: 90,
    notes: ['Tinted background, never pure white. Avoid high-frequency patterns and striping.'],
  },
};

export interface AccessibilitySpec {
  needs: AccessNeed[];
  targetGrade: number;
  severity: number;
  maxChunkWords: number;
  colorProfile: string;
  ttsRate: number;
  requireAudio: boolean;
  requireCaptions: boolean;
  requireAltText: boolean;
  reduceMotion: boolean;
  segmentSeconds: number;
  modalityWeights: Partial<Record<Modality, number>>;
  blockedModalities: Modality[];
  guidance: string[];
}

/** Compose one presentation spec from a learner's needs and grade. */
export function resolveSpec(needs: AccessNeed[], grade: number, overrides: Partial<AccessibilitySpec> = {}): AccessibilitySpec {
  const policies = needs.map((n) => NEED_POLICIES[n]).filter(Boolean);
  const boost: Partial<Record<Modality, number>> = {};
  const blocked = new Set<Modality>();
  const guidance: string[] = [];

  for (const p of policies) {
    for (const [m, v] of Object.entries(p.modalityBoost)) {
      boost[m as Modality] = (boost[m as Modality] ?? 0) + (v ?? 0);
    }
    for (const m of p.modalityBlock) blocked.add(m);
    guidance.push(...p.notes);
  }
  // A blocked modality can never be boosted into play.
  for (const m of blocked) delete boost[m];

  const spec: AccessibilitySpec = {
    needs,
    targetGrade: clamp(grade + (policies.length ? Math.min(...policies.map((p) => p.gradeOffset)) : 0), 1, 13),
    severity: round(policies.length ? Math.max(...policies.map((p) => p.severity)) : 0.25, 2),
    maxChunkWords: policies.length ? Math.min(...policies.map((p) => p.maxChunkWords)) : 12,
    colorProfile: policies.find((p) => p.colorProfile)?.colorProfile ?? 'cream',
    ttsRate: round(policies.length ? Math.min(...policies.map((p) => p.ttsRate)) : 1, 2),
    requireAudio: policies.some((p) => p.requireAudio),
    requireCaptions: policies.some((p) => p.requireCaptions),
    requireAltText: policies.some((p) => p.requireAltText),
    reduceMotion: policies.some((p) => p.reduceMotion),
    segmentSeconds: policies.length ? Math.min(...policies.map((p) => p.segmentSeconds)) : 150,
    modalityWeights: boost,
    blockedModalities: [...blocked],
    guidance: [...new Set(guidance)],
  };
  return { ...spec, ...overrides };
}

/** Conflicts worth surfacing to a teacher (e.g. blind + diagram-heavy chapter). */
export function specConflicts(spec: AccessibilitySpec): string[] {
  const out: string[] = [];
  if (spec.needs.includes('blind') && spec.needs.includes('deaf')) {
    out.push('Blind + deaf: route content to braille-ready structured text and tactile descriptions.');
  }
  if (spec.blockedModalities.includes('audio') && spec.requireAudio) {
    out.push('Audio is both required and blocked: captions become the primary channel.');
  }
  if (spec.needs.includes('adhd') && spec.needs.includes('processing_speed')) {
    out.push('Short segments but no time pressure: keep segments tiny and learner-paced.');
  }
  return out;
}
