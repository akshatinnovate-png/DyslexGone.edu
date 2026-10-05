import type { Repos } from '../db/repos.js';
import type { AccessNeed, Concept, Modality } from '../domain/types.js';
import type { GraphService } from '../graph/service.js';
import type { AssessmentService } from '../assessment/service.js';
import type { MisconceptionEngine } from '../misconception/engine.js';
import type { VisualEngine } from '../engines/visual.engine.js';
import { transform } from '../accessibility/transformer.js';
import { resolveSpec } from '../accessibility/profiles.js';
import { labsForConcept } from '../engines/sim/lab.js';
import { id as newId } from '../core/ids.js';
import { round } from '../core/mathx.js';
import { truncate } from '../core/textkit.js';

/** THE TEACHER COPILOT
 *
 *  A teacher uploads "Chapter 7" and gets back everything they would otherwise
 *  spend a Sunday evening building: the accessible lesson, the differentiated
 *  versions, the quiz with an answer key, the worksheet, the misconceptions to
 *  watch for, and the activity. Each piece is generated from the SAME concept
 *  model, so the quiz actually tests the lesson that was taught. */

export interface LessonPackRequest {
  conceptId?: string;
  conceptSlug?: string;
  grade?: number;
  /** Build differentiated versions for these profiles. */
  differentiateFor?: AccessNeed[][];
  includeVisual?: boolean;
  questionCount?: number;
  classroomId?: string;
}

export interface LessonPack {
  id: string;
  concept: { id: string; slug: string; label: string; subject: string; description: string };
  grade: number;
  objective: string;
  successCriteria: string[];
  priorKnowledge: { conceptId: string; label: string; whyItMatters: string }[];
  lesson: {
    hook: string;
    explanation: string;
    elementary: string;
    workedExample: string;
    keyTerms: { term: string; definition: string; syllables: string }[];
    checkpoints: { question: string; answer: string; lookFor: string }[];
    summary: string;
    estimatedMinutes: number;
  };
  differentiation: {
    needs: AccessNeed[];
    label: string;
    targetGrade: number;
    text: string;
    presentation: Record<string, unknown>;
    teacherNotes: string[];
  }[];
  quiz: {
    questions: { n: number; stem: string; choices?: { key: string; text: string }[]; kind: string; itemId: string }[];
    answerKey: { n: number; answer: string; explanation: string; ifTheyChose?: Record<string, string> }[];
  };
  worksheet: { title: string; instructions: string; tasks: string[]; extension: string };
  misconceptions: {
    code: string; label: string; description: string; severity: string;
    howItShowsUp: string; whatToSay: string; strategy: string;
  }[];
  activity: { title: string; grouping: string; steps: string[]; materials: string[]; minutes: number };
  remediation: { conceptId: string; label: string; why: string }[];
  extension: { conceptId: string; label: string; why: string }[];
  visual?: { sceneId: string; title: string; svg: string; durationSec: number; audioDescription: string };
  labs: { id: string; label: string; question: string; learningGoal: string }[];
  createdAt: string;
}

export class TeacherCopilot {
  constructor(
    private repos: Repos,
    private graph: GraphService,
    private assessment: AssessmentService,
    private misconceptions: MisconceptionEngine,
    private visual: VisualEngine,
  ) {}

