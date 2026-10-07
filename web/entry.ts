/** The browser build of LUMEN OS.
 *
 *  Everything here is the SAME source the server runs - the accessibility
 *  transformer, the misconception detectors, the physics solvers and the
 *  animation compiler are pure computation, so they run unchanged in a tab.
 *  Nothing is reimplemented for the web, and nothing is faked. */

export { transform } from '../src/accessibility/transformer.js';
export { analyzeReadability, rankSentences, textDifficulty } from '../src/accessibility/readability.js';
export { simplify, elementarize } from '../src/accessibility/simplify.js';
export { buildRenderPlan, COLOR_PROFILES, contrastRatio, bionic, chunkForReading } from '../src/accessibility/dyslexia.js';
export { buildAudioScript, toWebVtt, speakMath } from '../src/accessibility/ssml.js';
export { decodeSupport, decodingReport, segmentGraphemes } from '../src/accessibility/phonics.js';
export { resolveSpec, NEED_POLICIES } from '../src/accessibility/profiles.js';

export { detectAll, evalExpression, evalLeftToRight } from '../src/misconception/detectors.js';

export { buildAnimation, listAnimations } from '../src/engines/animation/library.js';
export { renderSvg } from '../src/engines/animation/svg.js';
export { auditScene, narrationScript, segmentScene } from '../src/engines/animation/compiler.js';
export { sanitizeStoryboard, compileStoryboard, STORYBOARD_SCHEMA } from '../src/engines/animation/storyboard.js';

export { runLab, describeLabs, labDefaults, getLab, LABS } from '../src/engines/sim/lab.js';
export { solveCircuit, CIRCUIT_PRESETS } from '../src/engines/sim/circuit.js';
export { simulateProjectile, simulatePendulum, simulateCollision, simulateIncline, decimate } from '../src/engines/sim/mechanics.js';
export { balanceEquation, simulateTitration, solveGasLaw } from '../src/engines/sim/chemistry.js';
export { punnett, hardyWeinberg } from '../src/engines/sim/genetics.js';

export { verify, redactPii, checkInjection } from '../src/safety/verifier.js';

export { generateItems } from '../src/assessment/itemgen.js';
export { grade, scoreSelfExplanation } from '../src/assessment/grading.js';
export { probability, information, estimateAbilityEap } from '../src/assessment/irt.js';

export { ALL_MODALITIES, ALL_NEEDS } from '../src/domain/types.js';
export { SEED_CONCEPTS, SEED_MISCONCEPTIONS } from '../src/graph/seed.js';
export { Adjacency, traceGaps, zpdFrontier, pageRank, topoSort, graphHealth } from '../src/graph/algorithms.js';

/* ------------------------------------------------------------------ *
 * Browser conveniences
 *
 * The server builds its graph view out of SQLite rows. The demo has no
 * database, so it assembles the same GraphView shape straight from the
 * seed - the algorithms downstream are identical either way.
 * ------------------------------------------------------------------ */
import { SEED_CONCEPTS as SEED } from '../src/graph/seed.js';
import { Adjacency as Adj, topoSort } from '../src/graph/algorithms.js';
import type { ConceptEdge } from '../src/domain/types.js';

export function seedGraphView(): { nodes: string[]; edges: ConceptEdge[] } {
  const nodes = SEED.map((c) => c.slug);
  const known = new Set(nodes);
  const edges: ConceptEdge[] = [];
  const link = (from: string, to: string, kind: ConceptEdge['kind'], weight: number) => {
    if (!known.has(from) || !known.has(to) || from === to) return;
    edges.push({ id: `${kind}:${from}->${to}`, from, to, kind, weight });
  };
  // The same five edge kinds the server seeds. Building only 'requires' here
  // would show a different graph than the backend actually runs on.
  for (const c of SEED) {
    for (const p of c.requires ?? []) link(p, c.slug, 'requires', 1);
    for (const n of c.leadsTo ?? []) link(c.slug, n, 'leads_to', 0.8);
    for (const r of c.relatedTo ?? []) link(c.slug, r, 'related', 0.5);
    for (const x of c.contrastsWith ?? []) link(c.slug, x, 'contrasts_with', 0.6);
    for (const a of c.appliesTo ?? []) link(c.slug, a, 'applies_to', 0.7);
  }
  return { nodes, edges };
}

export function seedAdjacency(): Adj {
  return new Adj(seedGraphView());
}

/** slug -> seed record, with entry grades normalised exactly as the server
 *  normalises them at seed time: a concept cannot be introduced before its
 *  own prerequisites, so each grade is pushed forward through the topological
 *  order. Without this the browser reports sequencing errors the backend has
 *  already repaired. */
export function seedIndex(): Map<string, SeedRecord> {
  const idx = new Map<string, SeedRecord>(
    SEED.map((c) => [c.slug, { ...c, gradeMin: c.grades[0], gradeMax: c.grades[1] }]),
  );
  const adj = seedAdjacency();
  for (const slug of topoSort(adj).order) {
    const c = idx.get(slug);
    if (!c) continue;
    const prereqs = adj.prerequisites(slug).map((p) => idx.get(p)).filter(Boolean) as SeedRecord[];
    if (!prereqs.length) continue;
    const latest = prereqs.reduce((a, b) => (b.gradeMin > a.gradeMin ? b : a));
    if (latest.gradeMin > c.gradeMin) {
      c.gradeMin = latest.gradeMin;
      c.gradeMax = Math.max(c.gradeMax, latest.gradeMin);
    }
  }
  return idx;
}

export type SeedRecord = (typeof SEED)[number] & { gradeMin: number; gradeMax: number };
