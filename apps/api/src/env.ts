import { z } from 'zod';

const envSchema = z.object({
  /** Required, no default: a deploy that forgets it must not boot as development (dev OTP). */
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Runtime connection, as the `tonnage_app` role (never an owner, never BYPASSRLS). */
  DATABASE_URL: z.string().min(1),
  /** Migration connection, as the schema owner. */
  MIGRATION_DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  OTP_PROVIDER: z.enum(['dev']).default('dev'),
  DEV_OTP_CODE: z.string().default('123456'),
  MIN_SUPPORTED_APP_VERSION: z.string().default('1.0.0'),
  RATE_LIMIT: z.enum(['on', 'off']).default('on'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** How long a request's transaction waits for a row lock before giving up (503 BUSY). */
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(5_000),
  /** The longest any one statement of a request's transaction may run. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1).default(15_000),
});

export type Env = z.infer<typeof envSchema>;

/** Parses and validates the process environment. Throws (so the API refuses to boot) on anything wrong. */
export function loadEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment: ${lines.join('; ')}`);
  }
  const env = parsed.data;
  // Allow-list, not deny-list: the fixed-code provider only where NODE_ENV says so explicitly.
  const devOtpAllowed = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  if (env.OTP_PROVIDER === 'dev' && !devOtpAllowed) {
    throw new Error('Dev OTP provider is not allowed in production');
  }
  return env;
}
