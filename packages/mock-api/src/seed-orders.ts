import {
  type Length,
  type OrderType,
  type PricingMethod,
  type ShortCloseReason,
  SAMPLE_MASTERS,
  SAMPLE_WORLD,
  financialYear,
  formatOrderNumber,
  lineRate,
  subOrderSuffix,
} from '@tonnage/shared';
import { type Clock, DAY, MINUTE, toIso } from './clock.ts';
import { orderMath } from './orders-math.ts';
import type { MockState, OrderLineRec } from './store.ts';
import { addTruck } from './trucks.ts';
import { newId } from './views.ts';

const HOUR = 60 * MINUTE;
const P = SAMPLE_MASTERS.ids.parties;
const PR = SAMPLE_MASTERS.ids.products;
const A = SAMPLE_MASTERS.ids.addresses;
const U = SAMPLE_WORLD.ids.users;

interface DemoLine {
  product: string;
  length: Length;
  kg: number;
  typedRate?: number;
  overprice?: number;
}
interface DemoTruck {
  vehicleNo: string;
  state: 'assigned' | 'at_gate' | 'loading' | 'dispatched';
  /** Time of its latest step (assignment, gate, tare or dispatch). */
  agoMs: number;
  tareKg?: number;
  /** Line index → net kg (dispatched) or planned kg (open). Dispatched trucks were planned at net. */
  kg: Record<number, number>;
  transporter: string | null;
  driver: [name: string, phone: string];
  lrNo?: string;
}

/** Who weighs at each plant in the demo (Tilda's supervisor has not signed in yet: the owner did). */
const WEIGHER: Record<'AIP' | 'VSL' | 'KRM' | 'NAP', { userId: string; deviceId: string }> = {
  AIP: { userId: U.ravi, deviceId: 'demo-phone-siltara' },
  VSL: { userId: U.mohan, deviceId: 'demo-phone-urla' },
  KRM: { userId: U.sanjay, deviceId: 'demo-phone-borai' },
  NAP: { userId: U.rajesh, deviceId: 'demo-phone-rajesh' },
};
interface DemoOrder {
  seq: number;
  agoMs: number;
  createdBy: string;
  type: OrderType;
  customer: string | null;
  broker: string | null;
  billTo: string | null;
  shipTo: string | null;
  pricing: PricingMethod;
  basicRate: number | null;
  subs: { company: 'AIP' | 'VSL' | 'KRM' | 'NAP'; lines: DemoLine[]; trucks?: DemoTruck[] }[];
  shortClose?: { reason: ShortCloseReason; agoMs: number };
}

const m = (value: number): Length => ({ value, unit: 'm' });

