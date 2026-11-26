-- Runs after the drizzle migrations, on every `migrate`, as the migration role (the table owner).
-- Idempotent: every statement can run again on an already-migrated database.
-- Expects the session setting `tonnage.app_password` (set by migrate.ts, as a bound parameter).

-- 1. The runtime role. Roles are cluster-wide, so it may already exist from another database.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tonnage_app') then
    begin
      create role tonnage_app login nobypassrls;
    exception when duplicate_object then
      null; -- another database's migrate created it concurrently
    end;
  end if;
  if exists (select 1 from pg_roles where rolname = 'tonnage_app' and (rolsuper or rolbypassrls)) then
    raise exception 'tonnage_app must not be a superuser or BYPASSRLS';
  end if;
  execute format('alter role tonnage_app with login password %L', current_setting('tonnage.app_password'));
end
$$;

-- 2. DML on every table, now and for tables later migrations create. Never ownership.
grant usage on schema public to tonnage_app;
grant select, insert, update, delete on all tables in schema public to tonnage_app;
alter default privileges in schema public grant select, insert, update, delete on tables to tonnage_app;

-- 2b. `tenants` is the one table without RLS, so the runtime role gets only what it needs: read, and
-- update of the settings (PATCH /v1/settings). Tenants are created and removed by the owner role
-- (seed, provisioning), never by the API. Revoking table-level UPDATE also drops column grants, so
-- the column grant follows it; re-running after step 2 lands in the same state.
revoke insert, delete on public.tenants from tonnage_app;
revoke update on public.tenants from tonnage_app;
grant update (settings, updated_at) on public.tenants to tonnage_app;

-- 3. Tenant isolation, on every public table with a tenant_id column, so a table a later migration
-- adds is covered without anyone listing it. Exempt (keep in step with test/migrate.test.ts):
--   refresh_tokens: looked up by token hash before the tenant is known (refresh carries no tenant).
-- `tenants` has no tenant_id column. `nullif(..., '')`: once a transaction-local setting has ended,
-- the session reports '' rather than null, and ''::uuid would raise instead of matching nothing.
do $$
declare
  t text;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and c.relname <> all (array['refresh_tokens'])
       and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id'
                      and a.attnum > 0 and not a.attisdropped)
     order by c.relname
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I
         using (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
         with check (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  end loop;
end
$$;

-- 4. Sign-in lookup across tenants (before the tenant is known). Runs as its owner, the migration
-- role, which owns the tables and so is not subject to RLS (no FORCE ROW LEVEL SECURITY).
create or replace function public.auth_lookup_mobile(p_mobile text)
returns table(tenant_id uuid, user_id uuid, active boolean, tenant_name text)
language sql
stable
security definer
set search_path = public
as $$
  select u.tenant_id, u.id, u.active, t.name
  from public.users u
  join public.tenants t on t.id = u.tenant_id
  where u.mobile = p_mobile
$$;
revoke all on function public.auth_lookup_mobile(text) from public;
grant execute on function public.auth_lookup_mobile(text) to tonnage_app;
