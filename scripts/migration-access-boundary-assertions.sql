\set ON_ERROR_STOP on

-- These checks run after both a clean migration and a seeded forward upgrade.
-- They prove the deployed catalog is closed before temporarily granting one
-- table inside a rolled-back transaction to exercise the RLS policies.
do $$
declare
  unsecured_table text;
  client_table_privilege text;
  client_function_privilege text;
begin
  select namespace_row.nspname || '.' || table_row.relname
    into unsecured_table
  from pg_catalog.pg_class table_row
  join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
  where namespace_row.nspname = 'public'
    and table_row.relkind in ('r', 'p')
    and not table_row.relrowsecurity
  limit 1;
  if unsecured_table is not null then
    raise exception 'Public table does not have RLS enabled: %', unsecured_table;
  end if;

  select namespace_row.nspname || '.' || table_row.relname
    into client_table_privilege
  from pg_catalog.pg_class table_row
  join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
  cross join (values ('anon'), ('authenticated')) client_role(role_name)
  where namespace_row.nspname = 'public'
    and table_row.relkind in ('r', 'p')
    and not (
      client_role.role_name = 'authenticated'
      and table_row.relname = 'sync_wakeup_state'
    )
    and has_table_privilege(client_role.role_name, table_row.oid, 'SELECT,INSERT,UPDATE,DELETE')
  limit 1;
  if client_table_privilege is not null then
    raise exception 'Client role retains direct application-table privileges: %', client_table_privilege;
  end if;
  if has_table_privilege('anon', 'public.sync_wakeup_state', 'SELECT')
    or has_table_privilege('anon', 'public.sync_wakeup_state', 'INSERT')
    or has_table_privilege('anon', 'public.sync_wakeup_state', 'UPDATE')
    or has_table_privilege('anon', 'public.sync_wakeup_state', 'DELETE') then
    raise exception 'Anonymous clients can access sync wake-up state';
  end if;
  if not has_table_privilege('authenticated', 'public.sync_wakeup_state', 'SELECT')
    or has_table_privilege('authenticated', 'public.sync_wakeup_state', 'INSERT')
    or has_table_privilege('authenticated', 'public.sync_wakeup_state', 'UPDATE')
    or has_table_privilege('authenticated', 'public.sync_wakeup_state', 'DELETE') then
    raise exception 'Authenticated sync wake-up grants are not read-only';
  end if;
  if not (
    select table_row.relrowsecurity and table_row.relforcerowsecurity
    from pg_catalog.pg_class table_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
    where namespace_row.nspname = 'public'
      and table_row.relname = 'sync_wakeup_state'
  ) then
    raise exception 'Sync wake-up state does not force RLS';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_class sequence_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = sequence_row.relnamespace
    cross join (values ('anon'), ('authenticated')) client_role(role_name)
    where namespace_row.nspname = 'public'
      and sequence_row.relkind = 'S'
      and has_sequence_privilege(client_role.role_name, sequence_row.oid, 'USAGE,SELECT,UPDATE')
  ) then
    raise exception 'Client role retains direct application-sequence privileges';
  end if;

  select function_row.oid::regprocedure::text
    into client_function_privilege
  from pg_catalog.pg_proc function_row
  join pg_catalog.pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
  cross join (values ('anon'), ('authenticated')) client_role(role_name)
  where namespace_row.nspname = 'public'
    and has_function_privilege(client_role.role_name, function_row.oid, 'EXECUTE')
  limit 1;
  if client_function_privilege is not null then
    raise exception 'Client role retains direct application-function execution: %', client_function_privilege;
  end if;

  if has_schema_privilege('anon', 'public', 'CREATE')
    or has_schema_privilege('authenticated', 'public', 'CREATE') then
    raise exception 'An untrusted client role can create objects in public';
  end if;
  if not exists (
    select 1 from storage.buckets
    where id = 'goalflow-backups' and public is false
  ) then
    raise exception 'Goalflow backup bucket is missing or public';
  end if;
  if has_table_privilege('anon', 'storage.objects', 'SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated', 'storage.objects', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'A client role can access backup storage objects directly';
  end if;

  if has_function_privilege(
    'service_role',
    'public.project_goalflow_task_sync(uuid,text,jsonb,bigint,timestamptz,timestamptz)',
    'EXECUTE'
  ) then
    raise exception 'Internal task projection remains callable by the service API role';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.push_sync_mutation_v2(uuid,uuid,text,text,text,bigint,integer,jsonb,timestamptz,timestamptz,uuid)',
    'EXECUTE'
  ) then
    raise exception 'Canonical sync RPC is not callable by the service API role';
  end if;
  if has_function_privilege(
    'service_role',
    'public.restore_goalflow_backup(uuid,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Legacy restore RPC remains callable by the service API role';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.validate_goalflow_backup_v2(uuid,jsonb)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.restore_goalflow_backup_v2(uuid,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Validated backup v2 RPC boundary is incomplete';
  end if;
end;
$$;

begin;

insert into auth.users (id, email)
values ('22222222-1111-4111-8111-111111111111', 'migration-b@example.invalid')
on conflict (id) do nothing;
insert into public.profiles (user_id, email, timezone)
values ('22222222-1111-4111-8111-111111111111', 'migration-b@example.invalid', 'UTC')
on conflict (user_id) do nothing;
insert into public.tasks (id, user_id, title, schedule_precision, scheduled_for, source)
values (
  '22222222-2222-4222-8222-333333333333',
  '22222222-1111-4111-8111-111111111111',
  'User B task', 'day', '2099-01-01', 'manual'
)
on conflict (id) do nothing;

-- Re-enable only a disposable generic sync-record path inside this transaction
-- so RLS itself is tested independently of the stricter SQL grants above.
grant select, insert, update, delete on public.sync_records to authenticated;

create or replace function public.goalflow_test_rls_isolation(
  user_a uuid,
  user_b uuid
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $rls_test$
begin
  if exists (select 1 from public.sync_records where user_id = user_b) then
    raise exception 'RLS exposed another user''s sync records';
  end if;

  insert into public.sync_records (
    user_id, entity_type, entity_id, version, server_version, device_id,
    payload, updated_at
  ) values (
    user_a, 'settings', 'rls-test', 1, 900000000000000000,
    'rls-test', '{"test":true}'::jsonb, now()
  );
  if not exists (
    select 1 from public.sync_records
    where user_id = user_a and entity_type = 'settings' and entity_id = 'rls-test'
  ) then
    raise exception 'RLS hid the authenticated user''s own inserted record';
  end if;

  begin
    insert into public.sync_records (
      user_id, entity_type, entity_id, version, server_version, device_id,
      payload, updated_at
    ) values (
      user_b, 'settings', 'rls-forgery', 1, 900000000000000001,
      'rls-test', '{"forged":true}'::jsonb, now()
    );
    raise exception 'RLS accepted a forged owner id';
  exception when insufficient_privilege then
    null;
  end;
end;
$rls_test$;
grant execute on function public.goalflow_test_rls_isolation(uuid, uuid) to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select public.goalflow_test_rls_isolation(
  '11111111-1111-4111-8111-111111111111',
  '22222222-1111-4111-8111-111111111111'
);
reset role;

-- Privileged callers are still constrained by durable same-owner relations.
do $$
begin
  begin
    update public.tasks
    set parent_task_id = '22222222-2222-4222-8222-333333333333'
    where id = '22222222-2222-4222-8222-222222222222';
    raise exception 'Cross-owner parent task was accepted';
  exception when foreign_key_violation then
    null;
  end;

  begin
    insert into public.task_events (
      user_id, task_id, event_type, local_date
    ) values (
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-333333333333',
      'created', '2099-01-01'
    );
    raise exception 'Cross-owner task event was accepted';
  exception when foreign_key_violation then
    null;
  end;

  begin
    insert into public.daily_plans (
      user_id, local_date, task_ids, confirmed_at
    ) values (
      '11111111-1111-4111-8111-111111111111',
      '2099-02-01',
      array['22222222-2222-4222-8222-333333333333'::uuid],
      now()
    );
    raise exception 'Cross-owner daily plan task was accepted';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

rollback;
