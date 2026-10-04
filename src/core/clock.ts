/** Injectable clock so the twin/scheduler logic is testable without sleeping. */
export interface Clock {
  now(): number;
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

export function fixedClock(startMs: number): Clock & { advance(ms: number): void; set(ms: number): void } {
  let t = startMs;
  return {
    now: () => t,
    iso: () => new Date(t).toISOString(),
    advance: (ms: number) => { t += ms; },
    set: (ms: number) => { t = ms; },
  };
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const MINUTE = 60_000;