/** The five rows on the canvas Orders board, dated relative to "now" so ages always read right. */
const DEMO: DemoOrder[] = [
  {
    seq: 131,
    agoMs: 7 * DAY,
    createdBy: U.priya,
    type: 'customer',
    customer: P.krishna,
    broker: null,
    billTo: A.krishnaBill,
    shipTo: A.krishnaSite,
    pricing: 'direct',
    basicRate: null,
    subs: [
      {
        company: 'KRM',
        lines: [
          { product: PR.tmt8, length: m(12), kg: 24_000, typedRate: 46_000 },
          { product: PR.tmt10, length: m(12), kg: 24_000, typedRate: 46_000 },
        ],
        trucks: [
          { vehicleNo: 'CG 07 AK 3321', state: 'dispatched', agoMs: 6 * DAY, tareKg: 11_900, kg: { 0: 24_100 }, transporter: P.golden, driver: ['Imtiyaz Ali', '+919826433107'], lrNo: 'GT/1027/0311' },
          { vehicleNo: 'CG 07 BT 0912', state: 'dispatched', agoMs: 5 * DAY, tareKg: 12_240, kg: { 1: 24_140 }, transporter: P.golden, driver: ['Harish Sahu', '+919752218840'], lrNo: 'GT/1028/0324' },
        ],
      },
    ],
  },
  {
    seq: 136,
    agoMs: 6 * DAY,
    createdBy: U.rajesh,
    type: 'customer_broker',
    customer: P.gupta,
    broker: P.rkAgarwal,
    billTo: A.guptaBill,
    shipTo: A.guptaShop,
    pricing: 'direct',
    basicRate: null,
    subs: [
      {
        company: 'NAP',
        lines: [{ product: PR.ingot, length: m(1), kg: 42_000, typedRate: 42_000 }],
        trucks: [
          { vehicleNo: 'CG 04 NB 5510', state: 'dispatched', agoMs: 5 * DAY, tareKg: 11_400, kg: { 0: 15_100 }, transporter: P.shreeGanesh, driver: ['Ramesh Yadav', '+919827144012'], lrNo: 'SGR/2610/0388' },
          { vehicleNo: 'CG 04 NB 7702', state: 'dispatched', agoMs: 3 * DAY, tareKg: 11_620, kg: { 0: 15_100 }, transporter: P.shreeGanesh, driver: ['Dinesh Patel', '+919893320415'], lrNo: 'SGR/2610/0402' },
        ],
      },
    ],
    shortClose: { reason: 'Customer stopped lifting', agoMs: 1 * DAY },
  },
  {
    seq: 139,
    agoMs: 3 * DAY,
    createdBy: U.priya,
    type: 'broker_only',
    customer: null,
    broker: P.mittal,
    billTo: null,
    shipTo: null,
    pricing: 'direct',
    basicRate: null,
    subs: [
      { company: 'AIP', lines: [{ product: PR.billet, length: m(6), kg: 30_000, typedRate: 42_000 }] },
      { company: 'NAP', lines: [{ product: PR.billet, length: m(6), kg: 30_000, typedRate: 42_000 }] },
    ],
  },
  {
    seq: 141,
    agoMs: 1 * DAY,
    createdBy: U.rajesh,
    type: 'customer',
    customer: P.patel,
    broker: null,
    billTo: A.patelBill,
    shipTo: A.patelSite2,
    pricing: 'direct',
    basicRate: null,
    subs: [
      {
        company: 'KRM',
        lines: [
          { product: PR.tmt16, length: m(12), kg: 40_000, typedRate: 46_500 },
          { product: PR.tmt20, length: m(12), kg: 50_000, typedRate: 46_000 },
          { product: PR.tmt25, length: m(6), kg: 30_000, typedRate: 45_800 },
        ],
        trucks: [
          { vehicleNo: 'CG 04 AB 1123', state: 'dispatched', agoMs: 20 * HOUR, tareKg: 12_100, kg: { 1: 30_120 }, transporter: P.golden, driver: ['Mahesh Dhruw', '+919425210877'], lrNo: 'GT/1102/0417' },
          { vehicleNo: 'CG 07 KL 4410', state: 'dispatched', agoMs: 6 * HOUR, tareKg: 11_860, kg: { 1: 13_880 }, transporter: null, driver: ['Sunil Netam', '+919907123345'] },
          { vehicleNo: 'CG 04 PQ 7781', state: 'dispatched', agoMs: 1 * HOUR, tareKg: 12_020, kg: { 0: 28_400 }, transporter: P.shreeGanesh, driver: ['Gopal Verma', '+919826655231'], lrNo: 'SGR/2611/0415' },
          { vehicleNo: 'CG 07 BR 8810', state: 'loading', agoMs: 42 * MINUTE, tareKg: 12_460, kg: { 2: 30_000 }, transporter: P.golden, driver: ['Rakesh Kumar', '+919617702268'] },
        ],
      },
    ],
  },
  {
    seq: 142,
    agoMs: 2 * HOUR,
    createdBy: U.rajesh,
    type: 'customer_broker',
    customer: P.shubham,
    broker: P.rkAgarwal,
    billTo: A.shubhamBill,
    shipTo: A.shubhamHingna,
    pricing: 'basic_conversion',
    basicRate: 44_500,
    subs: [
      {
        company: 'AIP',
        lines: [
          { product: PR.tmt12, length: m(12), kg: 24_000, overprice: 300 },
          { product: PR.tmt12, length: m(6), kg: 10_000 },
          { product: PR.tmt16, length: m(12), kg: 20_000, overprice: 300 },
        ],
        // Siltara right now (canvas 11): one loading, one at the gate, one on its way.
        // 10 MT of the 16 mm line stays unplanned, free to move to another company.
        trucks: [
          { vehicleNo: 'CG 04 MK 2291', state: 'loading', agoMs: 25 * MINUTE, tareKg: 12_460, kg: { 0: 24_000 }, transporter: P.shreeGanesh, driver: ['Ramesh Yadav', '+919827144012'], lrNo: 'SGR/2611/0418' },
          { vehicleNo: 'CG 07 KL 3304', state: 'at_gate', agoMs: 10 * MINUTE, kg: { 1: 10_000 }, transporter: P.golden, driver: ['Mahesh Dhruw', '+919425210877'] },
          { vehicleNo: 'CG 10 GH 4471', state: 'assigned', agoMs: 5 * MINUTE, kg: { 2: 10_000 }, transporter: null, driver: ['Sunil Netam', '+919907123345'] },
        ],
      },
      {
        company: 'KRM',
        lines: [{ product: PR.tmt16, length: { value: 40, unit: 'ft' }, kg: 30_000, typedRate: 45_600, overprice: 300 }],
      },
    ],
  },
];

/**
 * Adds the canvas demo orders (app only; contract tests start without orders). Statuses come out
 * of the trucks and closes, exactly as the real flow would produce them.
 */
