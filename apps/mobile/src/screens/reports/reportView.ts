import {
  type Report,
  type UnitBasis,
  formatRupees,
  formatRupeesShort,
  groupIndian,
  toDisplayQty,
  unitLabel,
  variancePercentTenths,
} from '@tonnage/shared';
import { dateLabel } from '../../format/time';
import { shortCompanyName } from '../../nav/roles';
import type { Tokens } from '../../theme/tokens';
import { dueText } from '../money/BrokerDuesScreen';
import { REPORT_META } from './reportMeta';

/** One of the three numbers at the top of the preview card. */
export interface Stat {
  label: string;
  value: string;
  caption: string;
  color: keyof Tokens;
}

/** A company line of the register / unit sales table (board 23). */
export interface CompanyLine {
  key: string;
  label: string;
  code: string;
  netKg: number;
  trucks: number;
}

/** A line of the other reports' preview list. */
export interface ListLine {
  key: string;
  title: string;
  caption: string;
  value: string;
  valueCaption?: string;
  valueColor?: keyof Tokens;
}

export interface ReportView {
  stats: [Stat, Stat, Stat];
  /** Register and unit sales: per company, with the total. */
  table: { lines: CompanyLine[]; netKg: number; trucks: number } | null;
  /** Every other kind: one line per report row. */
  list: ListLine[];
}

const MINUS = '−';
const plural = (n: number, one: string, many: string) => `${groupIndian(String(n))} ${n === 1 ? one : many}`;

/** "+0.800" / "−0.120" / "0.000": a signed quantity through the shared formatter. */
export function signedQty(kg: number, basis: UnitBasis): string {
  const body = toDisplayQty(Math.abs(kg), basis);
  return kg > 0 ? `+${body}` : kg < 0 ? `${MINUS}${body}` : body;
}

/** "+0.8 %" from tenths of a percent; "" without a plan. */
export function percentTenths(tenths: number | null): string {
  if (tenths === null) return '';
  const abs = Math.abs(tenths);
  const sign = tenths > 0 ? '+' : tenths < 0 ? MINUS : '';
  return `${sign}${Math.trunc(abs / 10)}.${abs % 10} %`;
}

const companyLines = (rows: { companyId: string; companyCode: string; companyName: string; netKg: number; trucks: number }[]) =>
  rows.map((c) => ({
    key: c.companyId,
    label: `${shortCompanyName(c.companyName)} · ${c.companyCode}`,
    code: c.companyCode,
    netKg: c.netKg,
    trucks: c.trucks,
  }));

