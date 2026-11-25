import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { migrate } from '../src/db/migrate.ts';

/**
 * Tables with a tenant_id column that are deliberately not under RLS. refresh_tokens is looked up by
 * token hash before the tenant is known (refresh carries no tenant). Keep in step with rls.sql.
 */
const RLS_EXEMPT = ['refresh_tokens'];

/** The M1 tenant tables, so the catalog check below can never pass vacuously. */
const TENANT_TABLES = [
  'activity_log',
  'companies',
  'devices',
  'idempotency_keys',
  'plants',
  'user_plants',
  'users',
];

/** Every public table with a tenant_id column, and whether it has RLS on and how many tenant_isolation policies. */
async function tenantTableCatalog(client: pg.Client) {
  const r = await client.query<{ relname: string; rls: boolean; policies: number }>(
    `select c.relname, c.relrowsecurity as rls,
            (select count(*)::int from pg_policies p
              where p.schemaname = 'public' and p.tablename = c.relname
                and p.policyname = 'tenant_isolation') as policies
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and exists (select 1 from pg_attribute a
                     where a.attrelid = c.oid and a.attname = 'tenant_id'
                       and a.attnum > 0 and not a.attisdropped)
      order by c.relname`,
  );
  return r.rows;
}

async function withOwner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('ownerDatabaseUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('migrate', () => {
  it('puts every public table with a tenant_id column under RLS with one tenant_isolation policy, except the exemptions', async () => {
    await withOwner(async (client) => {
      const rows = await tenantTableCatalog(client);
      const covered = rows.filter((r) => !RLS_EXEMPT.includes(r.relname));
      expect(covered.map((r) => r.relname)).toEqual(TENANT_TABLES);
      for (const row of covered) expect(row, row.relname).toMatchObject({ rls: true, policies: 1 });
    });
  });

  it('covers a table a later migration adds with tenant_id, without anyone listing it', async () => {
    await withOwner(async (client) => {
      await client.query(
        'create table public.zz_rls_probe (id uuid primary key, tenant_id uuid not null)',
      );
      try {
        await migrate(inject('ownerDatabaseUrl'), inject('appDatabaseUrl'));
        const rows = await tenantTableCatalog(client);
        expect(rows.find((r) => r.relname === 'zz_rls_probe')).toEqual({
          relname: 'zz_rls_probe',
          rls: true,
          policies: 1,
        });
      } finally {
        await client.query('drop table public.zz_rls_probe');
      }
    });
  });

  it('keeps the sign-in lookup function closed to PUBLIC and open to tonnage_app', async () => {
    await withOwner(async (client) => {
      const r = await client.query<{ pub: boolean; app: boolean }>(
        `select has_function_privilege('public', 'public.auth_lookup_mobile(text)', 'execute') as pub,
                has_function_privilege('tonnage_app', 'public.auth_lookup_mobile(text)', 'execute') as app`,
      );
      expect(r.rows).toEqual([{ pub: false, app: true }]);
    });
  });

  it('tonnage_app may read tenants and update only settings and updated_at; never insert or delete', async () => {
    const check = () =>
      withOwner(async (client) => {
        const r = await client.query<{ privilege: string; granted: boolean }>(
          `select p as privilege, has_table_privilege('tonnage_app', 'public.tenants', p) as granted
             from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
           union all
           select 'UPDATE(' || a.attname || ')', has_column_privilege('tonnage_app', 'public.tenants', a.attname, 'UPDATE')
             from pg_attribute a
            where a.attrelid = 'public.tenants'::regclass and a.attnum > 0 and not a.attisdropped`,
        );
        return Object.fromEntries(r.rows.map((row) => [row.privilege, row.granted]));
      });
    const expected = {
      SELECT: true,
      INSERT: false,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
      'UPDATE(id)': false,
      'UPDATE(name)': false,
      'UPDATE(settings)': true,
      'UPDATE(created_at)': false,
      'UPDATE(updated_at)': true,
    };
    expect(await check()).toEqual(expected);
    // rls.sql re-grants DML on every table each run, then narrows tenants again: still the same.
    await migrate(inject('ownerDatabaseUrl'), inject('appDatabaseUrl'));
    expect(await check()).toEqual(expected);

    // And as the app role itself.
    const app = new pg.Client({ connectionString: inject('appDatabaseUrl') });
    await app.connect();
    try {
      for (const stmt of [
        `insert into tenants (id, name, settings, created_at, updated_at) values (gen_random_uuid(), 'X', '{}', now(), now())`,
        `delete from tenants`,
        `update tenants set name = 'X'`,
      ]) {
        await expect(app.query(stmt), stmt).rejects.toMatchObject({ code: '42501' });
      }
      await expect(app.query(`update tenants set settings = settings, updated_at = updated_at`)).resolves.toBeDefined();
    } finally {
      await app.end();
    }
  });

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
