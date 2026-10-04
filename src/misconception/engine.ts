import type { Repos } from '../db/repos.js';
import type { ItemRecord, Misconception, Modality, RemediationPlan } from '../domain/types.js';
import { detectAll, type Detection } from './detectors.js';
import type { ModelRouter } from '../llm/router.js';
import { deterministic } from '../llm/providers/deterministic.js';
import { S } from '../llm/jsonschema.js';
import { clamp, round } from '../core/mathx.js';
import { logger } from '../core/logger.js';
import { truncate } from '../core/textkit.js';

/** THE MISCONCEPTION ENGINE
 *
 *  Three-stage diagnosis, cheapest and most certain first:
 *
 *   1. Distractor mapping - the item author already said what each wrong
 *      option means. Free and exact.
 *   2. Rule detectors - re-derive the learner's answer from a hypothesised
 *      wrong procedure. Free, deterministic, auditable, high confidence.
 *   3. Model diagnosis - only for open responses nothing else explains, and
 *      constrained to the documented catalogue so it cannot invent a label.
 */

export interface DiagnosisInput {
  learnerId?: string;
  itemId?: string;
  conceptId?: string;
  stem?: string;
  learnerAnswer: string;
  correctAnswer?: string;
  /** The choice key selected, for distractor mapping. */
  choiceKey?: string;
  allowModel?: boolean;
}

export interface Diagnosis {
  found: boolean;
  source: 'distractor_map' | 'rule_detector' | 'model' | 'none';
  misconception?: Misconception;
  code?: string;
  confidence: number;
  reasoning: string;
  wrongRule?: string;
  reproducedAnswer?: string;
  alternatives: { code: string; confidence: number; reasoning: string }[];
  remediation?: RemediationPlan;
  /** What to say back to the learner right now. */
  feedback: {
    acknowledge: string;
    diagnose: string;
    contrast?: { wrong: string; right: string };
    nextStep: string;
    tone: 'encouraging' | 'neutral';
  };
}

const DIAGNOSIS_SCHEMA = S.obj({
  code: S.str('misconception code from the supplied catalogue, or NONE'),
  confidence: S.num('0 to 1', { minimum: 0, maximum: 1 }),
  reasoning: S.str('one or two sentences naming the wrong rule the learner applied'),
  wrongRule: S.str('the faulty procedure, stated as a rule'),
}, ['code', 'confidence', 'reasoning']);

export class MisconceptionEngine {
  constructor(private repos: Repos, private router: ModelRouter) {
    registerOfflineDiagnosis();
  }

  /* ------------------------------ diagnosis ------------------------------ */

  async diagnose(input: DiagnosisInput): Promise<Diagnosis> {
    const item = input.itemId ? this.repos.items.get(input.itemId) : undefined;
    const stem = input.stem ?? item?.stem ?? '';
    const correct = input.correctAnswer ?? (item ? String(item.answer.value) : '');

    // 1. Distractor mapping: the item author already told us.
    const mapped = this.fromDistractor(item, input.choiceKey ?? input.learnerAnswer);
    if (mapped) return this.build(mapped.misconception, 'distractor_map', 0.97, mapped.reasoning, [], {
      wrongRule: mapped.misconception.label.toLowerCase(),
    });

    // 2. Rule detectors.
    const detections = detectAll({
      stem,
      learnerAnswer: input.learnerAnswer,
      correctAnswer: correct,
      conceptSlug: input.conceptId ? this.repos.concepts.get(input.conceptId)?.slug : undefined,
    });
    if (detections.length) {
      const top = detections[0];
      const m = this.repos.misconceptions.byCode(top.code);
      if (m) {
        return this.build(m, 'rule_detector', top.confidence, top.reasoning,
          detections.slice(1).map((d) => ({ code: d.code, confidence: d.confidence, reasoning: d.reasoning })),
          { wrongRule: top.wrongRule, reproducedAnswer: top.reproducedAnswer });
      }
    }

    // 3. Model diagnosis, constrained to the catalogue.
    if (input.allowModel !== false && input.learnerAnswer.trim().length > 0) {
      const modelDiag = await this.modelDiagnose(input, stem, correct);
      if (modelDiag) return modelDiag;
    }

    return {
      found: false,
      source: 'none',
      confidence: 0,
      reasoning: 'No documented misconception explains this answer. It may be a one-off slip, a reading error, or a gap rather than a faulty rule.',
      alternatives: [],
      feedback: {
        acknowledge: 'Not quite - but nothing about your method looks broken.',
        diagnose: 'This looks like a slip rather than a misunderstanding.',
        nextStep: 'Read the question once more out loud, then try again. If it still does not click, we will walk through one together.',
        tone: 'encouraging',
      },
    };
  }