export function seedDemoOrders(state: MockState, clock: Clock): void {
  const now = clock.now();
  const tenant = state.tenants.find((t) => t.id === SAMPLE_WORLD.ids.tenant);
  if (!tenant) throw new Error('seedDemoOrders: sample tenant missing');
  const companyIdByCode = new Map(state.companies.map((c) => [c.code, c.id]));
  const lastSeqByFy = new Map<string, number>();

  for (const d of DEMO) {
    const at = toIso(now - d.agoMs);
    const orderId = newId();
    const broker = d.broker ? state.parties.find((p) => p.id === d.broker) : undefined;
    state.orders.push({
      id: orderId,
      tenantId: tenant.id,
      number: formatOrderNumber(tenant.settings.orderNumberFormat, at, d.seq),
      type: d.type,
      customerId: d.customer,
      brokerId: d.broker,
      commissionPerMtSnapshot: broker?.defaultCommissionPerMt ?? null,
      billToId: d.billTo,
      shipToId: d.shipTo,
      pricingMethod: d.pricing,
      basicRate: d.basicRate,
      notify: { customer: true, broker: d.broker !== null },
      suffixesUsed: d.subs.length,
      createdBy: d.createdBy,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });

    d.subs.forEach((s, si) => {
      const companyId = companyIdByCode.get(s.company);
      if (!companyId) throw new Error(`seedDemoOrders: company ${s.company} missing`);
      const subId = newId();
      state.subOrders.push({
        id: subId,
        tenantId: tenant.id,
        orderId,
        companyId,
        suffix: subOrderSuffix(si),
        closeKind: null,
        closeReason: null,
        closeNote: null,
        closedAt: null,
        closedBy: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      const lines: OrderLineRec[] = s.lines.map((l) => {
        const product = state.products.find((p) => p.id === l.product);
        if (!product) throw new Error(`seedDemoOrders: product ${l.product} missing`);
        const { rate, rateEdited } = lineRate({
          method: d.pricing,
          basicRate: d.basicRate,
          conversionPerMt: product.conversionPerMt,
          typedRate: l.typedRate ?? null,
        });
        return {
          id: newId(),
          tenantId: tenant.id,
          subOrderId: subId,
          productId: product.id,
          length: { ...l.length },
          orderedKg: l.kg,
          basicRateSnapshot: d.basicRate,
          conversionSnapshot: product.conversionPerMt,
          rate,
          rateEdited,
          overpricePerMt: l.overprice ?? 0,
          closedKg: 0,
          version: 1,
          createdAt: at,
          updatedAt: at,
        };
      });
      state.orderLines.push(...lines);

      // Trucks are listed oldest first per company, so loading slips are numbered in time order.
      for (const t of s.trucks ?? []) {
        const rows = Object.entries(t.kg).map(([i, kg]) => {
          const line = lines[Number(i)];
          if (!line) throw new Error(`seedDemoOrders: no line ${i} for ${t.vehicleNo}`);
          return { orderLineId: line.id, kg };
        });
        const weigher = WEIGHER[s.company];
        addTruck(
          state,
          {
            subOrderId: subId,
            state: t.state,
            vehicleNo: t.vehicleNo,
            transporterId: t.transporter,
            driverName: t.driver[0],
            driverPhone: t.driver[1],
            lrNo: t.lrNo ?? null,
            assignedBy: d.createdBy,
            weighedBy: weigher.userId,
            deviceId: weigher.deviceId,
            ...(t.tareKg !== undefined ? { tareKg: t.tareKg } : {}),
            plan: rows.map((r) => ({ orderLineId: r.orderLineId, plannedKg: r.kg })),
            ...(t.state === 'dispatched'
              ? { allocations: rows.map((r) => ({ orderLineId: r.orderLineId, netKg: r.kg })) }
              : {}),
          },
          now - t.agoMs,
        );
      }
    });

    if (d.shortClose) {
      const closedAt = toIso(now - d.shortClose.agoMs);
      const math = orderMath(state);
      for (const sub of math.subOrdersOf(orderId)) {
        for (const line of math.linesOf(sub.id)) {
          const q = math.lineQty(line);
          line.closedKg = Math.max(0, q.orderedKg - q.dispatchedKg);
        }
        sub.closeKind = 'short_close';
        sub.closeReason = d.shortClose.reason;
        sub.closedAt = closedAt;
        sub.closedBy = U.rajesh;
      }
    }

    const fy = financialYear(at);
    lastSeqByFy.set(fy, Math.max(lastSeqByFy.get(fy) ?? 0, d.seq));
  }

  for (const [fy, last] of lastSeqByFy) {
    state.numberSeries.push({ tenantId: tenant.id, key: 'order', fy, next: last + 1 });
  }
}

