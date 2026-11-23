import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { tokenPairSchema, type TokenPair } from '@tonnage/shared';

/** SHA-256 of a refresh token, hex. Only hashes are stored. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex SHA-256 / HMAC-SHA256 digests. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** A 32-byte key for one purpose, derived from JWT_SECRET (so no key is the JWT signing key). */
function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
}

export interface OtpHasher {
  /** HMAC-SHA256 over `mobile:code`, hex: a leaked row cannot be brute-forced without the key. */
  hashCode(mobile: string, code: string): string;
  /** Constant-time check of a code against the stored hash. */
  codeMatches(storedHash: string, mobile: string, code: string): boolean;
}

/** Key = HKDF-SHA256(JWT_SECRET, info `otp-code`), separate from the successor key. */
export function createOtpHasher(secret: string): OtpHasher {
  const key = deriveKey(secret, 'otp-code');
  const hashCode = (mobile: string, code: string) =>
    createHmac('sha256', key).update(`${mobile}:${code}`, 'utf8').digest('hex');
  return {
    hashCode,
    codeMatches: (storedHash, mobile, code) => hashesEqual(storedHash, hashCode(mobile, code)),
  };
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SuccessorBox {
  /** AES-256-GCM: `iv (12) | tag (16) | ciphertext`. A fresh random IV every time. */
  sealSuccessor(pair: TokenPair): Buffer;
  /** Throws if the box was sealed with another key or was altered. */
  openSuccessor(buf: Buffer): TokenPair;
}

/**
 * Seals the successor token pair a rotated refresh token keeps for its grace window (Ruling 4).
 * Key = HKDF-SHA256(JWT_SECRET, info `refresh-successor`), so it is never the JWT signing key.
 */
export function createSuccessorBox(secret: string): SuccessorBox {
  const key = deriveKey(secret, 'refresh-successor');
  return {
    sealSuccessor(pair) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(pair), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    openSuccessor(buf) {
      if (buf.length <= IV_BYTES + TAG_BYTES) throw new Error('sealed successor is too short');
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_BYTES));
      decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const json = Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
      return tokenPairSchema.parse(JSON.parse(json.toString('utf8')));
    },
  };
}