  private fromDistractor(item: ItemRecord | undefined, answer: string): { misconception: Misconception; reasoning: string } | null {
    if (!item) return null;
    const key = answer.trim().toLowerCase();
    const code = item.misconceptionMap[key]
      ?? item.misconceptionMap[answer.trim()]
      ?? item.choices.find((c) => c.key.toLowerCase() === key || c.text.trim().toLowerCase() === key)?.misconceptionCode;
    if (!code) return null;
    const m = this.repos.misconceptions.byCode(code);
    if (!m) return null;
    const choice = item.choices.find((c) => c.misconceptionCode === code);
    return {
      misconception: m,
      reasoning: `Option "${choice?.text ?? key}" was written specifically to catch this misconception: ${m.description}`,
    };
  }

  private async modelDiagnose(input: DiagnosisInput, stem: string, correct: string): Promise<Diagnosis | null> {
    const concept = input.conceptId ? this.repos.concepts.get(input.conceptId) : undefined;
    const catalogue = (concept
      ? [...this.repos.misconceptions.forConcept(concept.id), ...this.repos.misconceptions.all(concept.subject)]
      : this.repos.misconceptions.all()
    ).filter((m, i, a) => a.findIndex((x) => x.code === m.code) === i).slice(0, 24);

    if (!catalogue.length) return null;

    const prompt = [
      `Question: ${stem}`,
      `Correct answer: ${correct}`,
      `Learner's answer: ${input.learnerAnswer}`,
      '',
      'Documented misconceptions you may choose from:',
      ...catalogue.map((m) => `- ${m.code}: ${m.label} - ${m.description}`),
      '',
      'Which single misconception best explains this specific answer? If none of them does, answer with code "NONE".',
      'Do not invent a code. Only explain the wrong rule the learner appears to have applied.',
    ].join('\n');

    try {
      const { value } = await this.router.structured<{ code: string; confidence: number; reasoning: string; wrongRule?: string }>({
        purpose: 'misconception.diagnose',
        tier: 'balanced',
        schema: DIAGNOSIS_SCHEMA,
        system: 'You are a diagnostic assessment specialist. You identify the faulty procedure behind a wrong answer. '
          + 'You never guess: if no listed misconception explains the answer, you say NONE.',
        messages: [{ role: 'user', content: prompt }],
        seed: `${input.itemId ?? stem}:${input.learnerAnswer}`,
        offlineContext: { stem, learnerAnswer: input.learnerAnswer, correct, codes: catalogue.map((m) => m.code) },
      });

      if (!value || !value.code || value.code === 'NONE') return null;
      const m = this.repos.misconceptions.byCode(value.code);
      if (!m) {
        logger.debug('model proposed an unknown misconception code', { code: value.code });
        return null;
      }
      // Model evidence is capped below rule evidence: it cannot out-rank a
      // detector that literally reproduced the learner's arithmetic.
      return this.build(m, 'model', clamp(value.confidence ?? 0.5, 0, 0.8), value.reasoning, [], {
        wrongRule: value.wrongRule,
      });
    } catch (e) {
      logger.warn('model diagnosis failed', { err: String(e) });
      return null;
    }
  }

  private build(
    m: Misconception,
    source: Diagnosis['source'],
    confidence: number,
    reasoning: string,
    alternatives: Diagnosis['alternatives'],
    extra: { wrongRule?: string; reproducedAnswer?: string } = {},
  ): Diagnosis {
    const contrast = m.remediation.contrastPair;
    return {
      found: true,
      source,
      misconception: m,
      code: m.code,
      confidence: round(confidence, 3),
      reasoning,
      wrongRule: extra.wrongRule,
      reproducedAnswer: extra.reproducedAnswer,
      alternatives,
      remediation: m.remediation,
      feedback: {
        acknowledge: m.severity === 'critical'
          ? 'Hold on - this one is worth stopping for, because the method itself needs a fix.'
          : 'Close, and I can see exactly what happened.',
        diagnose: `${m.label}. ${m.description}`,
        ...(contrast ? { contrast } : {}),
        nextStep: m.remediation.steps[0] ?? 'Let us rebuild this with a concrete model.',
        tone: 'encouraging',
      },
    };
  }

  /* ----------------------------- remediation ----------------------------- */

