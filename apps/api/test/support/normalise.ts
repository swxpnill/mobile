/**
 * R2 "equals the mock": the mock and the API mint different ids for the same data, so before a
 * deep-equal every uuid (alone or inside a string, e.g. a list cursor) becomes `#N`, numbered in the
 * order it is first met. Objects are walked in sorted key order, so the numbering does not depend
 * on how either side ordered its keys. Two bodies with the same shape and the same references
 * between ids normalise to the same value; kg, ₹, statuses, numbers, timestamps (both sides share
 * one clock) and array order still compare exactly.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function normaliseIds(value: unknown, seen: Map<string, string> = new Map()): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(UUID, (id) => {
        const key = id.toLowerCase();
        let n = seen.get(key);
        if (n === undefined) {
          n = `#${seen.size + 1}`;
          seen.set(key, n);
        }
        return n;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Normalises a sequence of responses with one id map, so ids that recur across them still match. */
export function normaliseAll(values: readonly unknown[]): unknown[] {
  const seen = new Map<string, string>();
  return values.map((v) => normaliseIds(v, seen));
}
