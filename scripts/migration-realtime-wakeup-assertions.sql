\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email)
values ('22222222-1111-4111-8111-111111111111', 'wakeup-b@example.invalid')
on conflict (id) do nothing;

do $$
declare
  user_a constant uuid := '11111111-1111-4111-8111-111111111111';
  before_version bigint;
  before_messages bigint;
  rollback_version bigint;
  rollback_messages bigint;
begin
  select coalesce(version, 0) into before_version
  from public.sync_wakeup_state where user_id = user_a;
  if not found then before_version := 0; end if;
  select count(*) into before_messages
  from realtime.messages where topic = 'tsurfing:user:' || user_a::text;

  insert into public.sync_records (
    user_id, entity_type, entity_id, version, server_version, device_id,
    payload, updated_at
  ) values (
    user_a, 'settings', 'realtime-wakeup-commit', 1,
    nextval('public.goalflow_change_seq'), 'migration-wakeup-test',
    '{"test":true}'::jsonb, clock_timestamp()
  );

  if (select version from public.sync_wakeup_state where user_id = user_a)
      <> before_version + 1 then
    raise exception 'Committed sync change did not increment wake-up version exactly once';
  end if;
  if (select count(*) from realtime.messages
      where topic = 'tsurfing:user:' || user_a::text) <> before_messages + 1 then
    raise exception 'Committed sync change did not emit exactly one wake-up';
  end if;
  if not exists (
    select 1 from realtime.messages
    where topic = 'tsurfing:user:' || user_a::text
      and extension = 'broadcast'
      and event = 'sync_wakeup'
      and payload ? 'id'
      and payload - 'id' = '{}'::jsonb
      and private is true
  ) then
    raise exception 'Wake-up exposed payload data or used the wrong event/topic/privacy';
  end if;

  select version into rollback_version
  from public.sync_wakeup_state where user_id = user_a;
  select count(*) into rollback_messages
  from realtime.messages where topic = 'tsurfing:user:' || user_a::text;

  begin
    insert into public.sync_records (
      user_id, entity_type, entity_id, version, server_version, device_id,
      payload, updated_at
    ) values (
      user_a, 'settings', 'realtime-wakeup-rollback', 1,
      nextval('public.goalflow_change_seq'), 'migration-wakeup-test',
      '{"mustRollback":true}'::jsonb, clock_timestamp()
    );
    raise exception using errcode = 'P0001', message = 'intentional wake-up rollback';
  exception when sqlstate 'P0001' then
    null;
  end;

  if exists (
    select 1 from public.sync_records
    where user_id = user_a and entity_id = 'realtime-wakeup-rollback'
  ) or (select version from public.sync_wakeup_state where user_id = user_a) <> rollback_version
    or (select count(*) from realtime.messages
        where topic = 'tsurfing:user:' || user_a::text) <> rollback_messages then
    raise exception 'Rolled-back sync change left wake-up state or a broadcast behind';
  end if;

  insert into public.sync_records (
    user_id, entity_type, entity_id, version, server_version, device_id,
    payload, updated_at
  ) values (
    '22222222-1111-4111-8111-111111111111', 'settings',
    'realtime-wakeup-user-b', 1, nextval('public.goalflow_change_seq'),
    'migration-wakeup-test', '{"test":true}'::jsonb, clock_timestamp()
  );

  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and cmd in ('INSERT', 'ALL')
      and 'authenticated' = any(roles)
  ) then
    raise exception 'Authenticated clients have a Realtime broadcast write policy';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'users receive own sync wakeups'
      and cmd = 'SELECT'
      and 'authenticated' = any(roles)
  ) then
    raise exception 'User-scoped Realtime receive policy is missing';
  end if;
end;
$$;

create or replace function public.tsurfing_test_realtime_wakeup_rls(
  user_a uuid,
  user_b uuid
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public, realtime
as $$
begin
  if not exists (
    select 1 from public.sync_wakeup_state where user_id = user_a
  ) then
    raise exception 'Authenticated user cannot read own wake-up state';
  end if;
  if exists (
    select 1 from public.sync_wakeup_state where user_id = user_b
  ) then
    raise exception 'Authenticated user can read another user wake-up state';
  end if;
  if not exists (
    select 1 from realtime.messages
    where topic = 'tsurfing:user:' || user_a::text
      and extension = 'broadcast'
  ) then
    raise exception 'Authenticated user cannot receive own wake-up topic';
  end if;

  perform set_config('realtime.topic', 'tsurfing:user:' || user_b::text, true);
  if exists (select 1 from realtime.messages) then
    raise exception 'Authenticated user can receive another user wake-up topic';
  end if;
  perform set_config('realtime.topic', 'tsurfing:user:' || user_a::text, true);

  begin
    update public.sync_wakeup_state set version = version + 1 where user_id = user_a;
    raise exception 'Authenticated user changed server wake-up state';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into realtime.messages (topic, extension, event, payload, private)
    values ('tsurfing:user:' || user_a::text, 'broadcast', 'sync_wakeup', '{}'::jsonb, true);
    raise exception 'Authenticated user forged a Realtime wake-up';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;
grant execute on function public.tsurfing_test_realtime_wakeup_rls(uuid, uuid)
to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('realtime.topic', 'tsurfing:user:11111111-1111-4111-8111-111111111111', true);
select public.tsurfing_test_realtime_wakeup_rls(
  '11111111-1111-4111-8111-111111111111',
  '22222222-1111-4111-8111-111111111111'
);
reset role;

rollback;
