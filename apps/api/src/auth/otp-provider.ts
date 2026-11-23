import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../env.ts';

/** Sends one-time codes. The dev provider is the only one in B1; a real SMS provider comes later. */
export interface OtpProvider {
  send(mobile: string, code: string): Promise<void>;
}

/** The code a new challenge gets. With the dev provider it is always `DEV_OTP_CODE`. */
export function newOtpCode(env: Pick<Env, 'OTP_PROVIDER' | 'DEV_OTP_CODE'>): string {
  // `loadEnv` refuses `dev` in production. A real provider will draw `crypto.randomInt` here.
  return env.DEV_OTP_CODE;
}

/** Texts nothing: logs the number only (never the code), so a developer can see a code was asked for. */
export class DevOtpProvider implements OtpProvider {
  constructor(private readonly log: FastifyBaseLogger) {}

  async send(mobile: string): Promise<void> {
    this.log.info({ mobile }, 'dev OTP provider: code issued');
  }
}
