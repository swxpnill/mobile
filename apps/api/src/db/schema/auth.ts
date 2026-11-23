import {
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantId, timestamps, tstz } from './columns.ts';
import { tenants } from './org.ts';
import { users } from './users.ts';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** No RLS: one row per mobile, read before the tenant is known (the mock's `OtpRec`). */
export const otpChallenges = pgTable('otp_challenges', {
  mobile: text('mobile').primaryKey(),
  /** HMAC-SHA256 of `mobile:code` (key derived from JWT_SECRET), hex. Never the code itself. */
  codeHash: text('code_hash'),
  issuedAt: tstz('issued_at'),
  consumed: boolean('consumed').notNull().default(false),
  failures: integer('failures').notNull().default(0),
  lockedUntil: tstz('locked_until'),
  ...timestamps,
});

/** No RLS: looked up by hash before the tenant is known; only `src/auth` touches it. */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    /** SHA-256 of the token, hex. Never the token itself. */
    tokenHash: text('token_hash').notNull().unique('refresh_tokens_token_hash_key'),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    rotatedAt: tstz('rotated_at'),
    /** The successor pair, AES-256-GCM sealed, kept for the refresh grace window. */
    successorEnc: bytea('successor_enc'),
    ...timestamps,
  },
  (t) => [
    index('refresh_tokens_user_idx').on(t.userId),
    foreignKey({
      name: 'refresh_tokens_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);
