-- Bind Telegram beta activation to immutable Supabase and Telegram identities.
--
-- Supabase owns OAuth state and PKCE. Tsurfing stores only a hash of its
-- independent invite attempt. The first committed activation records the
-- immutable identities so an exact retry after a lost HTTP acknowledgement is
-- successful, while every cross-user or cross-Telegram replay is rejected.

begin;

alter table public.telegram_auth_attempts
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
  add column if not exists telegram_user_id bigint,
  add constraint telegram_auth_attempts_telegram_user_positive
    check (telegram_user_id is null or telegram_user_id > 0);

create index if not exists telegram_auth_attempts_auth_user_idx
  on public.telegram_auth_attempts (auth_user_id)
  where auth_user_id is not null;

alter table public.telegram_auth_attempts enable row level security;
alter table public.telegram_auth_attempts force row level security;
revoke all privileges on table public.telegram_auth_attempts from public, anon, authenticated;
grant all privileges on table public.telegram_auth_attempts to service_role;

create or replace function public.activate_telegram_beta(
  target_token_hash text,
  target_user_id uuid,
  target_telegram_user_id bigint,
  target_telegram_username text,
  target_email text,
  target_oauth_state text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  attempt public.telegram_auth_attempts%rowtype;
  invite public.invite_codes%rowtype;
  identity_email text;
  inserted_redemption_count integer := 0;
begin
  if length(target_token_hash) <> 64
    or target_user_id is null
    or target_telegram_user_id is null
    or target_telegram_user_id <= 0 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('telegram-activation:' || target_token_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('telegram-link-user:' || target_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('telegram-link-id:' || target_telegram_user_id::text, 0));

  select * into attempt
  from public.telegram_auth_attempts candidate
  where candidate.token_hash = target_token_hash
  for update;
  if not found then
    return false;
  end if;

  if attempt.state = 'used' then
    return attempt.auth_user_id = target_user_id
      and attempt.telegram_user_id = target_telegram_user_id
      and exists (
        select 1 from public.profiles profile
        where profile.user_id = target_user_id and profile.status = 'active'
      )
      and exists (
        select 1 from public.telegram_identities identity
        where identity.user_id = target_user_id
          and identity.telegram_user_id = target_telegram_user_id
      );
  end if;

  if attempt.state <> 'pending' or attempt.expires_at <= clock_timestamp() then
    update public.telegram_auth_attempts
    set state = 'expired'
    where id = attempt.id and state = 'pending';
    return false;
  end if;

  -- Pending attempts created by the retired client-managed state flow cannot
  -- safely cross the boundary into Supabase-managed OAuth state.
  if attempt.oauth_state_hash is not null
    or attempt.code_challenge is not null
    or attempt.code_challenge_method is not null
    or target_oauth_state is not null then
    update public.telegram_auth_attempts
    set state = 'expired'
    where id = attempt.id and state = 'pending';
    return false;
  end if;

  select lower(coalesce(
    nullif(btrim(auth_user.email), ''),
    'telegram-' || target_telegram_user_id || '@users.goalflow.invalid'
  )) into identity_email
  from auth.users auth_user
  where auth_user.id = target_user_id;
  if not found then
    return false;
  end if;

  -- An active account must use the explicit identity-linking endpoint. This
  -- activation path is solely for an approved new beta account.
  if exists (select 1 from public.profiles profile where profile.user_id = target_user_id)
    or exists (
      select 1 from public.telegram_identities identity
      where identity.telegram_user_id = target_telegram_user_id
        and identity.user_id <> target_user_id
    ) then
    return false;
  end if;

  select * into invite
  from public.invite_codes candidate
  where candidate.id = attempt.invite_id
    and candidate.disabled_at is null
    and candidate.expires_at > clock_timestamp()
    and candidate.use_count < candidate.max_uses
  for update;
  if not found then
    return false;
  end if;

  insert into public.invite_redemptions (invite_id, email, auth_user_id)
  values (invite.id, identity_email, target_user_id)
  on conflict (invite_id, email) do nothing;
  get diagnostics inserted_redemption_count = row_count;
  if inserted_redemption_count <> 1 then
    return false;
  end if;

  update public.invite_codes
  set use_count = use_count + 1
  where id = invite.id;

  insert into public.profiles (user_id, email, role, status, invited_by)
  values (target_user_id, identity_email, 'beta', 'active', invite.created_by);
  insert into public.telegram_identities (
    telegram_user_id, user_id, telegram_username, bot_access_granted
  ) values (
    target_telegram_user_id,
    target_user_id,
    nullif(btrim(target_telegram_username), ''),
    true
  );
  insert into public.entitlements (user_id, plan, active)
  values (target_user_id, 'full_beta', true);

  update public.telegram_auth_attempts
  set state = 'used',
      auth_user_id = target_user_id,
      telegram_user_id = target_telegram_user_id,
      used_at = clock_timestamp()
  where id = attempt.id and state = 'pending';
  if not found then
    raise exception using errcode = '40001', message = 'Telegram activation changed concurrently';
  end if;
  return true;
exception when unique_violation then
  return false;
end;
$$;

revoke all on function public.activate_telegram_beta(text, uuid, bigint, text, text, text)
from public, anon, authenticated, service_role;
revoke all on function public.activate_telegram_beta(text, uuid, bigint, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.activate_telegram_beta(text, uuid, bigint, text, text, text)
to service_role;

commit;
