import { type UnitBasis, clampLineKg, parseQtyInput, toDisplayQty } from '@tonnage/shared';

/** An open order line the sheet can ask for. */
export type RvLine = { id: string; subOrderId: string; pendingKg: number };
export type RvMaterial = 'all' | 'company' | 'lines';
/** Who is asked: a party, and one of its numbers (null when the party has none saved). */
export type RvRecipient = { partyId: string; contactId: string | null; numberId: string | null };

export type RvState = {
  lines: RvLine[];
  recipient: RvRecipient | null;
  material: RvMaterial;
  /** The sub-order "One company" asks for. */
  subOrderId: string | null;
  /** Pick lines: each line ticked or not, with its kg. */
  picks: Record<string, { on: boolean; kg: number }>;
  /** What is in a quantity field while it is being typed (otherwise the field shows its kg). */
  texts: Record<string, string>;
  message: string;
  /** The last message built from the choices. */
  composed: string;
  messageEdited: boolean;
  /** Edited, and the choices changed since: "Update message" is offered. */
  messageStale: boolean;
};

export type RvAction =
  | { type: 'lines'; lines: RvLine[] }
  | { type: 'recipient'; recipient: RvRecipient | null }
  | { type: 'material'; material: RvMaterial }
  | { type: 'subOrder'; subOrderId: string }
  | { type: 'toggleLine'; lineId: string }
  | { type: 'lineText'; lineId: string; text: string; basis: UnitBasis }
  | { type: 'lineBlur'; lineId: string }
  | { type: 'compose'; text: string }
  | { type: 'editMessage'; text: string }
  | { type: 'refreshMessage' };

const allAtPending = (lines: RvLine[]) => Object.fromEntries(lines.map((l) => [l.id, { on: true, kg: l.pendingKg }]));

/** All pending, every open line at its pending; a prefill (an open request) goes straight to Pick lines. */
export function initRequestState(lines: RvLine[], prefill?: { lines: { orderLineId: string; kg: number }[] }): RvState {
  const base: RvState = {
    lines,
    recipient: null,
    material: 'all',
    subOrderId: lines[0]?.subOrderId ?? null,
    picks: allAtPending(lines),
    texts: {},
    message: '',
    composed: '',
    messageEdited: false,
    messageStale: false,
  };
  if (!prefill) return base;
  const asked = new Map(prefill.lines.map((l) => [l.orderLineId, l.kg]));
  const picks = Object.fromEntries(
    lines.map((l) => {
      const kg = clampLineKg(asked.get(l.id) ?? 0, l.pendingKg);
      return [l.id, kg > 0 ? { on: true, kg } : { on: false, kg: l.pendingKg }];
    }),
  );
  return { ...base, material: 'lines', picks };
}

/** What would be asked for now, in line order: only lines above 0 kg. */
export function selection(s: RvState): { orderLineId: string; kg: number }[] {
  const out: { orderLineId: string; kg: number }[] = [];
  for (const l of s.lines) {
    let kg = 0;
    if (s.material === 'all') kg = l.pendingKg;
    else if (s.material === 'company') kg = l.subOrderId === s.subOrderId ? l.pendingKg : 0;
    else {
      const p = s.picks[l.id];
      kg = p?.on ? clampLineKg(p.kg, l.pendingKg) : 0;
    }
    if (kg > 0) out.push({ orderLineId: l.id, kg });
  }
  return out;
}

export const totalKg = (s: RvState): number => selection(s).reduce((n, l) => n + l.kg, 0);

/**
 * What may be in a quantity field, or null for a negative (clamped to 0, Review Focus 4).
 * MT: digits and one decimal point, at most 3 decimals; a comma is a decimal comma, unless a
 * point is there too (then commas group thousands, as the app shows "1,234.500").
 * kg: digits and grouping commas (parseQtyInput drops them); anything after a point is cut.
 */
function sanitizeQty(text: string, basis: UnitBasis): string | null {
  if (text.includes('-')) return null;
  if (basis === 'kg') return (text.split('.')[0] ?? '').replace(/[^\d,]/g, '');
  const pointed = text.includes('.') ? text.replace(/,/g, '') : text.replace(/,/g, '.');
  const [whole = '', ...rest] = pointed.replace(/[^\d.]/g, '').split('.');
  return rest.length === 0 ? whole : `${whole}.${rest.join('').slice(0, 3)}`;
}

function without<V>(record: Record<string, V>, key: string): Record<string, V> {
  const out = { ...record };
  delete out[key];
  return out;
}

export function requestVehicleReducer(s: RvState, a: RvAction): RvState {
  switch (a.type) {
    case 'lines': {
      // A refetch: lines may have gone (dispatched, closed) or have less pending now.
      const picks: RvState['picks'] = {};
      for (const l of a.lines) {
        const p = s.picks[l.id] ?? { on: s.material === 'all', kg: l.pendingKg };
        picks[l.id] = { on: p.on, kg: clampLineKg(p.kg, l.pendingKg) };
      }
      const subOrderId = a.lines.some((l) => l.subOrderId === s.subOrderId) ? s.subOrderId : (a.lines[0]?.subOrderId ?? null);
      return { ...s, lines: a.lines, picks, subOrderId };
    }
    case 'recipient':
      return { ...s, recipient: a.recipient };
    case 'material': {
      if (a.material === s.material) return s;
      if (a.material !== 'lines') return { ...s, material: a.material, texts: {} };
      // Pick lines starts from what was selected: those lines ticked at their kg, the rest off.
      const chosen = new Map(selection(s).map((l) => [l.orderLineId, l.kg]));
      const picks = Object.fromEntries(
        s.lines.map((l) => [l.id, chosen.has(l.id) ? { on: true, kg: chosen.get(l.id)! } : { on: false, kg: l.pendingKg }]),
      );
      return { ...s, material: 'lines', picks, texts: {} };
    }
    case 'subOrder':
      return { ...s, subOrderId: a.subOrderId };
    case 'toggleLine': {
      const line = s.lines.find((l) => l.id === a.lineId);
      const p = s.picks[a.lineId];
      if (!line || !p) return s;
      const next = p.on ? { on: false, kg: p.kg } : { on: true, kg: p.kg > 0 ? p.kg : line.pendingKg };
      return { ...s, picks: { ...s.picks, [a.lineId]: next }, texts: without(s.texts, a.lineId) };
    }
    case 'lineText': {
      const line = s.lines.find((l) => l.id === a.lineId);
      if (!line) return s;
      const text = sanitizeQty(a.text, a.basis);
      if (text === null) return { ...s, picks: { ...s.picks, [a.lineId]: { on: false, kg: 0 } }, texts: { ...s.texts, [a.lineId]: '0' } };
      const parsed = parseQtyInput(text, a.basis);
      const typed = parsed.ok ? parsed.value : 0;
      const kg = clampLineKg(typed, line.pendingKg);
      // Above pending: the field shows the pending it was clamped to.
      const shown = typed > kg ? toDisplayQty(kg, a.basis) : text;
      return { ...s, picks: { ...s.picks, [a.lineId]: { on: kg > 0, kg } }, texts: { ...s.texts, [a.lineId]: shown } };
    }
    case 'lineBlur':
      return { ...s, texts: without(s.texts, a.lineId) };
    case 'compose':
      if (a.text === s.composed) return s;
      return s.messageEdited ? { ...s, composed: a.text, messageStale: true } : { ...s, composed: a.text, message: a.text };
    case 'editMessage':
      return { ...s, message: a.text, messageEdited: true, messageStale: false };
    case 'refreshMessage':
      return { ...s, message: s.composed, messageEdited: false, messageStale: false };
  }
}
