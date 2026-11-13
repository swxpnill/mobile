import { istGreeting, istLongDate, relativeTime } from '../src/format/time';

const at = (iso: string) => Date.parse(iso);

describe('IST time helpers', () => {
  it('greets by the hour in India, not UTC', () => {
    expect(istGreeting(at('2026-11-03T04:30:00Z'))).toBe('Good morning'); // 10:00 IST
    expect(istGreeting(at('2026-11-03T08:30:00Z'))).toBe('Good afternoon'); // 14:00 IST
    expect(istGreeting(at('2026-11-03T13:30:00Z'))).toBe('Good evening'); // 19:00 IST
    expect(istGreeting(at('2026-11-02T20:00:00Z'))).toBe('Good morning'); // 01:30 IST next day
  });

  it('long date like the canvas: Tuesday, 3 November', () => {
    expect(istLongDate(at('2026-11-03T04:30:00Z'))).toBe('Tuesday, 3 November');
    expect(istLongDate(at('2026-11-02T19:00:00Z'))).toBe('Tuesday, 3 November'); // already 3 Nov in IST
  });

  it('relative: just now, minutes, hours, Yesterday, then the date', () => {
    const now = at('2026-11-03T04:30:00Z'); // 3 Nov 10:00 IST
    expect(relativeTime('2026-11-03T04:29:40Z', now)).toBe('just now');
    expect(relativeTime('2026-11-03T04:12:00Z', now)).toBe('18 min ago');
    expect(relativeTime('2026-11-03T02:30:00Z', now)).toBe('2 h ago');
    expect(relativeTime('2026-11-02T10:00:00Z', now)).toBe('Yesterday');
    expect(relativeTime('2026-10-31T06:00:00Z', now)).toBe('31 Oct');
    expect(relativeTime('2025-10-31T06:00:00Z', now)).toBe('31 Oct 2025');
  });

  it('a time just after midnight IST counts as today, not yesterday', () => {
    const now = at('2026-11-03T04:30:00Z');
    expect(relativeTime('2026-11-02T18:40:00Z', now)).toBe('9 h ago'); // 00:10 IST on 3 Nov
  });
});
