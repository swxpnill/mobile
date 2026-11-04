import {
  DEFAULT_TENANT_SETTINGS,
  SAMPLE_WORLD,
  type Role,
  type TenantSettings,
  type TokenPair,
  type UnitBasis,
} from '@tonnage/shared';
import { type Clock, toIso } from './clock.ts';

/** Bump when the shape of `MockState` changes; older snapshots are discarded for the seed. */
export const SNAPSHOT_VERSION = 1;
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
  return s;
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
  const arrays = ['tenants', 'companies', 'plants', 'users', 'activity'] as const;
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
}): Promise<Store> {
  const { storage, storageKey, clock } = opts;
  let raw: string | null = null;
  try {
    raw = await storage.getItem(storageKey);
  } catch {
    raw = null;
  }
  let state = parseSnapshot(raw) ?? seedState(clock);
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
      state = seedState(clock);
      cancel();
      await write();
    },
  };
}
