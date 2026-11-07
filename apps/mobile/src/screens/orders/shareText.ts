import { type Order, type UnitBasis, formatLength, toDisplayQty } from '@tonnage/shared';

/**
 * WhatsApp summary for customers and brokers. Uses the business's `externalUnitBasis`, never the
 * sender's own preference, so outside parties always read one unit (spec §5.6). No prices: it is
 * a dispatch status, and a forwarded message must not leak rates.
 */
export function shareText(o: Order, basis: UnitBasis): string {
  const q = (kg: number) => toDisplayQty(kg, basis, { withUnit: true });
  const bare = (kg: number) => toDisplayQty(kg, basis);
  const who = o.customer?.name ?? (o.broker ? `${o.broker.name} (broker order)` : 'Order');
  const lines = [`Order ${o.number} · ${who}`];
  if (o.shipTo) lines.push(`Ship to ${o.shipTo.label}, ${o.shipTo.address}`);
  for (const s of o.subOrders) {
    lines.push('', `${s.companyName} (${s.number})`);
    for (const l of s.lines) {
      lines.push(
        `• ${l.productName} · ${formatLength(l.length)}: ${bare(l.dispatchedKg)} of ${q(l.orderedKg)} dispatched, ${bare(l.pendingKg)} pending`,
      );
    }
  }
  lines.push('', `Dispatched ${q(o.totals.dispatchedKg)} · Pending ${q(o.totals.pendingKg)}`);
  return lines.join('\n');
}
