import {
  type CloseKind,
  DEFAULT_TENANT_SETTINGS,
  type Length,
  type OrderType,
  type PartyType,
  type PricingMethod,
  SAMPLE_MASTERS,
  SAMPLE_WORLD,
  type TruckState,
  type Role,
  type TenantSettings,
  type TokenPair,
  type UnitBasis,
} from '@tonnage/shared';
import { type Clock, toIso } from './clock.ts';

/** Bump when the shape of `MockState` changes; older snapshots are discarded for the seed. */
export const SNAPSHOT_VERSION = 3;
export const DEFAULT_STORAGE_KEY = 'tonnage.mockState';
const PERSIST_DEBOUNCE_MS = 250;

export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

// All records are plain JSON data (ISO strings for timestamps) so they snapshot and redact safely.
export interface TenantRec {
  id: string;
  name: string;
  settings: TenantSettings;
  createdAt: string;
}
export interface CompanyRec {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  gstin: string | null;
  orderPrefix: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface PlantRec {
  id: string;
  tenantId: string;
  companyId: string;
  name: string;
  location: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface UserRec {
  id: string;
  tenantId: string;
  name: string;
  mobile: string;
  role: Role;
  plantIds: string[];
  active: boolean;
  version: number;
  preferences: { unitBasis: UnitBasis };
  invitedAt: string;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Per-mobile OTP state (kept for unknown numbers too, so responses never reveal existence). */
export interface OtpRec {
  issuedAt: string | null;
  consumed: boolean;
  failures: number;
  lockedUntil: string | null;
}
export interface AccessTokenRec {
  userId: string;
  deviceId: string;
  expiresAt: string;
}
export interface RefreshTokenRec {
  userId: string;
  deviceId: string;
  expiresAt: string;
  revokedAt: string | null;
  /** Set when this token was exchanged; `successor` is replayed during the grace window. */
  rotatedAt: string | null;
  successor: TokenPair | null;
}
export interface IdempotencyRec {
  route: string;
  status: number;
  body: unknown;
  createdAt: string;
}
export interface ActivityRec {
  id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  meta?: Record<string, unknown>;
  at: string;
}

export interface PartyRec {
  id: string;
  tenantId: string;
  type: PartyType;
  name: string;
  gstin: string | null;
  city: string;
  defaultCommissionPerMt: number | null;
  paymentTermsText: string;
  isSelfTransporter: boolean;
  contacts: {
    id: string;
    name: string;
    roleLabel: string;
    numbers: { id: string; number: string; label: string; whatsapp: boolean }[];
  }[];
  addresses: { id: string; kind: 'bill_to' | 'ship_to'; label: string; address: string; isDefault: boolean }[];
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProductRec {
  id: string;
  tenantId: string;
  category: string;
  grade: string;
  sizeLabel: string;
  conversionPerMt: number;
  standardLengths: Length[];
  companyIds: string[];
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface OrderRec {
  id: string;
  tenantId: string;
  number: string;
  type: OrderType;
  customerId: string | null;
  brokerId: string | null;
  /** Broker commission fixed at booking (§5.4); null without a broker. */
  commissionPerMtSnapshot: number | null;
  billToId: string | null;
  shipToId: string | null;
  pricingMethod: PricingMethod;
  basicRate: number | null;
  notify: { customer: boolean; broker: boolean };
  /** How many sub-order suffixes were ever handed out (A = 1); removed ones are not reused. */
  suffixesUsed: number;
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface SubOrderRec {
  id: string;
  tenantId: string;
  orderId: string;
  companyId: string;
  /** "A", "B" … in the order companies were added; never reused within an order. */
  suffix: string;
  closeKind: CloseKind | null;
  closeReason: string | null;
  closeNote: string | null;
  closedAt: string | null;
  closedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface OrderLineRec {
  id: string;
  tenantId: string;
  subOrderId: string;
  productId: string;
  length: Length;
  orderedKg: number;
  basicRateSnapshot: number | null;
  conversionSnapshot: number;
  rate: number;
  rateEdited: boolean;
  overpricePerMt: number;
  closedKg: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}
/** Minimal truck (F2): created by fixtures and the demo seed; F3 adds assignment and weighing. */
export interface TruckRec {
  id: string;
  tenantId: string;
  subOrderId: string;
  plantId: string;
  vehicleNo: string;
  state: TruckState;
  tareKg: number | null;
  plan: { orderLineId: string; plannedKg: number }[];
  allocations: { orderLineId: string; netKg: number }[];
  dispatchedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface DraftRec {
  id: string;
  tenantId: string;
  createdBy: string;
  payload: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}
/** Row-locked counter in B2 (number_series); keyed per tenant, series and financial year. */
export interface NumberSeriesRec {
  tenantId: string;
  key: string;
  fy: string;
  next: number;
}

export interface MockState {
  schemaVersion: number;
  tenants: TenantRec[];
  companies: CompanyRec[];
  plants: PlantRec[];
  users: UserRec[];
  otp: Record<string, OtpRec>;
  accessTokens: Record<string, AccessTokenRec>;
  refreshTokens: Record<string, RefreshTokenRec>;
  /** Keyed by `${userId}:${idempotencyKey}`. */
  idempotency: Record<string, IdempotencyRec>;
  activity: ActivityRec[];
  parties: PartyRec[];
  products: ProductRec[];
  orders: OrderRec[];
  subOrders: SubOrderRec[];
  orderLines: OrderLineRec[];
  trucks: TruckRec[];
  drafts: DraftRec[];
  numberSeries: NumberSeriesRec[];
}

export function emptyState(): MockState {
  return {
    schemaVersion: SNAPSHOT_VERSION,
    tenants: [],
    companies: [],
    plants: [],
    users: [],
    otp: {},
    accessTokens: {},
    refreshTokens: {},
    idempotency: {},
    activity: [],
    parties: [],
    products: [],
    orders: [],
    subOrders: [],
    orderLines: [],
    trucks: [],
    drafts: [],
    numberSeries: [],
  };
}

/** Fresh state from `SAMPLE_WORLD` (deep-copied; the fixture is never mutated). */
export function seedState(clock: Clock): MockState {
  const now = toIso(clock.now());
  const w = SAMPLE_WORLD;
  const tenantId = w.tenant.id;
  const s = emptyState();
  s.tenants.push({
    id: tenantId,
    name: w.tenant.name,
    settings: { ...DEFAULT_TENANT_SETTINGS },
    createdAt: now,
  });
  for (const c of w.companies) {
    s.companies.push({ ...c, tenantId, active: true, version: 1, createdAt: now, updatedAt: now });
  }
  for (const p of w.plants) {
    s.plants.push({ ...p, tenantId, active: true, version: 1, createdAt: now, updatedAt: now });
  }
  for (const u of w.users) {
    s.users.push({
      id: u.id,
      tenantId,
      name: u.name,
      mobile: u.mobile,
      role: u.role,
      plantIds: [...u.plantIds],
      active: true,
      version: 1,
      preferences: { unitBasis: 'mt' },
      invitedAt: now,
      lastSeenAt: u.status === 'invited' ? null : now,
      createdAt: now,
      updatedAt: now,
    });
  }
  seedMasters(s, tenantId, now);
  return s;
}

function seedMasters(s: MockState, tenantId: string, now: string): void {
  const companyIdByCode = new Map(SAMPLE_WORLD.companies.map((c) => [c.code, c.id]));
  const stamp = { tenantId, active: true, version: 1, createdAt: now, updatedAt: now };
  for (const p of SAMPLE_MASTERS.parties) {
    s.parties.push({
      ...stamp,
      ...p,
      contacts: p.contacts.map((c) => ({ ...c, numbers: c.numbers.map((n) => ({ ...n })) })),
      addresses: p.addresses.map((a) => ({ ...a })),
    });
  }
  for (const { companyCodes, ...p } of SAMPLE_MASTERS.products) {
    s.products.push({
      ...stamp,
      ...p,
      standardLengths: p.standardLengths.map((l) => ({ ...l })),
      companyIds: companyCodes.map((code) => {
        const id = companyIdByCode.get(code);
        if (!id) throw new Error(`unknown company code in sample products: ${code}`);
        return id;
      }),
    });
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses a stored snapshot; returns null for anything malformed or from another schema version. */
export function parseSnapshot(raw: string | null): MockState | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || v.schemaVersion !== SNAPSHOT_VERSION) return null;
  const arrays = [
    'tenants',
    'companies',
    'plants',
    'users',
    'activity',
    'parties',
    'products',
    'orders',
    'subOrders',
    'orderLines',
    'trucks',
    'drafts',
    'numberSeries',
  ] as const;
  const maps = ['otp', 'accessTokens', 'refreshTokens', 'idempotency'] as const;
  if (!arrays.every((k) => Array.isArray(v[k])) || !maps.every((k) => isObj(v[k]))) return null;
  const users = v.users as unknown[];
  if (!users.every((u) => isObj(u) && typeof u.id === 'string' && Array.isArray(u.plantIds)))
    return null;
  return v as unknown as MockState;
}

export function createMemoryStorage(initial: Record<string, string> = {}): StorageAdapter {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => Promise.resolve(data.get(key) ?? null),
    setItem: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

export interface Store {
  /** Current state; replaced wholesale by `reset()`. */
  readonly state: MockState;
  /** Debounced snapshot write (250 ms). */
  schedulePersist(): void;
  /** Immediate snapshot write; cancels a pending debounced one. */
  persistNow(): Promise<void>;
  /** Restore the seed (clears sessions, OTP state and idempotency keys) and persist it. */
  reset(): Promise<void>;
}

export async function createStore(opts: {
  storage: StorageAdapter;
  storageKey: string;
  clock: Clock;
  /** Builds a fresh state (initial load without a snapshot, and Reset). Default: `seedState`. */
  seed?: (clock: Clock) => MockState;
}): Promise<Store> {
  const { storage, storageKey, clock } = opts;
  const seed = opts.seed ?? seedState;
  let raw: string | null = null;
  try {
    raw = await storage.getItem(storageKey);
  } catch {
    raw = null;
  }
  let state = parseSnapshot(raw) ?? seed(clock);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = async () => {
    try {
      await storage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Persistence is best effort for demo data; the in-memory state stays authoritative.
    }
  };
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    get state() {
      return state;
    },
    schedulePersist() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        void write();
      }, PERSIST_DEBOUNCE_MS);
    },
    async persistNow() {
      cancel();
      await write();
    },
    async reset() {
      state = seed(clock);
      cancel();
      await write();
    },
  };
}
