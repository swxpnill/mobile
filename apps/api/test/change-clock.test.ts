import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/client.ts';
import { bumpChangeClock, readChangeClockForShare } from '../src/services/changeClock.ts';
import { buildTestApp, closeTestApps, ownerInsertTenant, TEST_NOW, type TestApp } from './helpers.ts';
import { gate } from './support/gate.ts';
import { waitForLockWaiters } from './support/lockWait.ts';

afterEach(closeTestApps);

describe('tenant change clock (B3 Ruling 3)', () => {
  let t: TestApp;
  let tenantId: string;

  beforeEach(async () => {
    t = await buildTestApp();
    await t.reset();
    tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
  });

  it('starts empty, and two bumps in one millisecond are strictly increasing', async () => {
    expect(await withTenant(t.db, tenantId, (tx) => readChangeClockForShare(tx, tenantId))).toBeNull();
    const a = await withTenant(t.db, tenantId, (tx) => bumpChangeClock(tx, tenantId, TEST_NOW));
    const b = await withTenant(t.db, tenantId, (tx) => bumpChangeClock(tx, tenantId, TEST_NOW));
    expect(a).toBe(new Date(TEST_NOW).toISOString());
    expect(b).toBe(new Date(TEST_NOW + 1).toISOString());
    expect(await withTenant(t.db, tenantId, (tx) => readChangeClockForShare(tx, tenantId))).toBe(b);
  });

  it('never moves back when the clock does', async () => {
    const a = await withTenant(t.db, tenantId, (tx) => bumpChangeClock(tx, tenantId, TEST_NOW));
    const b = await withTenant(t.db, tenantId, (tx) => bumpChangeClock(tx, tenantId, TEST_NOW - 60_000));
    expect(b > a).toBe(true);
  });

  it('a reader waits for an in-flight writer, then sees its time (the pull fence)', async () => {
    await withTenant(t.db, tenantId, (tx) => bumpChangeClock(tx, tenantId, TEST_NOW));
    const holding = gate();
    const release = gate();
    const writer = withTenant(t.db, tenantId, async (tx) => {
      const at = await bumpChangeClock(tx, tenantId, TEST_NOW + 5_000);
      holding.open();
      await release.wait;
      return at;
    });
    await holding.wait;
    const reader = withTenant(t.db, tenantId, (tx) => readChangeClockForShare(tx, tenantId));
    await waitForLockWaiters(t.ownerDb, 1);
    release.open();
    const [written, read] = await Promise.all([writer, reader]);
    expect(read).toBe(written);
  });

  it('is per tenant', async () => {
    const other = await ownerInsertTenant(t.ownerDb, 'Other Group');
    await withTenant(t.db, tenantId, (tx) => bumpChangeClock(tx, tenantId, TEST_NOW));
    expect(await withTenant(t.db, other, (tx) => readChangeClockForShare(tx, other))).toBeNull();
  });
});
