/** The shared vocabulary of LUMEN OS. Everything else speaks these types. */

export type Subject =
  | 'math' | 'physics' | 'chemistry' | 'biology' | 'earth_science'
  | 'english' | 'history' | 'geography' | 'computing' | 'general';

export type Bloom = 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create';

/** The representations a concept can be delivered in - the "multiverse" ladder. */
export type Modality =
  | 'text'            // chunked, simplified prose
  | 'audio'           // narrated with prosody control
  | 'diagram'         // static labelled visual
  | 'animation'       // procedural motion graphics
  | 'simulation'      // manipulable virtual lab
  | 'story'           // narrative analogy
  | 'analogy'         // real-world mapping
  | 'worked_example'  // step-by-step solution
  | 'socratic'        // question-led discovery
  | 'game'            // mastery quest
  | 'spatial'         // explorable 3D/map scene
  | 'manipulative';   // drag-and-drop concrete objects

export const ALL_MODALITIES: Modality[] = [
  'text', 'audio', 'diagram', 'animation', 'simulation', 'story',
  'analogy', 'worked_example', 'socratic', 'game', 'spatial', 'manipulative',
];

/** Accessibility needs drive the transformer; none of these are diagnoses. */
export type AccessNeed =
  | 'dyslexia' | 'adhd' | 'low_vision' | 'blind' | 'deaf' | 'hard_of_hearing'
  | 'dyscalculia' | 'language_learner' | 'processing_speed' | 'working_memory'
  | 'autism' | 'motor' | 'irlen';

export const ALL_NEEDS: AccessNeed[] = [
  'dyslexia', 'adhd', 'low_vision', 'blind', 'deaf', 'hard_of_hearing',
  'dyscalculia', 'language_learner', 'processing_speed', 'working_memory',
  'autism', 'motor', 'irlen',
];

export type EdgeKind =
  | 'requires'        // target cannot be learned before source
  | 'leads_to'        // natural successor
  | 'related'         // lateral link
  | 'generalizes'     // source is the abstract form of target
  | 'contrasts_with'  // commonly confused pair
  | 'applies_to';     // source is a tool used by target

export interface Concept {
  id: string;
  slug: string;
  label: string;
  description: string;
  subject: Subject;
  gradeMin: number;
  gradeMax: number;
  difficulty: number;   // 0..1 intrinsic conceptual load
  bloom: Bloom;
  tags: string[];
  standards: string[];
  documentId?: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface ConceptEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
  rationale?: string | null;
}

export interface Term {
  id: string;
  conceptId: string;
  term: string;
  definition: string;
  kidDefinition: string;
  syllables: string;
  importance: number;
}

export interface ConceptExample {
  id: string;
  conceptId: string;
  kind: 'worked' | 'analogy' | 'counterexample' | 'real_world' | 'visual' | 'story';
  title: string;
  body: Record<string, unknown>;
  quality: number;
}

export interface Misconception {
  id: string;
  conceptId?: string | null;
  code: string;
  label: string;
  description: string;
  subject: Subject;
  severity: 'minor' | 'moderate' | 'critical';
  detector: 'rule' | 'llm' | 'hybrid';
  signature: Record<string, unknown>;
  remediation: RemediationPlan;
}

export interface RemediationPlan {
  strategy: string;
  steps: string[];
  modality: Modality;
  contrastPair?: { wrong: string; right: string };
  prerequisiteCheck?: string[];
  practiceSpec?: { count: number; kind: string; focus: string };
}

export interface Learner {
  id: string;
  name: string;
  grade: number;
  locale: string;
  readingLevel: number;   // grade-equivalent reading level
  needs: AccessNeed[];
  ability: number;        // IRT theta
  abilitySe: number;
  profile: LearnerProfile;
  createdAt: string;
  updatedAt: string;
}

