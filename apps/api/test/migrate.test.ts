import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { migrate } from '../src/db/migrate.ts';

const TENANT_TABLES = [
  'activity_log',
  'companies',
  'devices',
  'idempotency_keys',
  'plants',
  'user_plants',
  'users',
];

describe('migrate', () => {
  it('running migrate twice is a no-op and leaves one tenant_isolation policy per table', async () => {
    // Global setup has already migrated once; run it twice more.
    await migrate(inject('ownerDatabaseUrl'), inject('appDatabaseUrl'));
    await migrate(inject('ownerDatabaseUrl'), inject('appDatabaseUrl'));

    const client = new pg.Client({ connectionString: inject('ownerDatabaseUrl') });
    await client.connect();
    try {
      const policies = await client.query<{ tablename: string; n: number }>(
        `select tablename, count(*)::int as n from pg_policies
         where schemaname = 'public' and policyname = 'tenant_isolation'
         group by tablename order by tablename`,
      );
      expect(policies.rows).toEqual(TENANT_TABLES.map((tablename) => ({ tablename, n: 1 })));

      const rls = await client.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity order by c.relname`,
      );
      expect(rls.rows.map((r) => r.relname)).toEqual(TENANT_TABLES);

      const role = await client.query<{
        rolbypassrls: boolean;
        rolsuper: boolean;
        rolcanlogin: boolean;
      }>(`select rolbypassrls, rolsuper, rolcanlogin from pg_roles where rolname = 'tonnage_app'`);
      expect(role.rows).toEqual([{ rolbypassrls: false, rolsuper: false, rolcanlogin: true }]);

      const owned = await client.query(
        `select tablename from pg_tables where schemaname = 'public' and tableowner = 'tonnage_app'`,
      );
      expect(owned.rows).toEqual([]);
    } finally {
      await client.end();
    }

    // The app role still logs in with the password from its URL.
    const app = new pg.Client({ connectionString: inject('appDatabaseUrl') });
    await app.connect();
    await app.end();
  });
});
