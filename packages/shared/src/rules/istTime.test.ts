import { describe, expect, it } from 'vitest';
import { istDayStart, istWeekStart } from './istTime.ts';

const utc = (s: string) => Date.parse(s);

describe('istDayStart', () => {
  it('changes at 18:30 UTC', () => {
    const start = utc('2026-11-03T18:30:00Z'); // 00:00 IST on 4 Nov
    expect(istDayStart(start)).toBe(start);
    expect(istDayStart(start - 1)).toBe(utc('2026-11-02T18:30:00Z'));
    expect(istDayStart(start + 24 * 3_600_000 - 1)).toBe(start);
  });
});

describe('istWeekStart', () => {
  it('is Monday 00:00 IST; Sunday 23:59:59.999 IST is still the old week', () => {
    const monday = utc('2026-11-08T18:30:00Z'); // Mon 9 Nov 00:00 IST
    expect(istWeekStart(monday)).toBe(monday);
    expect(istWeekStart(monday - 1)).toBe(utc('2026-11-01T18:30:00Z')); // Mon 2 Nov
    expect(istWeekStart(utc('2026-11-03T04:30:00Z'))).toBe(utc('2026-11-01T18:30:00Z')); // Tue
    expect(istWeekStart(utc('2026-11-01T18:30:00Z'))).toBe(utc('2026-11-01T18:30:00Z')); // Mon start
  });
});