export interface LearnerProfile {
  preferredPaceWpm?: number;
  maxChunkWords?: number;
  fontPreference?: string;
  lineSpacing?: number;
  colorProfile?: string;
  ttsRate?: number;
  ttsVoice?: number;
  captionsRequired?: boolean;
  interests?: string[];
  attentionSpanMin?: number;
  notes?: string;
  [k: string]: unknown;
}

export interface MasteryRecord {
  learnerId: string;
  conceptId: string;
  pKnown: number;
  elo: number;
  attempts: number;
  correct: number;
  streak: number;
  stability: number;      // FSRS-style memory stability (days)
  fsrsDifficulty: number; // 1..10
  reps: number;
  lapses: number;
  lastSeen?: string | null;
  dueAt?: string | null;
  firstMasteredAt?: string | null;
}

export interface ModalityArm {
  learnerId: string;
  modality: Modality;
  alpha: number;
  beta: number;
  trials: number;
  rewardSum: number;
  lastAt?: string | null;
}

export interface ItemRecord {
  id: string;
  conceptId: string;
  kind: 'mcq' | 'numeric' | 'short_answer' | 'order' | 'match' | 'explain' | 'construct' | 'true_false';
  stem: string;
  choices: { key: string; text: string; misconceptionCode?: string }[];
  answer: { value: unknown; tolerance?: number; aliases?: string[] };
  rubric: Record<string, unknown>;
  difficulty: number;      // IRT b
  discrimination: number;  // IRT a
  guessing: number;        // IRT c
  misconceptionMap: Record<string, string>;
  bloom: Bloom;
  exposures: number;
  pCorrect?: number | null;
  accessibility: Record<string, unknown>;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface ResponseRecord {
  id: string;
  learnerId: string;
  itemId?: string | null;
  conceptId?: string | null;
  sessionId?: string | null;
  raw: string;
  correct: boolean;
  score: number;
  latencyMs: number;
  hintsUsed: number;
  attempts: number;
  misconceptionId?: string | null;
  modality?: Modality | null;
  feedback: Record<string, unknown>;
  at: string;
}

export interface LessonRecord {
  id: string;
  conceptId: string;
  learnerId?: string | null;
  modality: Modality;
  strategy: string;
  title: string;
  grade: number;
  body: LessonBody;
  accessibility: Record<string, unknown>;
  verification: Record<string, unknown>;
  provenance: Record<string, unknown>;
  version: number;
  createdAt: string;
}

export interface LessonBody {
  hook: string;
  objective: string;
  segments: LessonSegment[];
  keyTerms: { term: string; definition: string }[];
  checkpoints: { question: string; answer: string; hint?: string }[];
  summary: string;
  nextStep?: string;
  assets?: Record<string, unknown>;
}

export interface LessonSegment {
  id: string;
  kind: 'explain' | 'example' | 'visual' | 'practice' | 'reflect' | 'analogy' | 'warning' | 'recap';
  title: string;
  text: string;
  durationSec: number;
  visual?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  interaction?: Record<string, unknown>;
}

export interface SessionRecord {
  id: string;
  learnerId: string;
  goalConceptId?: string | null;
  status: 'active' | 'paused' | 'ended';
  plan: PlanStep[];
  state: Record<string, unknown>;
  metrics: Record<string, number>;
  step: number;
  startedAt: string;
  endedAt?: string | null;
  endReason?: string | null;
}

export interface PlanStep {
  conceptId: string;
  intent: 'diagnose' | 'teach' | 'practice' | 'repair' | 'review' | 'extend' | 'celebrate';
  modality: Modality;
  reason: string;
  estimatedSec: number;
  done?: boolean;
}

export interface CognitiveLoadEstimate {
  load: number;                 // 0..1
  contributors: Record<string, number>;
  recommendation: 'continue' | 'simplify' | 'switch_modality' | 'break' | 'repair_prereq';
  confidence: number;
}

export interface FrictionSignal {
  kind: 'retry_storm' | 'abandon' | 'explanation_churn' | 'long_pause' | 'error_streak' | 'hint_dependence' | 'speed_run';
  strength: number;
  evidence: string;
}
