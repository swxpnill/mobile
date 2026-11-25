import {
  partyBodySchema,
  partyListQuerySchema,
  partySchema,
  partySummarySchema,
  updatePartyBodySchema,
} from '@tonnage/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { parties } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';
import { defineRoute } from '../http/route.ts';
import { logActivity } from '../services/activity.ts';
import {
  findParty,
  listParties,
  loadParty,
  partyStats,
  saveChildren,
  statsOf,
  transporterTrips,
  withPartyUniqueness,
} from '../services/parties.ts';
import { toParty, toPartySummary } from '../views/parties.ts';

/** `GET|POST /v1/parties`, `GET|PATCH /v1/parties/:id`: every one `masters.manage`, as in the mock. */
export const partyRoutes: FastifyPluginAsync = async (app) => {
  defineRoute(app, 'GET', '/parties', {
    action: 'masters.manage',
    query: partyListQuerySchema,
    response: { 200: z.array(partySummarySchema) },
    handler: async ({ tx, query }) => {
      const rows = await listParties(tx, query);
      const stats = await partyStats(
        tx,
        rows.map((r) => r.party.id),
      );
      return { body: rows.map((r) => toPartySummary(r.party, r, statsOf(stats, r.party.id))) };
    },
  });

  defineRoute(app, 'GET', '/parties/:id', {
    action: 'masters.manage',
    response: { 200: partySchema },
    handler: async ({ tx, params, now }) => {
      const g = await findParty(tx, params.id);
      const stats = await partyStats(tx, [g.party.id]);
      return { body: toParty(g, statsOf(stats, g.party.id), await transporterTrips(tx, g.party, now)) };
    },
  });

  defineRoute(app, 'POST', '/parties', {
    action: 'masters.manage',
    idempotent: true,
    body: partyBodySchema,
    response: { 201: partySchema },
    handler: async ({ tx, user, body, now }) => {
      const at = new Date(now);
      const id = uuidv7();
      await withPartyUniqueness(tx, body, async (sp) => {
        const [row] = await sp
          .insert(parties)
          .values({
            id,
            tenantId: user.tenantId,
            type: body.type,
            name: body.name,
            gstin: body.gstin,
            city: body.city,
            defaultCommissionPerMt: body.defaultCommissionPerMt,
            paymentTermsText: body.paymentTermsText,
            isSelfTransporter: body.isSelfTransporter,
            createdBy: user.id,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!row) throw new Error('party insert returned no row');
        await saveChildren(sp, row, body, at);
      });
      await logActivity(tx, user, now, { entityType: 'party', entityId: id, action: 'party.created' });
      const created = await loadParty(tx, id);
      if (!created) throw new Error('party vanished after insert');
      return { status: 201, body: toParty(created) };
    },
  });

  defineRoute(app, 'PATCH', '/parties/:id', {
    action: 'masters.manage',
    body: updatePartyBodySchema,
    response: { 200: partySchema },
    handler: async ({ tx, user, params, body, now }) => {
      const current = await findParty(tx, params.id);
      const p = current.party;
      if (body.version !== p.version) throw new AppError(409, 'STALE');
      if (body.type !== p.type) {
        throw new AppError(422, 'VALIDATION', [{ path: ['type'], message: "A party's type can't change" }]);
      }
      // The mock's PARTY_IN_USE (an address an order points at cannot be dropped) arrives with orders, Task 4.
      const at = new Date(now);
      await withPartyUniqueness(tx, body, async (sp) => {
        const [row] = await sp
          .update(parties)
          .set({
            name: body.name,
            gstin: body.gstin,
            city: body.city,
            defaultCommissionPerMt: body.defaultCommissionPerMt,
            paymentTermsText: body.paymentTermsText,
            isSelfTransporter: body.isSelfTransporter,
            active: body.active,
            version: p.version + 1,
            updatedAt: at,
          })
          .where(and(eq(parties.id, p.id), eq(parties.version, body.version)))
          .returning();
        // Zero rows: a concurrent write bumped the version after the read above.
        if (!row) throw new AppError(409, 'STALE');
        await saveChildren(sp, row, body, at, current);
      });
      await logActivity(tx, user, now, { entityType: 'party', entityId: p.id, action: 'party.updated' });
      const updated = await findParty(tx, p.id);
      const stats = await partyStats(tx, [p.id]);
      return { body: toParty(updated, statsOf(stats, p.id), await transporterTrips(tx, updated.party, now)) };
    },
  });
};