  async lessonPack(req: LessonPackRequest): Promise<LessonPack> {
    const concept = this.graph.resolve(req.conceptId ?? req.conceptSlug ?? '');
    const grade = req.grade ?? Math.round((concept.gradeMin + concept.gradeMax) / 2);
    const terms = this.repos.terms.forConcept(concept.id);
    const adj = this.graph.adjacency();

    const sourceText = [concept.description, ...terms.map((t) => `${t.term} is ${t.definition}.`)]
      .filter(Boolean).join(' ');

    const base = transform({
      text: sourceText || concept.label,
      title: concept.label,
      grade,
      needs: [],
      keepTerms: terms.map((t) => t.term),
    });

    /* ---------------------------- differentiation --------------------------- */
    const profiles = req.differentiateFor ?? [['dyslexia'], ['language_learner'], ['working_memory']];
    const differentiation = profiles.map((needs) => {
      const spec = resolveSpec(needs, grade);
      const t = transform({
        text: sourceText || concept.label,
        title: concept.label,
        grade,
        needs,
        keepTerms: terms.map((x) => x.term),
      });
      return {
        needs,
        label: needs.map((n) => n.replace(/_/g, ' ')).join(' + '),
        targetGrade: spec.targetGrade,
        text: t.variants.plain,
        presentation: {
          typography: t.render.typography,
          colour: t.render.color,
          maxChunkWords: spec.maxChunkWords,
          segmentSeconds: spec.segmentSeconds,
          requireAudio: spec.requireAudio,
          requireCaptions: spec.requireCaptions,
          preferredModalities: t.recommendedModalities.slice(0, 3).map((m) => m.modality),
        },
        teacherNotes: spec.guidance.slice(0, 4),
      };
    });

    /* -------------------------------- quiz --------------------------------- */
    const items = this.assessment.ensureItems(concept.id, req.questionCount ?? 5)
      .slice(0, req.questionCount ?? 5);
    const quiz = {
      questions: items.map((it, i) => ({
        n: i + 1,
        stem: it.stem,
        choices: it.choices.length ? it.choices.map((c) => ({ key: c.key, text: c.text })) : undefined,
        kind: it.kind,
        itemId: it.id,
      })),
      answerKey: items.map((it, i) => ({
        n: i + 1,
        answer: String(it.answer.value),
        explanation: String((it.meta as Record<string, unknown>).explanation ?? 'See the lesson explanation.'),
        ifTheyChose: Object.keys(it.misconceptionMap).length
          ? Object.fromEntries(Object.entries(it.misconceptionMap).map(([key, code]) => {
              const m = this.repos.misconceptions.byCode(code);
              return [key, m ? `${m.label} — ${m.remediation.steps[0] ?? m.description}` : code];
            }))
          : undefined,
      })),
    };

    /* ---------------------------- misconceptions ---------------------------- */
    const miscList = this.repos.misconceptions.forConcept(concept.id);
    const misconceptions = miscList.map((m) => ({
      code: m.code,
      label: m.label,
      description: m.description,
      severity: m.severity,
      howItShowsUp: m.remediation.contrastPair
        ? `You will see answers like "${m.remediation.contrastPair.wrong}" instead of "${m.remediation.contrastPair.right}".`
        : m.description,
      whatToSay: m.remediation.steps[0] ?? 'Rebuild the idea from a concrete model.',
      strategy: m.remediation.strategy,
    }));

    /* ------------------------------ prior knowledge ------------------------- */
    const priorKnowledge = adj.prerequisites(concept.id)
      .map((pid) => this.repos.concepts.get(pid))
      .filter(Boolean)
      .map((c) => ({
        conceptId: c!.id,
        label: c!.label,
        whyItMatters: `${concept.label} is built directly on ${c!.label}. If this is shaky, the lesson will not land.`,
      }));

    /* --------------------------------- visual ------------------------------- */
    let visual: LessonPack['visual'];
    if (req.includeVisual !== false) {
      try {
        const asset = await this.visual.build({ conceptId: concept.id, grade });
        visual = {
          sceneId: asset.sceneId, title: asset.title, svg: asset.svg,
          durationSec: asset.durationSec, audioDescription: asset.audioDescription,
        };
      } catch { /* a missing visual must not cost the teacher the whole pack */ }
    }

    const workedExample = this.buildWorkedExample(concept, items);

    return {
      id: newId('pack'),
      concept: {
        id: concept.id, slug: concept.slug, label: concept.label,
        subject: concept.subject, description: concept.description,
      },
      grade,
      objective: `Students will be able to explain ${concept.label.toLowerCase()} and use it to solve a problem.`,
      successCriteria: [
        `I can say what ${concept.label.toLowerCase()} means in my own words.`,
        `I can work through an example without help.`,
        miscList.length
          ? `I can explain why "${miscList[0].label.toLowerCase()}" is wrong.`
          : `I can spot when this idea applies.`,
      ],
      priorKnowledge,
      lesson: {
        hook: this.buildHook(concept, miscList[0]?.label),
        explanation: base.variants.plain,
        elementary: base.variants.elementary,
        workedExample,
        keyTerms: base.glossary.slice(0, 6).map((g) => ({
          term: g.term, definition: g.plain, syllables: g.syllables,
        })),
        checkpoints: items.slice(0, 3).map((it) => ({
          question: it.stem,
          answer: String(it.answer.value),
          lookFor: Object.keys(it.misconceptionMap).length
            ? `Watch for the distractor: it indicates ${Object.values(it.misconceptionMap)[0]}.`
            : 'Watch whether they can explain their reasoning, not just the answer.',
        })),
        summary: base.variants.oneLine,
        estimatedMinutes: Math.max(10, Math.round(base.estimatedMinutes + items.length * 1.5 + 8)),
      },
      differentiation,
      quiz,
      worksheet: {
        title: `${concept.label} — practice`,
        instructions: `Work through these on your own. If you get stuck, say which part is confusing rather than guessing.`,
        tasks: items.map((it, i) => `${i + 1}. ${it.stem}`),
        extension: miscList[0]?.remediation.contrastPair
          ? `Challenge: explain to a partner why "${miscList[0].remediation.contrastPair.wrong}" is wrong.`
          : `Challenge: write your own question about ${concept.label.toLowerCase()} and swap with a partner.`,
      },
      misconceptions,
      activity: this.buildActivity(concept, miscList[0]?.label),
      remediation: priorKnowledge.map((p) => ({
        conceptId: p.conceptId, label: p.label, why: 'Prerequisite — reteach this first if the class struggles.',
      })),
      extension: adj.unlocks(concept.id)
        .map((idv) => this.repos.concepts.get(idv))
        .filter(Boolean)
        .slice(0, 4)
        .map((c) => ({ conceptId: c!.id, label: c!.label, why: `Natural next step once ${concept.label} is secure.` })),
      visual,
      labs: labsForConcept(concept.slug).map((l) => ({
        id: l.id, label: l.label, question: l.question, learningGoal: l.learningGoal,
      })),
      createdAt: new Date().toISOString(),
    };
  }

