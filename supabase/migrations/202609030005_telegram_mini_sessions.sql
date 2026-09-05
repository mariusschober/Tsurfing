-- One-time Telegram Mini App authentication exchange. Raw initData and bearer
-- tokens are never persisted; only SHA-256 fingerprints are stored. These are
-- ephemeral security records and are intentionally not backup/restore data.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'telegram_identities_user_pair_unique'
      and conrelid = 'public.telegram_identities'::regclass
  ) then
    alter table public.telegram_identities
      add constraint telegram_identities_user_pair_unique
      unique (telegram_user_id, user_id);
  end if;
end;
$$;

create table if not exists public.telegram_mini_sessions (
  id uuid primary key,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  init_data_hash text not null unique check (init_data_hash ~ '^[0-9a-f]{64}$'),
  telegram_user_id bigint not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  auth_date timestamptz not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint telegram_mini_sessions_identity_fk
    foreign key (telegram_user_id, user_id)
    references public.telegram_identities(telegram_user_id, user_id)
    on update cascade on delete cascade,
  constraint telegram_mini_sessions_expiry_check check (expires_at > created_at)
);

create index if not exists telegram_mini_sessions_active_token_idx
  on public.telegram_mini_sessions (token_hash, expires_at)
  where revoked_at is null;
create index if not exists telegram_mini_sessions_user_idx
  on public.telegram_mini_sessions (user_id, created_at desc);

alter table public.telegram_mini_sessions enable row level security;
revoke all privileges on table public.telegram_mini_sessions from public, anon, authenticated, service_role;

create or replace function public.goalflow_create_telegram_mini_session(
  target_session_id uuid,
  target_token_hash text,
  target_init_data_hash text,
  target_telegram_user_id bigint,
  target_auth_date timestamptz,
  target_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_user_id uuid;
begin
  if target_session_id is null
    or target_token_hash is null
    or target_init_data_hash is null
    or target_telegram_user_id is null
    or target_auth_date is null
    or target_expires_at is null
    or target_token_hash !~ '^[0-9a-f]{64}$'
    or target_init_data_hash !~ '^[0-9a-f]{64}$'
    or target_telegram_user_id <= 0
    or target_auth_date < clock_timestamp() - interval '15 minutes'
    or target_auth_date > clock_timestamp() + interval '1 minute'
    or target_expires_at <= clock_timestamp()
    or target_expires_at > clock_timestamp() + interval '1 hour' then
    raise exception using errcode = '22023', message = 'Invalid Telegram Mini App session';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('telegram-mini-init:' || target_init_data_hash, 0));
  if exists (
    select 1 from public.telegram_mini_sessions
    where init_data_hash = target_init_data_hash
  ) then
    return jsonb_build_object('state', 'replay');
  end if;

  select identity.user_id into linked_user_id
  from public.telegram_identities identity
  join public.profiles profile on profile.user_id = identity.user_id
  where identity.telegram_user_id = target_telegram_user_id
    and identity.bot_access_granted is true
    and profile.status = 'active'
  for share of identity, profile;
  if not found then return jsonb_build_object('state', 'inactive'); end if;

  begin
    insert into public.telegram_mini_sessions (
      id, token_hash, init_data_hash, telegram_user_id, user_id,
      auth_date, expires_at
    ) values (
      target_session_id, target_token_hash, target_init_data_hash,
      target_telegram_user_id, linked_user_id, target_auth_date,
      target_expires_at
    );
  exception when unique_violation then
    if exists (
      select 1 from public.telegram_mini_sessions
      where init_data_hash = target_init_data_hash
    ) then
      return jsonb_build_object('state', 'replay');
    end if;
    return jsonb_build_object('state', 'unavailable');
  end;

  return jsonb_build_object(
    'state', 'created',
    'userId', linked_user_id,
    'telegramUserId', target_telegram_user_id
  );
end;
$$;

create or replace function public.goalflow_validate_telegram_mini_session(
  target_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  session_result jsonb;
begin
  if target_token_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  update public.telegram_mini_sessions session_row
  set last_seen_at = clock_timestamp()
  from public.telegram_identities identity, public.profiles profile
  where session_row.token_hash = target_token_hash
    and session_row.revoked_at is null
    and session_row.expires_at > clock_timestamp()
    and identity.telegram_user_id = session_row.telegram_user_id
    and identity.user_id = session_row.user_id
    and identity.bot_access_granted is true
    and profile.user_id = session_row.user_id
    and profile.status = 'active'
  returning jsonb_build_object(
    'userId', session_row.user_id,
    'telegramUserId', session_row.telegram_user_id,
    'expiresAt', session_row.expires_at
  ) into session_result;
  return session_result;
end;
$$;

create or replace function public.goalflow_revoke_telegram_mini_session(
  target_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.telegram_mini_sessions
  set revoked_at = coalesce(revoked_at, clock_timestamp())
  where token_hash = target_token_hash and revoked_at is null;
  return found;
end;
$$;

create or replace function public.goalflow_revoke_user_telegram_access(
  target_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  identity_changed boolean;
begin
  update public.telegram_identities
  set bot_access_granted = false, updated_at = clock_timestamp()
  where user_id = target_user_id and bot_access_granted is true;
  identity_changed := found;
  update public.telegram_mini_sessions
  set revoked_at = coalesce(revoked_at, clock_timestamp())
  where user_id = target_user_id and revoked_at is null;
  return identity_changed;
end;
$$;

revoke all on function public.goalflow_create_telegram_mini_session(uuid, text, text, bigint, timestamptz, timestamptz)
from public, anon, authenticated, service_role;
revoke all on function public.goalflow_validate_telegram_mini_session(text)
from public, anon, authenticated, service_role;
revoke all on function public.goalflow_revoke_telegram_mini_session(text)
from public, anon, authenticated, service_role;
revoke all on function public.goalflow_revoke_user_telegram_access(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.goalflow_create_telegram_mini_session(uuid, text, text, bigint, timestamptz, timestamptz)
to service_role;
grant execute on function public.goalflow_validate_telegram_mini_session(text) to service_role;
grant execute on function public.goalflow_revoke_telegram_mini_session(text) to service_role;
grant execute on function public.goalflow_revoke_user_telegram_access(uuid) to service_role;