  /** A targeted micro-lesson for one misconception: contradiction, then rebuild. */
  buildRemediation(code: string, opts: { grade?: number; modality?: Modality } = {}): {
    misconception: Misconception;
    plan: RemediationPlan;
    microLesson: {
      title: string;
      modality: Modality;
      estimatedSeconds: number;
      steps: { kind: 'contradict' | 'rebuild' | 'contrast' | 'practice' | 'verify'; title: string; text: string }[];
      prerequisiteChecks: { conceptId: string; slug: string; label: string }[];
      practice: { count: number; focus: string; kind: string };
    };
  } {
    const m = this.repos.misconceptions.byCode(code);
    if (!m) throw new Error(`unknown misconception code '${code}'`);
    const plan = m.remediation;
    const modality = opts.modality ?? plan.modality;

    const steps: { kind: 'contradict' | 'rebuild' | 'contrast' | 'practice' | 'verify'; title: string; text: string }[] = [];

    // 1. Make the learner's own rule fail in front of them. Telling them it is
    //    wrong does not dislodge it; watching it break does.
    if (plan.contrastPair) {
      steps.push({
        kind: 'contradict',
        title: 'Run your rule on an example you can check',
        text: `You have been using: ${m.label.toLowerCase()}. Apply it here: ${plan.contrastPair.wrong}. `
          + `Now check that against something you already know for certain. It does not hold.`,
      });
    } else {
      steps.push({
        kind: 'contradict',
        title: 'Test the rule',
        text: `${plan.steps[0] ?? m.description}`,
      });
    }

    // 2. Rebuild from a concrete model.
    for (const [i, s] of plan.steps.slice(plan.contrastPair ? 1 : 1).entries()) {
      steps.push({ kind: i === 0 ? 'rebuild' : 'contrast', title: i === 0 ? 'Build it again from something solid' : 'Compare', text: s });
    }

    if (plan.contrastPair) {
      steps.push({
        kind: 'contrast',
        title: 'Side by side',
        text: `Wrong: ${plan.contrastPair.wrong}\nRight: ${plan.contrastPair.right}\nName the exact step where they part company.`,
      });
    }

    steps.push({
      kind: 'practice',
      title: 'Three of your own',
      text: `Now do ${plan.practiceSpec?.count ?? 3} on your own, saying the rule out loud each time.`,
    });
    steps.push({
      kind: 'verify',
      title: 'Teach it back',
      text: `Explain to me why "${plan.contrastPair?.wrong ?? m.label.toLowerCase()}" does not work. If you can explain it, you own it.`,
    });

    const prereqChecks = (plan.prerequisiteCheck ?? [])
      .map((slug) => this.repos.concepts.bySlug(slug))
      .filter(Boolean)
      .map((c) => ({ conceptId: c!.id, slug: c!.slug, label: c!.label }));

    return {
      misconception: m,
      plan,
      microLesson: {
        title: `Repair: ${m.label}`,
        modality,
        estimatedSeconds: 60 + steps.length * 35 + (opts.grade && opts.grade < 5 ? 40 : 0),
        steps,
        prerequisiteChecks: prereqChecks,
        practice: {
          count: plan.practiceSpec?.count ?? 3,
          focus: plan.practiceSpec?.focus ?? m.code,
          kind: plan.practiceSpec?.kind ?? 'targeted',
        },
      },
    };
  }

  /** Catalogue browsing, for teachers and for the API. */
  catalogue(opts: { subject?: string; conceptId?: string } = {}) {
    const all = opts.conceptId
      ? this.repos.misconceptions.forConcept(opts.conceptId)
      : this.repos.misconceptions.all(opts.subject);
    return all.map((m) => ({
      id: m.id,
      code: m.code,
      label: m.label,
      description: m.description,
      subject: m.subject,
      severity: m.severity,
      detector: m.detector,
      conceptId: m.conceptId,
      conceptLabel: m.conceptId ? this.repos.concepts.get(m.conceptId)?.label : undefined,
      strategy: m.remediation.strategy,
      stepCount: m.remediation.steps.length,
      hasContrast: Boolean(m.remediation.contrastPair),
      ruleDetectable: m.detector === 'rule',
    }));
  }

  /** Which misconceptions are live across a cohort - the teacher's heat map. */
  cohortPrevalence(learnerIds: string[]) {
    if (!learnerIds.length) return [];
    const marks = learnerIds.map(() => '?').join(',');
    const rows = this.repos.db.all<{ misconception_id: string; n: number; avg_conf: number }>(
      `SELECT misconception_id, COUNT(*) as n, AVG(confidence) as avg_conf
       FROM learner_misconceptions
       WHERE learner_id IN (${marks}) AND status='active'
       GROUP BY misconception_id ORDER BY n DESC`,
      learnerIds,
    );
    return rows.map((r) => {
      const m = this.repos.misconceptions.get(r.misconception_id);
      return {
        code: m?.code ?? 'unknown',
        label: m?.label ?? 'unknown',
        severity: m?.severity ?? 'moderate',
        affected: Number(r.n),
        share: round(Number(r.n) / learnerIds.length, 3),
        meanConfidence: round(Number(r.avg_conf), 3),
        strategy: m?.remediation.strategy,
        teachingNote: m ? `${Number(r.n)} of ${learnerIds.length} learners show this. ${m.remediation.steps[0] ?? ''}` : '',
      };
    });
  }
}

/** Offline diagnosis handler: the detectors already did the real work, so the
 *  offline path simply declines rather than inventing a label. */
function registerOfflineDiagnosis(): void {
  deterministic.register('misconception.diagnose', (ctx) => {
    const answer = String(ctx.extra.learnerAnswer ?? '');
    return {
      code: 'NONE',
      confidence: 0,
      reasoning: `No rule detector matched "${truncate(answer, 40)}" and no hosted model is configured, `
        + 'so no misconception is claimed. Treating this as a gap rather than a faulty rule.',
      wrongRule: 'unknown',
    };
  });
}
