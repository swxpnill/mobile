import { v7 as uuidv7 } from 'uuid';

/** Anything that runs SQL with parameters: a pool, or one client holding a transaction open. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * Inserts a one-line customerless order with plain SQL (owner connection, bypassing RLS): enough
 * for a test that needs an order line to exist, e.g. one using a product. Returns the ids.
 */
export async function ownerInsertOrderLine(
  db: Queryable,
  input: { tenantId: string; createdBy: string; companyId: string; productId: string; number?: string; at?: Date },
): Promise<{ orderId: string; subOrderId: string; lineId: string }> {
  const at = input.at ?? new Date();
  const orderId = uuidv7();
  const subOrderId = uuidv7();
  const lineId = uuidv7();
  await db.query(
    `insert into orders (id, tenant_id, number, type, pricing_method, notify_customer, notify_broker,
       suffixes_used, created_by, created_at, updated_at)
     values ($1, $2, $3, 'broker_only', 'direct', false, false, 1, $4, $5, $5)`,
    [orderId, input.tenantId, input.number ?? `SO-TEST-${orderId.slice(-6)}`, input.createdBy, at],
  );
  await db.query(
    `insert into sub_orders (id, tenant_id, order_id, company_id, suffix, created_at, updated_at)
     values ($1, $2, $3, $4, 'A', $5, $5)`,
    [subOrderId, input.tenantId, orderId, input.companyId, at],
  );
  await db.query(
    `insert into order_lines (id, tenant_id, sub_order_id, position, product_id, length, ordered_kg,
       conversion_snapshot, rate, rate_edited, overprice_per_mt, created_at, updated_at)
     values ($1, $2, $3, 0, $4, '{"value":12,"unit":"m"}', 1000, 0, 40000, false, 0, $5, $5)`,
    [lineId, input.tenantId, subOrderId, input.productId, at],
  );
  return { orderId, subOrderId, lineId };
}
