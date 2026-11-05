import { NetworkError } from '@tonnage/shared';
import { ApiError } from '../api/client';

/** User-facing copy for API failures on the sign-in flow. */
export const MSG = {
  invalidMobile: 'Enter a 10-digit mobile number',
  otpInvalid: 'That code is not right. Try again.',
  otpLocked: 'Too many tries. Try again in 15 minutes.',
  otpExpired: 'That code has expired. Send a new one.',
  offline: "Can't reach the server. Check your connection and try again.",
  generic: 'Something went wrong. Try again.',
} as const;

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
      default:
        return MSG.generic;
    }
  }
  return MSG.generic;
}
