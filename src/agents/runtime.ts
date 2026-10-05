import type { AppContext } from '../api/context.js';
import { id as newId } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { bus } from '../core/events.js';
import { metrics } from '../core/metrics.js';
import { round } from '../core/mathx.js';
import { config } from '../core/config.js';

/** MULTI-AGENT RUNTIME
 *
 *  One model doing everything is a single point of failure and a single point
 *  of confusion. Here each agent owns one question, writes its answer to a
 *  shared blackboard, and the next agent reads it.
 *
 *  Crucially, most agents do NOT call a model at all - they call the engines
 *  that already exist. The "agent" framing buys orchestration and traceability,
 *  not a reason to prompt for something we can compute. */

export interface Blackboard {
  [key: string]: unknown;
}

export interface AgentContext {
  app: AppContext;
  board: Blackboard;
  /** Write a value other agents can read. */
  put(key: string, value: unknown): void;
  get<T>(key: string): T | undefined;
  /** Record a reasoning step in the trace. */
  note(message: string): void;
  budgetUsd: number;
  spentUsd: number;
}

export interface Agent {
  name: string;
  /** The one question this agent answers. */
  question: string;
  /** Keys that must exist on the board before this agent can run. */
  requires: string[];
  /** Keys this agent writes. */
  provides: string[];
  /** Skip when this returns false. */
  when?: (ctx: AgentContext) => boolean;
  run(ctx: AgentContext): Promise<void> | void;
}

export interface TraceStep {
  agent: string;
  question: string;
  status: 'ok' | 'skipped' | 'failed';
  ms: number;
  notes: string[];
  produced: string[];
  error?: string;
  costUsd?: number;
}

export interface AgentRunResult<T = unknown> {
  runId: string;
  kind: string;
  ok: boolean;
  output: T;
  trace: TraceStep[];
  board: Blackboard;
  ms: number;
  costUsd: number;
  agentsRun: number;
  agentsSkipped: number;
}

/** Runs agents in dependency order, with a budget and a full trace. */
export class AgentRuntime {
  constructor(private app: AppContext) {}

  async run<T>(
    kind: string,
    agents: Agent[],
    seed: Blackboard,
    opts: { budgetUsd?: number; outputKey?: string } = {},
  ): Promise<AgentRunResult<T>> {
    const runId = newId('run');
    const t0 = performance.now();
    const board: Blackboard = { ...seed };
    const trace: TraceStep[] = [];
    let spent = 0;

    const ordered = topoOrder(agents);

    this.app.db.insert('agent_runs', {
      id: runId, kind, status: 'running', input: seed, output: null,
      trace: [], cost_usd: 0, steps: 0, started_at: new Date().toISOString(),
    });

    for (const agent of ordered) {
      const stepStart = performance.now();
      const notes: string[] = [];
      const before = new Set(Object.keys(board));

      const ctx: AgentContext = {
        app: this.app,
        board,
        put: (k, v) => { board[k] = v; },
        get: <X>(k: string) => board[k] as X | undefined,
        note: (m) => notes.push(m),
        budgetUsd: opts.budgetUsd ?? config.llm.perRequestBudgetUsd,
        spentUsd: spent,
      };

      const missing = agent.requires.filter((r) => board[r] === undefined);
      if (missing.length) {
        trace.push({
          agent: agent.name, question: agent.question, status: 'skipped',
          ms: 0, notes: [`missing from the blackboard: ${missing.join(', ')}`], produced: [],
        });
        continue;
      }
      if (agent.when && !agent.when(ctx)) {
        trace.push({
          agent: agent.name, question: agent.question, status: 'skipped',
          ms: 0, notes: ['preconditions not met'], produced: [],
        });
        continue;
      }

      try {
        await agent.run(ctx);
        const ms = Math.round(performance.now() - stepStart);
        const produced = Object.keys(board).filter((k) => !before.has(k));
        trace.push({ agent: agent.name, question: agent.question, status: 'ok', ms, notes, produced });
        bus.emit('agent.step', { runId, agent: agent.name, action: agent.question, ms });
        metrics.histogram('lumen_agent_step_ms').observe(ms, { agent: agent.name });
      } catch (e) {
        const ms = Math.round(performance.now() - stepStart);
        const error = e instanceof Error ? e.message : String(e);
        trace.push({ agent: agent.name, question: agent.question, status: 'failed', ms, notes, produced: [], error });
        logger.warn('agent failed', { runId, agent: agent.name, err: error });
        // One agent failing must not take the run down: later agents may still
        // produce something useful from what is already on the board.
      }
    }

    const routerSpend = this.app.router.stats().spendUsd;
    spent = round(Math.max(0, routerSpend - (seed.__spendAtStart as number ?? routerSpend)), 6);

    const ms = Math.round(performance.now() - t0);
    const output = (opts.outputKey ? board[opts.outputKey] : board) as T;
    const ok = trace.every((s) => s.status !== 'failed');

    this.app.db.run(
      'UPDATE agent_runs SET status=?, output=?, trace=?, cost_usd=?, steps=?, ended_at=?, ms=? WHERE id=?',
      [ok ? 'done' : 'partial', JSON.stringify(output ?? null), JSON.stringify(trace),
        spent, trace.length, new Date().toISOString(), ms, runId],
    );
    bus.emit('agent.run.finished', { runId, ok, ms, steps: trace.length });

    return {
      runId, kind, ok, output, trace, board, ms, costUsd: spent,
      agentsRun: trace.filter((s) => s.status === 'ok').length,
      agentsSkipped: trace.filter((s) => s.status === 'skipped').length,
    };
  }

  history(limit = 30) {
    return this.app.db.all(
      'SELECT id, kind, status, steps, cost_usd, ms, started_at FROM agent_runs ORDER BY started_at DESC LIMIT ?',
      [limit],
    );
  }

  get(runId: string) {
    const row = this.app.db.one<{ trace: string; output: string; input: string }>(
      'SELECT * FROM agent_runs WHERE id=?', [runId],
    );
    if (!row) return undefined;
    return {
      ...row,
      input: JSON.parse(row.input || '{}'),
      output: row.output ? JSON.parse(row.output) : null,
      trace: JSON.parse(row.trace || '[]'),
    };
  }
}

/** Order agents so every `requires` is produced before it is needed. */
export function topoOrder(agents: Agent[]): Agent[] {
  const produced = new Map<string, string>();
  for (const a of agents) for (const p of a.provides) produced.set(p, a.name);

  const byName = new Map(agents.map((a) => [a.name, a]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: Agent[] = [];

  const visit = (a: Agent): void => {
    if (visited.has(a.name)) return;
    if (visiting.has(a.name)) return;    // cycle: leave the order as declared
    visiting.add(a.name);
    for (const r of a.requires) {
      const producer = produced.get(r);
      if (producer && producer !== a.name) {
        const dep = byName.get(producer);
        if (dep) visit(dep);
      }
    }
    visiting.delete(a.name);
    visited.add(a.name);
    out.push(a);
  };

  for (const a of agents) visit(a);
  return out;
}
