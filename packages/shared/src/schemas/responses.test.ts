import { describe, expect, it } from 'vitest';
import {
  apiErrorBodySchema,
  metaSchema,
  requestCodeResponseSchema,
  tenantChoiceDetailsSchema,
  validationDetailsSchema,
} from '../index.ts';

const T1 = '019a4c00-0000-7000-8000-000000000001';
const T2 = '019a4c00-0000-7000-8000-000000000002';

describe('response schemas', () => {
  it('apiErrorBodySchema accepts { code, message, details? } with a known code only', () => {
    expect(apiErrorBodySchema.parse({ code: 'STALE', message: 'Changed' })).toEqual({
      code: 'STALE',
      message: 'Changed',
    });
    expect(
      apiErrorBodySchema.safeParse({ code: 'VALIDATION', message: 'x', details: [] }).success,
    ).toBe(true);
    expect(apiErrorBodySchema.safeParse({ code: 'TEAPOT', message: 'x' }).success).toBe(false);
    expect(apiErrorBodySchema.safeParse({ code: 'STALE' }).success).toBe(false);
  });

  it('validationDetailsSchema is a non-empty list of { path, message }', () => {
    const d = [{ path: ['plantIds', 0], message: 'Invalid UUID' }];
    expect(validationDetailsSchema.parse(d)).toEqual(d);
    expect(validationDetailsSchema.safeParse([]).success).toBe(false);
    expect(validationDetailsSchema.safeParse([{ path: 'code', message: 'x' }]).success).toBe(false);
  });

  it('tenantChoiceDetailsSchema lists tenants by id and name', () => {
    const d = [
      { tenantId: T1, tenantName: 'Agrawal Group' },
      { tenantId: T2, tenantName: 'Bansal Metals' },
    ];
    expect(tenantChoiceDetailsSchema.parse(d)).toEqual(d);
    expect(tenantChoiceDetailsSchema.safeParse(d.slice(0, 1)).success).toBe(false); // no choice with one
    expect(tenantChoiceDetailsSchema.safeParse([{ tenantId: 'x', tenantName: 'A' }]).success).toBe(
      false,
    );
  });

  it('requestCodeResponseSchema and metaSchema', () => {
    expect(requestCodeResponseSchema.parse({ resendAfterSeconds: 30 })).toEqual({
      resendAfterSeconds: 30,
    });
    expect(requestCodeResponseSchema.safeParse({ resendAfterSeconds: -1 }).success).toBe(false);
    expect(
      metaSchema.parse({ minSupportedVersion: '1.0.0', serverTime: '2026-11-03T04:30:00.000Z' }),
    ).toMatchObject({ minSupportedVersion: '1.0.0' });
    expect(
      metaSchema.safeParse({ minSupportedVersion: 'one', serverTime: '2026-11-03T04:30:00.000Z' })
        .success,
    ).toBe(false);
  });
});
