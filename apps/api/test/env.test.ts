import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.ts';

const base = {
  DATABASE_URL: 'postgres://tonnage_app:x@127.0.0.1:5432/tonnage',
  MIGRATION_DATABASE_URL: 'postgres://postgres:x@127.0.0.1:5432/tonnage',
  JWT_SECRET: 'a-secret-that-is-at-least-thirty-two-chars',
  OTP_PROVIDER: 'dev',
};

describe('loadEnv', () => {
  it('refuses the dev OTP provider in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', OTP_PROVIDER: 'dev' })).toThrow(
      'Dev OTP provider is not allowed in production',
    );
  });

  it('refuses a short JWT secret', () => {
    expect(() => loadEnv({ ...base, JWT_SECRET: 'short' })).toThrow();
  });

  it('refuses a missing database url', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('applies the defaults', () => {
    expect(loadEnv(base)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      RATE_LIMIT: 'on',
      DEV_OTP_CODE: '123456',
      MIN_SUPPORTED_APP_VERSION: '1.0.0',
      LOG_LEVEL: 'info',
    });
  });

  it('reads PORT as a number', () => {
    expect(loadEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });
});
