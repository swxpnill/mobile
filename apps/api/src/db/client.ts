import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

/** The database handle. Task 2 extends this with the schema; the pool is reachable as `db.$client`. */
export type Db = NodePgDatabase & { $client: pg.Pool };

export function createDb(connectionString: string): Db {
  return drizzle(new pg.Pool({ connectionString }));
}
