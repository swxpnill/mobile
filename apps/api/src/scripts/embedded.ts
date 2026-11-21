import { existsSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

export interface EmbeddedCluster {
  /** Superuser connection string to the `postgres` maintenance database. */
  adminUrl: string;
  stop(): Promise<void>;
}

export const EMBEDDED_USER = 'postgres';
export const EMBEDDED_PASSWORD = 'postgres';

/**
 * Starts a local PostgreSQL cluster (the `embedded-postgres` package, no Docker). The data
 * directory is created on first use and reused afterwards.
 */
export async function startEmbedded(opts: { dataDir: string; port: number }): Promise<EmbeddedCluster> {
  const pg = new EmbeddedPostgres({
    databaseDir: opts.dataDir,
    user: EMBEDDED_USER,
    password: EMBEDDED_PASSWORD,
    port: opts.port,
    persistent: true,
    onLog: () => {},
    onError: (msg) => console.error('[embedded-postgres]', msg),
  });
  if (!existsSync(join(opts.dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  return {
    adminUrl: `postgres://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@127.0.0.1:${opts.port}/postgres`,
    stop: () => pg.stop(),
  };
}

/** Same server, another database (and optionally another login). */
export function withDatabase(url: string, database: string, login?: { user: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (login) {
    u.username = login.user;
    u.password = login.password;
  }
  return u.toString();
}
