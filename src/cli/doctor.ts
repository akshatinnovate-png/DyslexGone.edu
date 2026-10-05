import { buildContext, shutdown } from '../api/context.js';
import { memoryDb } from '../db/sqlite.js';
import { config } from '../core/config.js';
import { deterministic } from '../llm/providers/deterministic.js';
import { listAnimations, buildAnimation } from '../engines/animation/library.js';
import { auditScene } from '../engines/animation/compiler.js';
import { renderSvg } from '../engines/animation/svg.js';
import { LABS, runLab, labDefaults } from '../engines/sim/lab.js';
import { detectAll } from '../misconception/detectors.js';
import { generateItems } from '../assessment/itemgen.js';

/** Self-check. Boots everything in memory and reports what works, what is
 *  degraded and what is missing - before anyone demos it. */

type Check = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string };

const C = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };

async function main(): Promise<void> {
  const checks: Check[] = [];
  const t0 = Date.now();
  process.stdout.write('\n  LUMEN OS — self check\n');

  const db = memoryDb();
  const ctx = buildContext({ db, startJobs: false });

  checks.push({
    name: 'database',
    status: db.tables().length >= 30 ? 'ok' : 'fail',
    detail: `${db.tables().length} tables, schema version ${db.scalar('SELECT MAX(version) FROM _migrations')}`,
  });

  const health = ctx.graph.health();
  checks.push({
    name: 'curriculum graph',
    status: health.cycles.length ? 'fail' : health.warnings.length ? 'warn' : 'ok',
    detail: `${health.nodes} concepts, ${health.edges} links, ${health.components} component(s), max depth ${health.maxDepth}`
      + `${health.warnings.length ? ` — ${health.warnings.join('; ')}` : ''}`,
  });

  const backfilled = ctx.assessment.backfill(2);
  const bank = ctx.assessment.bankReport();
  checks.push({
    name: 'item bank',
    status: bank.totals.empty > 0 ? 'fail' : 'ok',
    detail: `${bank.totals.items} items across ${bank.totals.concepts} concepts `
      + `(${bank.totals.diagnostic} diagnostic, ${backfilled.length} generated now, ${bank.totals.empty} unassessable)`,
  });

  const unassessable = ctx.repos.concepts.all()
    .filter((c) => generateItems(c, ctx.repos.terms.forConcept(c.id), { count: 1 }).length === 0);
  checks.push({
    name: 'item generation',
    status: unassessable.length ? 'fail' : 'ok',
    detail: unassessable.length
      ? `${unassessable.length} concept(s) cannot be assessed: ${unassessable.slice(0, 5).map((c) => c.slug).join(', ')}`
      : 'every concept can produce a check',
  });

  const animations = listAnimations();
  const animFailures: string[] = [];
  let totalSvgKb = 0;
  for (const a of animations) {
    try {
      const scene = buildAnimation({ conceptSlug: a.conceptSlug });
      if (!scene) { animFailures.push(`${a.conceptSlug}: no scene`); continue; }
      const audit = auditScene(scene);
      if (!audit.ok) animFailures.push(`${a.conceptSlug}: ${audit.issues.join('; ')}`);
      totalSvgKb += renderSvg(scene).length / 1024;
    } catch (e) {
      animFailures.push(`${a.conceptSlug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  checks.push({
    name: 'curated animations',
    status: animFailures.length ? 'fail' : 'ok',
    detail: animFailures.length
      ? animFailures.slice(0, 3).join(' | ')
      : `${animations.length} animations render and pass audit (${Math.round(totalSvgKb)}KB total)`,
  });

  const authored = await ctx.visual.build({
    topic: 'Supply and demand',
    description: 'When the price rises, producers supply more and buyers demand less. '
      + 'The price where the two match is the equilibrium price.',
    grade: 9,
  });
  checks.push({
    name: 'scene authoring',
    status: authored.audit.ok ? 'ok' : 'warn',
    detail: `an off-graph topic produced a ${Math.round(authored.durationSec)}s scene via "${authored.source}" `
      + `(audit ${authored.audit.ok ? 'passed' : `failed: ${authored.audit.issues.join('; ')}`})`,
  });

  const labFailures: string[] = [];
  for (const lab of LABS) {
    try {
      const r = runLab(lab.id, labDefaults(lab.id));
      if (!r.readings.length) labFailures.push(`${lab.id}: no readings`);
    } catch (e) {
      labFailures.push(`${lab.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  checks.push({
    name: 'virtual labs',
    status: labFailures.length ? 'fail' : 'ok',
    detail: labFailures.length ? labFailures.join(' | ') : `${LABS.length} labs run on their defaults`,
  });

  const probes: [string, string, string][] = [
    ['What is 2/3 + 1/4?', '3/7', 'FRAC_ADD_CROSS'],
    ['Evaluate 2 + 3 * 4', '20', 'PEMDAS_LEFT_RIGHT'],
    ['What is 5 - (-3)?', '2', 'NEG_SUBTRACT_SMALLER'],
    ['Which is larger: 1/3 or 1/8?', '1/8', 'FRAC_BIGGER_DENOM'],
  ];
  const missed = probes.filter(([stem, ans, code]) =>
    !detectAll({ stem, learnerAnswer: ans, correctAnswer: '' }).some((d) => d.code === code));
  checks.push({
    name: 'misconception probes',
    status: missed.length ? 'fail' : 'ok',
    detail: missed.length
      ? `missed: ${missed.map((m) => m[2]).join(', ')}`
      : `${probes.length} probe answers diagnosed; ${ctx.repos.misconceptions.all().length} in the catalogue`,
  });

  try {
    const learner = ctx.twin.create({ name: 'doctor', grade: 7, needs: ['dyslexia'] });
    const session = ctx.sessions.start(learner.id, { goalSlug: 'ratios' });
    let delivered = 0;
    let answered = 0;
    for (let i = 0; i < 4; i++) {
      const exp = await ctx.sessions.next(session.id);
      delivered++;
      if (exp.check?.itemId) {
        const item = ctx.repos.items.require(exp.check.itemId);
        await ctx.sessions.answer(session.id, {
          itemId: item.id, raw: String(item.answer.value), correct: true, latencyMs: 12_000,
        });
        answered++;
      }
    }
    const summary = ctx.sessions.end(session.id);
    checks.push({
      name: 'adaptation loop',
      status: answered > 0 && summary.conceptsTouched.length > 0 ? 'ok' : 'fail',
      detail: `${delivered} experiences delivered, ${answered} checked, `
        + `${summary.conceptsTouched.length} concept(s) touched, accuracy ${summary.accuracy}`,
    });
  } catch (e) {
    checks.push({ name: 'adaptation loop', status: 'fail', detail: e instanceof Error ? e.message : String(e) });
  }

  try {
    const report = await ctx.ingestion.ingest({
      content: '# Osmosis\n\n## Definition\nWater moves across a partially permeable membrane from a dilute '
        + 'solution to a concentrated one. This requires no energy.\n',
      subject: 'biology', grade: 8,
    });
    checks.push({
      name: 'ingestion',
      status: report.concepts.length ? 'ok' : 'fail',
      detail: `${report.concepts.length} concept(s), ${report.itemsGenerated} items, reads at grade ${report.readability.gradeLevel}`,
    });
  } catch (e) {
    checks.push({ name: 'ingestion', status: 'fail', detail: e instanceof Error ? e.message : String(e) });
  }

  const stats = ctx.router.stats();
  const hosted = stats.providers.filter((p) => p.name !== 'deterministic' && p.available);
  checks.push({
    name: 'model providers',
    status: 'ok',
    detail: hosted.length
      ? `${hosted.map((p) => p.name).join(', ')} available (mode: ${config.llm.mode})`
      : `offline engine only — every feature still works. Set GROQ_API_KEY or ANTHROPIC_API_KEY for `
        + `model-authored animations and richer prose. ${deterministic.registered().length} offline handlers registered.`,
  });

  process.stdout.write('\n');
  for (const c of checks) {
    process.stdout.write(`  ${C[c.status]} ${c.name.padEnd(22)} ${c.detail}\n`);
  }

  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');
  process.stdout.write(
    `\n  ${failed.length ? '\x1b[31m' : '\x1b[32m'}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m`
    + `${warned.length ? ` (${warned.length} warning${warned.length === 1 ? '' : 's'})` : ''}`
    + ` in ${Date.now() - t0}ms\n\n`,
  );

  shutdown();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`\n  doctor crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
