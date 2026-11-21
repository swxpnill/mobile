import { type ErrorCode, NetworkError, SYNC_REJECT_REASON } from '@tonnage/shared';
import { ApiError } from '../api/client';

/** User-facing copy for API failures (sign-in and admin screens). */
export const MSG = {
  invalidMobile: 'Enter a 10-digit mobile number',
  otpInvalid: 'That code is not right. Try again.',
  otpLocked: 'Too many tries. Try again in 15 minutes.',
  otpExpired: 'That code has expired. Send a new one.',
  offline: "Can't reach the server. Check your connection and try again.",
  generic: 'Something went wrong. Try again.',
  stale: 'Someone else changed this. Showing the latest.',
  mobileExists: 'This number already has an account',
  lastOwner: "You can't remove the last owner.",
  forbidden: "You don't have access to this.",
  notFound: 'This was removed or is no longer available.',
  plantRule: 'Choose plants that match the role',
  inProgress: 'Still sending your first try. Wait a moment, then try again.',
  notReversible: 'Only payments can be reversed',
  alreadyReversed: 'This payment was already reversed',
} as const;

/**
 * Why the server refused a weight from a phone (sync rejections, a refused restore or
 * correction), in plain words. Undefined for codes that are not about weights.
 */
export function weightCodeMessage(code: ErrorCode): string | undefined {
  return (SYNC_REJECT_REASON as Partial<Record<ErrorCode, string>>)[code];
}

export function messageFor(e: unknown): string {
  if (e instanceof NetworkError) return MSG.offline;
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'OTP_INVALID':
        return MSG.otpInvalid;
      case 'OTP_LOCKED':
        return MSG.otpLocked;
      case 'OTP_EXPIRED':
        return MSG.otpExpired;
      case 'STALE':
        return MSG.stale;
      case 'MOBILE_EXISTS':
        return MSG.mobileExists;
      case 'LAST_OWNER':
        return MSG.lastOwner;
      case 'FORBIDDEN':
        return MSG.forbidden;
      case 'NOT_FOUND':
        return MSG.notFound;
      case 'PLANT_RULE':
        return MSG.plantRule;
      case 'IDEMPOTENCY_IN_PROGRESS':
        return MSG.inProgress;
      case 'NOT_REVERSIBLE':
        return MSG.notReversible;
      case 'ALREADY_REVERSED':
        return MSG.alreadyReversed;
      default:
        return weightCodeMessage(e.code) ?? MSG.generic;
    }
  }
  return MSG.generic;
}
