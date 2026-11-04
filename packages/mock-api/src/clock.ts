/** Injectable clock. The only place in the mock that reads the system time. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function createFakeClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function fromIso(iso: string): number {
  return Date.parse(iso);
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;
