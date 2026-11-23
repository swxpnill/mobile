import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

export interface EmbeddedCluster {
  /** Superuser connection string to the `postgres` maintenance database. */
  adminUrl: string;
  stop(): Promise<void>;
}

export const EMBEDDED_USER = 'postgres';
export const EMBEDDED_PASSWORD = 'postgres';

/**
 * PostgreSQL major version of the bundled binaries. Every embedded-postgres release is tagged
 * `-beta.N` (the wrapper's own versioning); the 16.x line bundles stable PostgreSQL 16.x, which
 * matches the postgres:16 service CI uses.
 */
function binaryMajor(): string {
  // The package does not export its package.json, so walk up from its entry point to find it.
  let dir = dirname(createRequire(import.meta.url).resolve('embedded-postgres'));
  for (;;) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version: string };
      if (pkg.name === 'embedded-postgres') return pkg.version.split('.')[0] ?? '';
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot locate the embedded-postgres package');
    dir = parent;
  }
}

/** A data directory written by another major version cannot be started; delete it so it is re-created. */
export function discardStaleDataDir(dataDir: string): void {
  const marker = join(dataDir, 'PG_VERSION');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() !== binaryMajor()) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Starts a local PostgreSQL cluster (the `embedded-postgres` package, no Docker). The data
 * directory is created on first use and reused afterwards.
 */
export async function startEmbedded(opts: { dataDir: string; port: number }): Promise<EmbeddedCluster> {
  discardStaleDataDir(opts.dataDir);
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
