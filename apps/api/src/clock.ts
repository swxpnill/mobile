/** Injectable clock: the only thing in the API that reads the system time. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
