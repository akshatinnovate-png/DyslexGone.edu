import { logger } from './logger.js';
import { id } from './ids.js';

/** Every meaningful thing the OS does emits one of these. Drives analytics,
 *  the adaptation loop, webhooks and the live session stream. */
export interface DomainEventMap {
  'document.ingested': { documentId: string; conceptIds: string[]; words: number; grade: number };
  'concept.created': { conceptId: string; label: string };
  'graph.edge.created': { from: string; to: string; kind: string };
  'learner.created': { learnerId: string; grade: number };
  'learner.mastery.updated': { learnerId: string; conceptId: string; before: number; after: number; reason: string };
  'learner.modality.updated': { learnerId: string; modality: string; reward: number };
  'learner.load.high': { learnerId: string; load: number };
  'learner.frustration.detected': { learnerId: string; signals: string[]; score: number };
  'misconception.detected': { learnerId: string; conceptId: string; misconceptionId: string; confidence: number };
  'misconception.repaired': { learnerId: string; misconceptionId: string };
  'lesson.generated': { lessonId: string; conceptId: string; modality: string; learnerId?: string };
  'lesson.verified': { lessonId: string; verdict: string; score: number };
  'experience.delivered': { learnerId: string; experienceId: string; kind: string };
  'response.recorded': { learnerId: string; itemId: string; correct: boolean; latencyMs: number };
  'session.started': { sessionId: string; learnerId: string };
  'session.step': { sessionId: string; step: number; action: string };
  'session.ended': { sessionId: string; reason: string; itemsDelivered: number };
  'experiment.assigned': { experimentId: string; learnerId: string; arm: string };
  'experiment.observed': { experimentId: string; arm: string; reward: number };
  'experiment.concluded': { experimentId: string; winner: string; probability: number };
  'agent.step': { runId: string; agent: string; action: string; ms: number };
  'agent.run.finished': { runId: string; ok: boolean; ms: number; steps: number };
  'llm.call': { provider: string; model: string; tokensIn: number; tokensOut: number; costUsd: number; cached: boolean };
  'safety.flagged': { kind: string; severity: string; detail: string };
  'knowledge.decayed': { learnerId: string; conceptId: string; retention: number };
  'prereq.gap.found': { learnerId: string; targetConceptId: string; gapConceptIds: string[] };
}

export type DomainEventName = keyof DomainEventMap;
export type DomainEvent<K extends DomainEventName = DomainEventName> = {
  id: string;
  name: K;
  at: string;
  payload: DomainEventMap[K];
};

type Handler<K extends DomainEventName> = (e: DomainEvent<K>) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Set<Handler<DomainEventName>>>();
  private wildcards = new Set<(e: DomainEvent) => void | Promise<void>>();
  private ring: DomainEvent[] = [];
  private counters = new Map<string, number>();

  constructor(private readonly ringSize = 1000) {}

  on<K extends DomainEventName>(name: K, h: Handler<K>): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(h as Handler<DomainEventName>);
    this.handlers.set(name, set);
    return () => { set.delete(h as Handler<DomainEventName>); };
  }

  onAny(h: (e: DomainEvent) => void | Promise<void>): () => void {
    this.wildcards.add(h);
    return () => { this.wildcards.delete(h); };
  }

  emit<K extends DomainEventName>(name: K, payload: DomainEventMap[K]): DomainEvent<K> {
    const evt: DomainEvent<K> = { id: id('evt'), name, at: new Date().toISOString(), payload };
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
    this.ring.push(evt as DomainEvent);
    if (this.ring.length > this.ringSize) this.ring.shift();

    const run = (fn: (e: never) => void | Promise<void>) => {
      try {
        const r = fn(evt as never);
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch((e) => logger.warn('event handler rejected', { name, err: String(e) }));
        }
      } catch (e) {
        logger.warn('event handler threw', { name, err: String(e) });
      }
    };
    for (const h of this.handlers.get(name) ?? []) run(h as (e: never) => void);
    for (const h of this.wildcards) run(h as (e: never) => void);
    return evt;
  }

  recent(limit = 50, filter?: DomainEventName | DomainEventName[]): DomainEvent[] {
    const names = filter ? new Set(Array.isArray(filter) ? filter : [filter]) : null;
    const src = names ? this.ring.filter((e) => names.has(e.name)) : this.ring;
    return src.slice(-limit).reverse();
  }

  stats(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort((a, b) => b[1] - a[1]));
  }

  /** Async iterator for SSE / websocket fan-out. */
  stream(signal?: AbortSignal): AsyncIterableIterator<DomainEvent> {
    const queue: DomainEvent[] = [];
    let resolveNext: ((v: IteratorResult<DomainEvent>) => void) | null = null;
    let done = false;

    const off = this.onAny((e) => {
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: e, done: false }); }
      else { queue.push(e); if (queue.length > 512) queue.shift(); }
    });
    const finish = () => {
      if (done) return;
      done = true;
      off();
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined as never, done: true }); }
    };
    signal?.addEventListener('abort', finish, { once: true });

    return {
      [Symbol.asyncIterator]() { return this; },
      next(): Promise<IteratorResult<DomainEvent>> {
        if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
        if (done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => { resolveNext = resolve; });
      },
      return(): Promise<IteratorResult<DomainEvent>> {
        finish();
        return Promise.resolve({ value: undefined as never, done: true });
      },
      throw(e?: unknown): Promise<IteratorResult<DomainEvent>> {
        finish();
        return Promise.reject(e);
      },
    };
  }
}

export const bus = new EventBus();
