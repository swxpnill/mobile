import { expect, it } from 'vitest';
import { SAMPLE_MASTERS, SAMPLE_WORLD, istDateOf } from '@tonnage/shared';
import { createFakeClock } from './clock.ts';
import { ALL_ROUTES } from './index.ts';
import { createPipeline } from './pipeline.ts';
import { buildRouter } from './router.ts';
import { issueTokens } from './sessions.ts';
import { createMemoryStorage, createStore } from './store.ts';

it('recording and reversing a payment write broker activity entries', async () => {
  const clock = createFakeClock(Date.UTC(2026, 10, 17, 6, 0));
  const store = await createStore({ storage: createMemoryStorage(), storageKey: 'k', clock });
  const { handle } = createPipeline({ router: buildRouter(ALL_ROUTES), store, clock });
  const token = issueTokens(store.state, SAMPLE_WORLD.ids.users.rajesh, 'd', clock.now()).accessToken;
  const broker = SAMPLE_MASTERS.ids.parties.rkAgarwal;
  const post = (path: string, key: string, body: unknown) =>
    handle({ method: 'POST', path, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, body });

  const paid = await post(`/v1/brokers/${broker}/payments`, 'a', {
    paidRupees: 1_000,
    tdsRupees: 0,
    mode: 'cash',
    utr: null,
    paidOn: istDateOf(clock.now()),
  });
  expect(paid.status).toBe(201);
  const id = (paid.body as { entry: { id: string } }).entry.id;
  expect((await post(`/v1/ledger/${id}/reverse`, 'b', { reason: 'Wrong party' })).status).toBe(201);

  const acts = store.state.activity.filter((e) => e.entityType === 'broker');
  expect(acts.map((e) => e.action)).toEqual(['broker.payment_recorded', 'broker.payment_reversed']);
  expect(acts.every((e) => e.entityId === broker)).toBe(true);
  expect(acts[0]!.meta).toMatchObject({ entryId: id, paidRupees: 1_000, mode: 'cash' });
});
