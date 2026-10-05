import { buildContext, shutdown } from '../api/context.js';
import { memoryDb } from '../db/sqlite.js';
import { TeacherCopilot } from '../teacher/copilot.js';
import { ClassroomOrchestrator } from '../teacher/classroom.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** The whole loop, narrated. Run with `npm run demo`.
 *
 *  Maya is 7th grade, dyslexic, and stuck on ratios. The system finds out why,
 *  fixes the real problem, and proves it worked. */

const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const out = (s = '') => process.stdout.write(`${s}\n`);
const rule = (t: string) => { out(); out(b(`── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`)); out(); };

async function main(): Promise<void> {
  const outDir = resolve(process.cwd(), 'demo-output');
  mkdirSync(outDir, { recursive: true });
  const ctx = buildContext({ db: memoryDb(), startJobs: false });
  ctx.assessment.backfill(3);

  rule('1. A learner arrives');
  const maya = ctx.twin.create({
    name: 'Maya', grade: 7, needs: ['dyslexia', 'working_memory'], interests: ['skateboarding'],
  });
  const spec = ctx.twin.spec(maya.id);
  out(`  ${b('Maya')}, grade 7, dyslexia + working memory support.`);
  out(dim(`  The access profile is derived, not guessed:`));
  out(`    reading target   grade ${spec.targetGrade} (not 7 — the profile shifts it)`);
  out(`    chunk size       ${spec.maxChunkWords} words`);
  out(`    palette          ${spec.colorProfile}, narration at ${spec.ttsRate}x`);
  out(`    attention block  ${spec.segmentSeconds}s`);
  out(`    favours          ${Object.entries(spec.modalityWeights).sort((a, c) => c[1]! - a[1]!).slice(0, 3).map(([m, v]) => `${m} +${v}`).join(', ')}`);

  rule('2. Her history says she is stuck on ratios');
  const set = (slug: string, p: number) => {
    const c = ctx.repos.concepts.bySlug(slug)!;
    ctx.repos.mastery.save({
      learnerId: maya.id, conceptId: c.id, pKnown: p, elo: 1200, attempts: 6,
      correct: Math.round(p * 6), streak: 0, stability: 4, fsrsDifficulty: 5, reps: 2, lapses: 0,
      lastSeen: new Date(Date.now() - 3 * 864e5).toISOString(), dueAt: null, firstMasteredAt: null,
    });
  };
  ['counting', 'addition', 'subtraction', 'place-value', 'multiplication'].forEach((s) => set(s, 0.92));
  set('division', 0.33);
  set('fractions', 0.41);
  out(`  Arithmetic is solid. Division ${r('33%')}, fractions ${r('41%')}, ratios untouched.`);

  rule('3. The system traces the cause, not the symptom');
  const trace = ctx.graph.traceGaps(maya.id, 'ratios');
  out(`  ${trace.explanation}`);
  out();
  for (const gp of trace.gapConcepts) {
    out(`    ${y(gp.concept.label.padEnd(26))} ${Math.round(gp.mastery * 100)}% · ${gp.depth} step(s) upstream · blocks ${gp.blocking}`);
  }
  out();
  out(`  Repair route: ${g(trace.routeConcepts.map((c) => c.label).join(' → '))}`);

  rule('4. The session decides what to do');
  const session = ctx.sessions.start(maya.id, { goalSlug: 'ratios' });
  const answers = [false, true, true, true, true, true];

  for (let i = 0; i < 6; i++) {
    const exp = await ctx.sessions.next(session.id);
    out(`  ${b(`[${i + 1}] ${exp.action}`)} ${dim(`${exp.kind}/${exp.modality}`)}  ${exp.title}`);
    out(dim(`      ${exp.rationale.narrative.slice(0, 150)}`));

    if (exp.check?.itemId) {
      const item = ctx.repos.items.require(exp.check.itemId);
      const correct = answers[i];
      const raw = correct
        ? String(item.answer.value)
        : (item.choices.find((c) => c.misconceptionCode)?.key ?? 'z');
      const res = await ctx.sessions.answer(session.id, {
        itemId: item.id, raw, correct,
        latencyMs: correct ? 13_000 : 38_000, hintsUsed: correct ? 0 : 1, modality: exp.modality,
      });
      out(`      ${correct ? g('✓') : r('✗')} "${raw}"  ${dim(`mastery ${res.mastery.before} → ${res.mastery.after}`)}`);
      if (res.diagnosis) {
        out(`      ${y('DIAGNOSIS')} [${res.diagnosis.source}] ${res.diagnosis.code}`);
        out(dim(`      ${res.diagnosis.reasoning.slice(0, 130)}`));
      }
      if (res.misconceptions?.repaired.length) {
        out(`      ${g('REPAIRED')} ${res.misconceptions.repaired.join(', ')}`);
      }
      if (res.unlocked.length) out(`      ${g('UNLOCKED')} ${res.unlocked.map((u) => u.label).join(', ')}`);
    }
    out();
  }

  rule('5. What the session achieved');
  const summary = ctx.sessions.end(session.id, 'demo');
  for (const h of summary.highlights) out(`  ${g('·')} ${h}`);
  out();
  for (const c of summary.conceptsTouched) {
    out(`    ${c.label.padEnd(26)} ${Math.round(c.before * 100)}% → ${Math.round(c.after * 100)}%`);
  }
  out();
  out(`  ${b('Next time:')}`);
  for (const n of summary.nextTime) out(`    ${n}`);

  rule('6. The same knowledge, four different doorways');
  const asset = await ctx.visual.build({ conceptSlug: 'fraction-addition', learnerId: maya.id });
  writeFileSync(resolve(outDir, 'fraction-addition.svg'), asset.svg);
  writeFileSync(resolve(outDir, 'fraction-addition.still.svg'), asset.stillSvg);
  writeFileSync(resolve(outDir, 'fraction-addition.vtt'), asset.captionsVtt);
  out(`  animation   ${Math.round(asset.durationSec)}s, ${Math.round(asset.bytes / 1024)}KB, ${asset.segments.length} chapter(s)`);
  out(`  narration   ${asset.narration.slice(0, 96)}…`);
  out(`  spoken alt  ${asset.audioDescription.slice(0, 96)}…`);
  out(`  captions    ${asset.captionsVtt.split('\n').length} lines of WebVTT`);
  out(dim(`  written to demo-output/`));

  rule('7. A teacher asks for the lesson');
  const copilot = new TeacherCopilot(ctx.repos, ctx.graph, ctx.assessment, ctx.misconceptions, ctx.visual);
  const pack = await copilot.lessonPack({ conceptSlug: 'fraction-addition', grade: 6, includeVisual: false, questionCount: 3 });
  out(`  ${b('Objective')}  ${pack.objective}`);
  out(`  ${b('Hook')}       ${pack.lesson.hook.slice(0, 130)}`);
  out(`  ${b('Versions')}   ${pack.differentiation.map((d) => `${d.label} (grade ${d.targetGrade})`).join(' · ')}`);
  out(`  ${b('Quiz')}       ${pack.quiz.questions.length} questions; ${pack.quiz.answerKey.filter((k) => k.ifTheyChose).length} with "if they chose X" diagnostics`);
  out(`  ${b('Watch for')}  ${pack.misconceptions.map((m) => m.label).join('; ')}`);
  out(`  ${b('Activity')}   ${pack.activity.title} (${pack.activity.minutes} min, ${pack.activity.grouping})`);
  writeFileSync(resolve(outDir, 'lesson-pack.json'), JSON.stringify(pack, null, 2));

  rule('8. Thirty students, one teacher, one period');
  const classroom = new ClassroomOrchestrator(ctx.repos, ctx.graph, ctx.twin, ctx.misconceptions);
  const room = classroom.create({ name: 'Year 8 Maths', teacher: 'Ms Okafor', subject: 'math', grade: 8 });
  const ids = [maya.id];
  for (let i = 0; i < 11; i++) {
    const l = ctx.twin.create({
      name: `Student ${i + 1}`, grade: 8,
      needs: i % 4 === 0 ? ['dyslexia'] : i % 5 === 0 ? ['adhd'] : [],
    });
    ids.push(l.id);
    // Give them real arithmetic history, so the grouping reflects THIS lesson
    // rather than every prerequisite they were never given.
    for (const slug of ['counting', 'addition', 'subtraction', 'place-value', 'multiplication']) {
      const c = ctx.repos.concepts.bySlug(slug)!;
      ctx.repos.mastery.save({
        learnerId: l.id, conceptId: c.id, pKnown: 0.9, elo: 1200, attempts: 6, correct: 5,
        streak: 2, stability: 6, fsrsDifficulty: 5, reps: 3, lapses: 0,
        lastSeen: new Date().toISOString(), dueAt: null, firstMasteredAt: new Date().toISOString(),
      });
    }
    const level = i < 4 ? 0.9 : i < 8 ? 0.55 : 0.2;
    for (const slug of ['division', 'fractions', 'fraction-addition']) {
      const c = ctx.repos.concepts.bySlug(slug)!;
      ctx.repos.mastery.save({
        learnerId: l.id, conceptId: c.id, pKnown: level, elo: 1200, attempts: 5,
        correct: Math.round(level * 5), streak: 0, stability: 3, fsrsDifficulty: 5, reps: 2, lapses: 0,
        lastSeen: new Date().toISOString(), dueAt: null, firstMasteredAt: null,
      });
    }
    if (i % 3 === 0) {
      const m = ctx.repos.misconceptions.byCode('FRAC_ADD_CROSS')!;
      ctx.twin.noteMisconception(l.id, m.id, ctx.repos.concepts.bySlug('fraction-addition')!.id, 0.8);
    }
  }
  classroom.enroll(room.id, ids);
  const plan = classroom.group(room.id, ['fraction-addition'], { maxGroups: 3 });
  out(`  ${plan.teacherBriefing}`);
  out();
  for (const grp of plan.groups) {
    out(`  ${b(grp.label)} ${dim(`(${grp.learners.length} students, mean ${grp.meanMastery}, ${grp.estimatedMinutes} min)`)}`);
    out(`    ${grp.doThis}`);
    out();
  }
  if (plan.wholeClassNote) out(`  ${y(plan.wholeClassNote)}`);

  rule('9. Is the system itself working?');
  const { AnalyticsService } = await import('../analytics/service.js');
  const analytics = new AnalyticsService(ctx.repos, ctx.graph);
  const eff = analytics.systemEffectiveness(30);
  out(`  misconceptions  ${eff.misconceptions.detected} detected, ${eff.misconceptions.repaired} repaired`);
  out(dim(`                  ${eff.misconceptions.interpretation}`));
  out(`  sessions        ${eff.sessions.started} started, ${Math.round((eff.sessions.assessmentCoverage ?? 0) * 100)}% checked what they taught`);
  out(dim(`                  ${eff.sessions.interpretation}`));
  out(`  item bank       ${eff.itemBank.items} items, ${Math.round(eff.itemBank.diagnosticShare * 100)}% diagnostic`);
  out(dim(`                  ${eff.itemBank.interpretation}`));

  out();
  out(b('  Every number above was computed. Nothing was mocked, and no hosted model was called.'));
  out();

  shutdown();
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`\ndemo failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