  private buildHook(concept: Concept, misconception?: string): string {
    if (misconception) {
      return `Start with the trap. Put "${misconception}" on the board as a statement and ask the class to vote `
        + `on whether it is true. Do not correct anyone yet — the disagreement is the lesson.`;
    }
    return `Ask: where have you already seen ${concept.label.toLowerCase()} without knowing its name? `
      + `Collect three answers before defining anything.`;
  }

  private buildWorkedExample(concept: Concept, items: { stem: string; answer: { value: unknown }; meta: Record<string, unknown> }[]): string {
    const example = items.find((i) => i.meta.explanation);
    if (!example) {
      return `Work one problem on ${concept.label.toLowerCase()} on the board, narrating every decision out loud — `
        + `especially the ones that feel obvious to you.`;
    }
    return [
      `Problem: ${example.stem}`,
      `Answer: ${String(example.answer.value)}`,
      `Reasoning: ${String(example.meta.explanation)}`,
      `Narrate each step as you write it, and pause before the final line to let the class predict it.`,
    ].join('\n');
  }

  private buildActivity(concept: Concept, misconception?: string): LessonPack['activity'] {
    return {
      title: misconception ? `Convince me: ${truncate(misconception, 40)}` : `Build it: ${concept.label}`,
      grouping: 'pairs, then fours',
      steps: misconception
        ? [
            `In pairs, one student argues that "${misconception}" is true, the other argues it is false.`,
            'Both must use an example, not just an assertion.',
            'Join into fours and agree on the single clearest counter-example.',
            'Each four presents their counter-example in one sentence.',
          ]
        : [
            `In pairs, create the simplest possible example of ${concept.label.toLowerCase()}.`,
            'Swap with another pair and try to break their example.',
            'As a four, write the rule that survived.',
            'Compare rules across the room and reconcile the differences.',
          ],
      materials: ['mini whiteboards', 'the worked example on the board'],
      minutes: 15,
    };
  }

  /** Persist a pack so it can be reopened and shared. */
  save(pack: LessonPack, classroomId?: string): void {
    this.repos.db.insert('lesson_packs', {
      id: pack.id,
      classroom_id: classroomId ?? null,
      concept_id: pack.concept.id,
      document_id: null,
      title: `${pack.concept.label} (grade ${pack.grade})`,
      // The SVG is large and regenerable; store the pack without it.
      payload: { ...pack, visual: pack.visual ? { ...pack.visual, svg: undefined } : undefined },
      created_at: pack.createdAt,
    });
  }

  list(classroomId?: string) {
    return classroomId
      ? this.repos.db.all('SELECT id, title, concept_id, created_at FROM lesson_packs WHERE classroom_id=? ORDER BY created_at DESC', [classroomId])
      : this.repos.db.all('SELECT id, title, concept_id, created_at FROM lesson_packs ORDER BY created_at DESC LIMIT 100');
  }

  get(id: string) {
    const row = this.repos.db.one<{ payload: string }>('SELECT payload FROM lesson_packs WHERE id=?', [id]);
    return row ? JSON.parse(row.payload) as LessonPack : undefined;
  }

  /** Differentiated versions of arbitrary teacher-supplied text. */
  differentiate(text: string, grade: number, profiles: AccessNeed[][]) {
    return profiles.map((needs) => {
      const t = transform({ text, grade, needs });
      const spec = resolveSpec(needs, grade);
      return {
        needs,
        label: needs.map((n) => n.replace(/_/g, ' ')).join(' + '),
        targetGrade: spec.targetGrade,
        readingLevel: { before: t.gains.gradeBefore, after: t.gains.gradeAfter },
        text: t.variants.plain,
        elementary: t.variants.elementary,
        bullets: t.variants.bullets,
        glossary: t.glossary.slice(0, 8),
        presentation: { typography: t.render.typography, colour: t.render.color },
        preferredModalities: t.recommendedModalities.slice(0, 3),
        teacherNotes: spec.guidance,
      };
    });
  }
}
