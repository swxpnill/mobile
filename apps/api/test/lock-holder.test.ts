import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestApps, ownerInsertCompany, ownerInsertTenant } from './helpers.ts';
import { waitForLockWaiters, withLockHolder } from './support/lockWait.ts';

afterEach(closeTestApps);

describe('withLockHolder (the staged-concurrency holder)', () => {
  it('a failure while requests are queued: the lock is let go, the queued work settles, the error is rethrown', async () => {
    const t = await buildTestApp();
    await t.reset();
    const tenantId = await ownerInsertTenant(t.ownerDb, 'Holder test');
    const companyId = await ownerInsertCompany(t.ownerDb, tenantId, 'HLD');
    let queued: Promise<unknown> | undefined;
    const failure = withLockHolder(t.ownerDb, async (holder, track) => {
      await holder.query('select 1 from companies where id = $1 for update', [companyId]);
      queued = track(t.ownerDb.$client.query('update companies set name = $2 where id = $1', [companyId, 'Renamed']));
      await waitForLockWaiters(t.ownerDb, 1);
      throw new Error('the test failed while the update was queued');
    });
    await expect(failure).rejects.toThrow('the test failed while the update was queued');
    // The holder's transaction died with its connection, so the queued update ran and committed.
    await expect(queued).resolves.toBeDefined();
    const [row] = (await t.ownerDb.$client.query<{ name: string }>('select name from companies where id = $1', [companyId])).rows;
    expect(row?.name).toBe('Renamed');
  });
});
