import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
  if (env.NODE_ENV === 'production' && env.OTP_PROVIDER === 'dev') {
    throw new Error('Dev OTP provider is not allowed in production');
  }
  return env;
}
