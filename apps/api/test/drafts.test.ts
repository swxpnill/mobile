import type { Draft } from '@tonnage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApps } from './helpers.ts';
import { waitForLockWaiters } from './support/lockWait.ts';
import { normaliseIds } from './support/normalise.ts';
import { buildParity, type Parity, type Res } from './support/parity.ts';

afterEach(closeTestApps);

const DAY = 24 * 60 * 60 * 1000;
let p: Parity;

beforeEach(async () => {
  p = await buildParity();
});

const same = ([mock, api]: [Res, Res]) => expect(normaliseIds(api)).toEqual(normaliseIds(mock));
const payload = (n: number) => ({ payload: { step: n, customerId: null } });

describe('drafts equal the mock', () => {
  it('create, list, read, save with version, delete', async () => {
    const created = await p.both('POST', () => '/v1/orders/drafts', () => ({ body: payload(1) }));
    expect(created[1].status).toBe(201);
    same(created);
    const ids = new Map([
      [p.mock, (created[0].body as Draft).id],
      [p.api, (created[1].body as Draft).id],
    ]);
    const path = (s: Parity['mock']) => `/v1/orders/drafts/${ids.get(s)}`;
    same(await p.both('GET', () => '/v1/orders/drafts'));
    same(await p.both('GET', path));
    p.clock.advance(60_000);
    const saved = await p.both('PUT', path, () => ({ body: { ...payload(2), version: 1 } }));
    expect(saved[1].status).toBe(200);
    expect(saved[1].body).toMatchObject({ version: 2, payload: { step: 2 } });
    same(saved);
    // Without a version there is no check; with a stale one it is 409 STALE.
    same(await p.both('PUT', path, () => ({ body: payload(3) })));
    const stale = await p.both('PUT', path, () => ({ body: { ...payload(4), version: 1 } }));
    expect(stale[1]).toMatchObject({ status: 409, body: { code: 'STALE' } });
    same(stale);
    same(await p.both('DELETE', path));
    same(await p.both('GET', path));
    same(await p.both('GET', () => '/v1/orders/drafts'));
  });

  it('a draft belongs to its creator: another person gets 404, the owner may open anyone', async () => {
    const mine = await p.api.call('POST', '/v1/orders/drafts', { body: payload(1), as: 'rajesh' });
    const id = (mine.body as Draft).id;
    const priya = await p.api.call('GET', `/v1/orders/drafts/${id}`, { as: 'priya' });
    expect(priya.status).toBe(404);
    expect((await p.api.call('PUT', `/v1/orders/drafts/${id}`, { as: 'priya', body: payload(9) })).status).toBe(404);
    expect((await p.api.call('DELETE', `/v1/orders/drafts/${id}`, { as: 'priya' })).status).toBe(404);
    expect((await p.api.call('GET', '/v1/orders/drafts', { as: 'priya' })).body).toEqual([]);

    const hers = await p.api.call('POST', '/v1/orders/drafts', { body: payload(2), as: 'priya' });
    const herId = (hers.body as Draft).id;
    const seen = await p.api.call('GET', `/v1/orders/drafts/${herId}`, { as: 'rajesh' });
    expect(seen.body).toMatchObject({ id: herId, createdBy: { name: 'Priya Sharma' } });
    expect(((await p.api.call('GET', '/v1/orders/drafts', { as: 'rajesh' })).body as Draft[]).length).toBe(2);
    // The same on the mock.
    const m = await p.mock.call('POST', '/v1/orders/drafts', { body: payload(1), as: 'rajesh' });
    expect((await p.mock.call('GET', `/v1/orders/drafts/${(m.body as Draft).id}`, { as: 'priya' })).status).toBe(404);
  });

  it('plant roles cannot use drafts (403), an unknown or malformed id is 404, a bad body 422', async () => {
    same(await p.both('GET', () => '/v1/orders/drafts', () => ({ as: 'kiran' })));
    expect((await p.api.call('GET', '/v1/orders/drafts', { as: 'kiran' })).status).toBe(403);
    same(await p.both('GET', () => '/v1/orders/drafts/not-an-id'));
    same(await p.both('GET', () => '/v1/orders/drafts/0190a000-0000-7000-8000-000000000000'));
    same(await p.both('POST', () => '/v1/orders/drafts', () => ({ body: { payload: 'x' } })));
  });

  it('drafts untouched for more than 7 days are purged on read; a save keeps one alive', async () => {
    const old = await p.api.call('POST', '/v1/orders/drafts', { body: payload(1) });
    const kept = await p.api.call('POST', '/v1/orders/drafts', { body: payload(2) });
    const oldId = (old.body as Draft).id;
    const keptId = (kept.body as Draft).id;
    p.clock.advance(5 * DAY);
    expect((await p.api.call('PUT', `/v1/orders/drafts/${keptId}`, { body: payload(3) })).status).toBe(200);
    p.clock.advance(3 * DAY); // 8 days since `old` was saved, 3 since `kept` was
    const list = await p.api.call('GET', '/v1/orders/drafts');
    expect((list.body as Draft[]).map((d) => d.id)).toEqual([keptId]);
    expect((await p.api.call('GET', `/v1/orders/drafts/${oldId}`)).status).toBe(404);
    // Purged for good, not just hidden.
    const rows = await p.t.ownerDb.$client.query<{ n: number }>('select count(*)::int as n from drafts');
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('an expired draft is 404 by id even before any list read', async () => {
    const old = await p.api.call('POST', '/v1/orders/drafts', { body: payload(1) });
    const id = (old.body as Draft).id;
    p.clock.advance(7 * DAY + 1);
    expect((await p.api.call('GET', `/v1/orders/drafts/${id}`)).status).toBe(404);
    expect((await p.api.call('PUT', `/v1/orders/drafts/${id}`, { body: payload(2) })).status).toBe(404);
  });

  it('exactly 7 days old is kept, as the mock', async () => {
    await p.both('POST', () => '/v1/orders/drafts', () => ({ body: payload(1) }));
    p.clock.advance(7 * DAY);
    const list = await p.both('GET', () => '/v1/orders/drafts');
    expect((list[1].body as Draft[]).length).toBe(1);
    same(list);
  });

  it('drafts saved at the same instant list in creation order, as the mock', async () => {
    for (let n = 1; n <= 3; n += 1) await p.both('POST', () => '/v1/orders/drafts', () => ({ body: payload(n) }));
    const list = await p.both('GET', () => '/v1/orders/drafts');
    expect((list[1].body as Draft[]).map((d) => (d.payload as { step: number }).step)).toEqual([1, 2, 3]);
    same(list);
  });

  it('the owner purges an expired draft of someone else and sees the same list as the mock', async () => {
    await p.both('POST', () => '/v1/orders/drafts', () => ({ body: payload(1), as: 'priya' }));
    p.clock.advance(3 * DAY);
    await p.both('POST', () => '/v1/orders/drafts', () => ({ body: payload(2), as: 'priya' }));
    p.clock.advance(5 * DAY); // the first is 8 days old, the second 5
    const list = await p.both('GET', () => '/v1/orders/drafts', () => ({ as: 'rajesh' }));
    expect((list[1].body as Draft[]).length).toBe(1);
    same(list);
    const rows = await p.t.ownerDb.$client.query<{ n: number }>('select count(*)::int as n from drafts');
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('two saves with the same version at once: one 200, one 409 STALE', async () => {
    const made = await p.api.call('POST', '/v1/orders/drafts', { body: payload(1) });
    const id = (made.body as Draft).id;
    const holder = await p.t.ownerDb.$client.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from drafts where id = $1 for update', [id]);
      const first = p.api.call('PUT', `/v1/orders/drafts/${id}`, { body: { ...payload(2), version: 1 } });
      await waitForLockWaiters(p.t.ownerDb, 1);
      const second = p.api.call('PUT', `/v1/orders/drafts/${id}`, { body: { ...payload(3), version: 1 } });
      await waitForLockWaiters(p.t.ownerDb, 2);
      await holder.query('commit');
      const [a, b] = await Promise.all([first, second]);
      expect([a.status, b.status]).toEqual([200, 409]);
      expect(b.body).toMatchObject({ code: 'STALE' });
    } finally {
      holder.release();
    }
    const after = await p.api.call('GET', `/v1/orders/drafts/${id}`);
    expect(after.body).toMatchObject({ version: 2, payload: { step: 2 } });
  });
});