/** What the preview card shows for a report, in the viewer's unit basis. */
export function reportView(r: Report, basis: UnitBasis): ReportView {
  const unit = unitLabel(basis);
  const qty = (kg: number) => toDisplayQty(kg, basis);
  const qtyU = (kg: number) => toDisplayQty(kg, basis, { withUnit: true });
  switch (r.kind) {
    case 'dispatch-register': {
      const s = r.summary;
      return {
        stats: [
          { label: 'Dispatched', value: qty(s.netKg), caption: unit, color: 'okt' },
          { label: 'Trucks', value: groupIndian(String(s.trucks)), caption: 'this period', color: 'brt' },
          { label: 'Over / under', value: signedQty(s.overUnderKg, basis), caption: `${unit} net`, color: 'wnt' },
        ],
        table: { lines: companyLines(s.byCompany), netKg: s.netKg, trucks: s.trucks },
        list: [],
      };
    }
    case 'unit-sales': {
      const s = r.summary;
      const trucks = s.byCompany.reduce((n, c) => n + c.trucks, 0);
      return {
        stats: [
          { label: 'Sold', value: qty(s.netKg), caption: unit, color: 'okt' },
          { label: 'Value', value: formatRupeesShort(s.valueRupees), caption: 'billed', color: 'brt' },
          { label: 'Trucks', value: groupIndian(String(trucks)), caption: 'this period', color: 'wnt' },
        ],
        table: { lines: companyLines(s.byCompany), netKg: s.netKg, trucks },
        list: [],
      };
    }
    case 'pending-orders': {
      const s = r.summary;
      const oldest = r.rows[0]?.ageDays;
      return {
        stats: [
          { label: 'Pending', value: qty(s.pendingKg), caption: unit, color: 'wnt' },
          { label: 'Sub-orders', value: groupIndian(String(s.subOrders)), caption: 'open', color: 'brt' },
          { label: 'Oldest', value: oldest === undefined ? '—' : String(oldest), caption: 'days', color: 'dgt' },
        ],
        table: null,
        list: r.rows.map((x) => ({
          key: x.subOrderId,
          title: x.subOrderNumber,
          caption: `${x.customerName ?? 'No customer'} · ${plural(x.ageDays, 'day', 'days')}`,
          value: qtyU(x.pendingKg),
          valueCaption: `of ${qty(x.orderedKg)}`,
        })),
      };
    }
    case 'broker-wise': {
      const s = r.summary;
      return {
        stats: [
          { label: 'Earned', value: formatRupeesShort(s.earnedRupees), caption: 'this period', color: 'okt' },
          { label: 'Paid', value: formatRupeesShort(s.paidRupees), caption: 'this period', color: 'brt' },
          { label: 'Due', value: formatRupeesShort(s.dueRupees), caption: 'at period end', color: 'wnt' },
        ],
        table: null,
        list: r.rows.map((x) => {
          const due = dueText(x.dueRupees);
          return {
            key: x.brokerId,
            title: x.brokerName,
            caption: `Earned ${formatRupees(x.earnedRupees)} · Paid ${formatRupees(x.paidRupees)}`,
            value: due.text,
            valueColor: due.color,
            valueCaption: qtyU(x.netKg),
          };
        }),
      };
    }
    case 'customer-wise': {
      const s = r.summary;
      return {
        stats: [
          { label: 'Booked', value: qty(s.bookedKg), caption: unit, color: 'brt' },
          { label: 'Lifted', value: qty(s.liftedKg), caption: unit, color: 'okt' },
          { label: 'Lifted value', value: formatRupeesShort(s.liftedValueRupees), caption: 'billed', color: 'wnt' },
        ],
        table: null,
        list: r.rows.map((x) => ({
          key: x.customerId ?? 'none',
          title: x.customerName ?? 'No customer',
          caption: `Booked ${qtyU(x.bookedKg)} · Lifted ${qtyU(x.liftedKg)}`,
          value: formatRupees(x.liftedValueRupees),
          valueCaption: 'lifted',
        })),
      };
    }
    case 'product-wise': {
      const s = r.summary;
      return {
        stats: [
          { label: 'Dispatched', value: qty(s.netKg), caption: unit, color: 'okt' },
          { label: 'Trucks', value: groupIndian(String(s.trucks)), caption: 'this period', color: 'brt' },
          { label: 'Items', value: groupIndian(String(r.rows.length)), caption: 'size × length', color: 'wnt' },
        ],
        table: null,
        list: r.rows.map((x) => ({
          key: `${x.productId}:${x.lengthValue ?? ''}:${x.lengthUnit ?? ''}`,
          title: x.lengthValue === null ? x.productName : `${x.productName} · ${x.lengthValue} ${x.lengthUnit ?? ''}`.trim(),
          caption: plural(x.trucks, 'truck', 'trucks'),
          value: qtyU(x.netKg),
        })),
      };
    }
    case 'loading-variance': {
      const s = r.summary;
      return {
        stats: [
          { label: 'Trucks', value: groupIndian(String(s.trucks)), caption: 'this period', color: 'brt' },
          { label: 'Over', value: groupIndian(String(s.overTrucks)), caption: `+${qtyU(s.overKg)}`, color: 'wnt' },
          { label: 'Under', value: groupIndian(String(s.underTrucks)), caption: `${MINUS}${qtyU(s.underKg)}`, color: 'dgt' },
        ],
        table: null,
        list: r.rows.map((x) => ({
          key: x.truckId,
          title: x.vehicleNo,
          caption: `${x.plantName} · ${dateLabel(x.date, { year: false })} · plan ${qty(x.plannedKg)}`,
          value: `${signedQty(x.diffKg, basis)} ${unit}`,
          valueCaption: percentTenths(variancePercentTenths(x.diffKg, x.plannedKg)),
          valueColor: x.diffKg > 0 ? 'wnt' : x.diffKg < 0 ? 'dgt' : 'tx3',
        })),
      };
    }
  }
}

/**
 * Ruling 12: the Share button's one line, in the viewer's basis, e.g.
 * "Dispatch register · 1 – 17 Nov 2026 · 962.400 MT · 41 trucks".
 */
export function shareSummary(r: Report, basis: UnitBasis, ctx: { range: string; unitCode?: string }): string {
  const qtyU = (kg: number) => toDisplayQty(kg, basis, { withUnit: true });
  const head = [REPORT_META[r.kind].title, ...(ctx.unitCode ? [ctx.unitCode] : []), ctx.range];
  const tail = ((): string[] => {
    switch (r.kind) {
      case 'dispatch-register':
        return [qtyU(r.summary.netKg), plural(r.summary.trucks, 'truck', 'trucks')];
      case 'pending-orders':
        return [`${qtyU(r.summary.pendingKg)} pending`, plural(r.summary.subOrders, 'sub-order', 'sub-orders')];
      case 'unit-sales':
        return [qtyU(r.summary.netKg), formatRupees(r.summary.valueRupees)];
      case 'broker-wise':
        return [
          `Earned ${formatRupees(r.summary.earnedRupees)}`,
          `Paid ${formatRupees(r.summary.paidRupees)}`,
          `Due ${formatRupees(r.summary.dueRupees)}`,
        ];
      case 'customer-wise':
        return [`Booked ${qtyU(r.summary.bookedKg)}`, `Lifted ${qtyU(r.summary.liftedKg)}`];
      case 'product-wise':
        return [qtyU(r.summary.netKg), plural(r.summary.trucks, 'truck', 'trucks')];
      case 'loading-variance':
        return [
          plural(r.summary.trucks, 'truck', 'trucks'),
          `${r.summary.overTrucks} over`,
          `${r.summary.underTrucks} under`,
        ];
    }
  })();
  return [...head, ...tail].join(' · ');
}
