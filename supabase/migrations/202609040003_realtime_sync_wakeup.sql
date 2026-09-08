-- Transactional, payload-free wake-up hints for the authoritative sync log.
--
-- A wake-up never carries application data and never replaces cursor pull.
-- It is committed atomically with sync_records, so rolled-back mutations do
-- not wake clients. Authenticated clients can read only their own wake state
-- and join only their own private Broadcast topic; they cannot write either.

begin;

create table if not exists public.sync_wakeup_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now()
);

alter table public.sync_wakeup_state enable row level security;
alter table public.sync_wakeup_state force row level security;
revoke all privileges on table public.sync_wakeup_state
from public, anon, authenticated;
grant all privileges on table public.sync_wakeup_state to service_role;
grant select on table public.sync_wakeup_state to authenticated;

drop policy if exists "users read own sync wakeup state"
  on public.sync_wakeup_state;
create policy "users read own sync wakeup state"
  on public.sync_wakeup_state
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.tsurfing_signal_sync_wakeup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  target_user_id uuid;
begin
  target_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;

  insert into public.sync_wakeup_state as existing (user_id, version, updated_at)
  values (target_user_id, 1, clock_timestamp())
  on conflict (user_id) do update
    set version = existing.version + 1,
        updated_at = excluded.updated_at;

  perform realtime.send(
    '{}'::jsonb,
    'sync_wakeup',
    'tsurfing:user:' || target_user_id::text,
    true
  );

  -- Ownership changes are not part of the normal protocol. If a privileged
  -- repair ever moves a record, wake both accounts instead of leaving the old
  -- account with stale state.
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    insert into public.sync_wakeup_state as existing (user_id, version, updated_at)
    values (old.user_id, 1, clock_timestamp())
    on conflict (user_id) do update
      set version = existing.version + 1,
          updated_at = excluded.updated_at;

    perform realtime.send(
      '{}'::jsonb,
      'sync_wakeup',
      'tsurfing:user:' || old.user_id::text,
      true
    );
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.tsurfing_signal_sync_wakeup()
from public, anon, authenticated, service_role;

drop trigger if exists tsurfing_sync_wakeup_trigger on public.sync_records;
create trigger tsurfing_sync_wakeup_trigger
after insert or update or delete on public.sync_records
for each row execute function public.tsurfing_signal_sync_wakeup();

-- Realtime owns this managed table. Supabase explicitly supports policies on
-- it for private-channel authorization; do not alter its schema or grants.
drop policy if exists "users receive own sync wakeups" on realtime.messages;
create policy "users receive own sync wakeups"
on realtime.messages
for select
to authenticated
using (
  (select realtime.topic()) = 'tsurfing:user:' || (select auth.uid())::text
  and realtime.messages.extension = 'broadcast'
);

-- Intentionally no INSERT policy: a client may receive its own server signal
-- but cannot broadcast or forge one for itself or another account.

commit;
