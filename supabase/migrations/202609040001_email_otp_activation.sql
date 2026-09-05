-- Typed email OTP enrollment and sign-in activation.
--
-- Every request receives a high-entropy opaque token, but only the SHA-256
-- digest is retained. The token is bound to the normalized email, approval
-- basis, CAPTCHA-backed delivery, ten-minute lifetime, and finally the
-- immutable Supabase Auth UUID. Direct client access remains closed.

begin;

create table public.email_otp_attempts (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (length(token_hash) = 64),
  email text not null check (
    email = lower(btrim(email))
    and char_length(email) between 3 and 320
  ),
  purpose text not null check (purpose in ('sign_in', 'activation')),
  approval text not null check (approval in ('existing_account', 'invite', 'denied')),
  invite_id uuid references public.invite_codes(id) on delete restrict,
  captcha_token_hash text not null check (length(captcha_token_hash) = 64),
  captcha_verified_at timestamptz,
  request_ip_hash text not null check (length(request_ip_hash) = 64),
  delivery_state text not null default 'pending'
    check (delivery_state in ('pending', 'sent', 'unconfirmed', 'suppressed')),
  state text not null default 'pending'
    check (state in ('pending', 'used', 'expired', 'rejected')),
  expires_at timestamptz not null,
  auth_user_id uuid references auth.users(id) on delete set null,
  auth_session_id uuid,
  authenticated_at timestamptz,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  check ((approval = 'invite') = (invite_id is not null)),
  check ((state = 'used') = (used_at is not null))
);

create index email_otp_attempts_email_created_idx
  on public.email_otp_attempts (email, created_at desc);
create index email_otp_attempts_ip_created_idx
  on public.email_otp_attempts (request_ip_hash, created_at desc);
create index email_otp_attempts_pending_expiry_idx
  on public.email_otp_attempts (expires_at)
  where state = 'pending';

alter table public.email_otp_attempts enable row level security;
alter table public.email_otp_attempts force row level security;
revoke all privileges on table public.email_otp_attempts from public, anon, authenticated;
grant all privileges on table public.email_otp_attempts to service_role;

create or replace function public.goalflow_create_email_otp_attempt(
  target_token_hash text,
  target_email text,
  target_purpose text,
  target_invite_code_hash text,
  target_captcha_token_hash text,
  target_request_ip_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_email text := lower(btrim(target_email));
  selected_invite public.invite_codes%rowtype;
  selected_approval text;
  selected_attempt_id uuid;
begin
  if length(target_token_hash) <> 64
    or length(target_captcha_token_hash) <> 64
    or length(target_request_ip_hash) <> 64
    or char_length(normalized_email) not between 3 and 320
    or normalized_email <> target_email
    or target_purpose not in ('sign_in', 'activation') then
    return jsonb_build_object('created', false, 'reason', 'invalid');
  end if;

  -- Serialize cooldown and quota decisions for the same email and source.
  perform pg_advisory_xact_lock(hashtextextended('email-otp-email:' || normalized_email, 0));
  perform pg_advisory_xact_lock(hashtextextended('email-otp-ip:' || target_request_ip_hash, 0));

  if exists (
    select 1 from public.email_otp_attempts attempt
    where attempt.email = normalized_email
      and attempt.created_at > now() - interval '60 seconds'
  ) or (
    select count(*) from public.email_otp_attempts attempt
    where attempt.email = normalized_email
      and attempt.created_at > now() - interval '10 minutes'
  ) >= 5 or (
    select count(*) from public.email_otp_attempts attempt
    where attempt.request_ip_hash = target_request_ip_hash
      and attempt.created_at > now() - interval '10 minutes'
  ) >= 20 then
    return jsonb_build_object('created', false, 'reason', 'limited');
  end if;

  if target_purpose = 'sign_in' then
    selected_approval := 'existing_account';
  else
    select * into selected_invite
    from public.invite_codes invite
    where invite.code_hash = target_invite_code_hash
      and invite.disabled_at is null
      and invite.expires_at > now()
      and invite.use_count < invite.max_uses;
    selected_approval := case when found then 'invite' else 'denied' end;
  end if;

  insert into public.email_otp_attempts (
    token_hash,
    email,
    purpose,
    approval,
    invite_id,
    captcha_token_hash,
    request_ip_hash,
    expires_at
  ) values (
    target_token_hash,
    normalized_email,
    target_purpose,
    selected_approval,
    case when selected_approval = 'invite' then selected_invite.id else null end,
    target_captcha_token_hash,
    target_request_ip_hash,
    now() + interval '10 minutes'
  )
  returning id into selected_attempt_id;

  return jsonb_build_object(
    'created', true,
    'attemptId', selected_attempt_id,
    'shouldCreateUser', selected_approval = 'invite'
  );
end;
$$;

create or replace function public.goalflow_mark_email_otp_delivery(
  target_attempt_id uuid,
  target_captcha_token_hash text,
  target_delivered boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.email_otp_attempts attempt
  set delivery_state = case when target_delivered then 'sent' else 'unconfirmed' end,
      captcha_verified_at = case when target_delivered then now() else null end
  where attempt.id = target_attempt_id
    and attempt.state = 'pending'
    and attempt.expires_at > now()
    and attempt.captcha_token_hash = target_captcha_token_hash
    and attempt.delivery_state = 'pending';
  return found;
end;
$$;

create or replace function public.activate_goalflow_email_otp(
  target_token_hash text,
  target_user_id uuid,
  target_email text,
  target_session_id uuid,
  target_authenticated_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt public.email_otp_attempts%rowtype;
  invite public.invite_codes%rowtype;
  normalized_email text := lower(btrim(target_email));
  inserted_redemption_count integer := 0;
begin
  select * into attempt
  from public.email_otp_attempts candidate
  where candidate.token_hash = target_token_hash
    and candidate.email = normalized_email
  for update;

  if not found then
    return false;
  end if;
  if attempt.state = 'used' then
    return attempt.auth_user_id = target_user_id
      and attempt.auth_session_id = target_session_id
      and attempt.authenticated_at = target_authenticated_at
      and exists (
        select 1 from public.profiles profile
        where profile.user_id = target_user_id
          and lower(profile.email) = normalized_email
          and profile.status = 'active'
      );
  end if;
  if attempt.state <> 'pending' or attempt.expires_at <= now() then
    update public.email_otp_attempts
    set state = 'expired'
    where id = attempt.id and state = 'pending';
    return false;
  end if;
  if attempt.delivery_state <> 'sent' or attempt.captcha_verified_at is null then
    update public.email_otp_attempts
    set state = 'rejected'
    where id = attempt.id and state = 'pending';
    return false;
  end if;
  -- The service validates the JWT with Supabase Auth before invoking this
  -- server-only function and passes its signed session_id plus newest
  -- otp/email-signup AMR timestamp. Requiring both to post-date the preflight
  -- prevents an already-open session from skipping the typed code.
  if target_authenticated_at < attempt.created_at - interval '5 seconds'
    or target_authenticated_at > now() + interval '5 minutes'
    or not exists (
      select 1
      from auth.sessions auth_session
      where auth_session.id = target_session_id
        and auth_session.user_id = target_user_id
        and auth_session.created_at >= attempt.created_at - interval '5 seconds'
    ) then
    return false;
  end if;
  if not exists (
    select 1
    from auth.users auth_user
    where auth_user.id = target_user_id
      and lower(auth_user.email) = normalized_email
      and auth_user.email_confirmed_at is not null
  ) then
    return false;
  end if;

  -- Existing active accounts never consume another invite. This also makes an
  -- exact retry after a lost HTTP acknowledgement safe.
  if exists (
    select 1 from public.profiles profile
    where profile.user_id = target_user_id
      and lower(profile.email) = normalized_email
      and profile.status = 'active'
  ) then
    update public.email_otp_attempts
    set state = 'used',
        auth_user_id = target_user_id,
        auth_session_id = target_session_id,
        authenticated_at = target_authenticated_at,
        used_at = now()
    where id = attempt.id and state = 'pending';
    return found;
  end if;

  if attempt.purpose <> 'activation'
    or attempt.approval <> 'invite'
    or attempt.invite_id is null
    or exists (select 1 from public.profiles profile where profile.user_id = target_user_id) then
    update public.email_otp_attempts
    set state = 'rejected'
    where id = attempt.id and state = 'pending';
    return false;
  end if;

  select * into invite
  from public.invite_codes candidate
  where candidate.id = attempt.invite_id
    and candidate.disabled_at is null
    and candidate.expires_at > now()
    and candidate.use_count < candidate.max_uses
  for update;
  if not found then
    update public.email_otp_attempts
    set state = 'rejected'
    where id = attempt.id and state = 'pending';
    return false;
  end if;

  insert into public.invite_redemptions (invite_id, email, auth_user_id)
  values (invite.id, normalized_email, target_user_id)
  on conflict (invite_id, email) do nothing;
  get diagnostics inserted_redemption_count = row_count;

  if inserted_redemption_count <> 1 then
    return false;
  end if;

  update public.invite_codes
  set use_count = use_count + 1
  where id = invite.id;

  insert into public.profiles (user_id, email, role, status, invited_by)
  values (target_user_id, normalized_email, 'beta', 'active', invite.created_by);
  insert into public.entitlements (user_id, plan, active)
  values (target_user_id, 'full_beta', true);

  update public.email_otp_attempts
  set state = 'used',
      auth_user_id = target_user_id,
      auth_session_id = target_session_id,
      authenticated_at = target_authenticated_at,
      used_at = now()
  where id = attempt.id and state = 'pending';
  if not found then
    raise exception using errcode = '40001', message = 'Email OTP activation changed concurrently';
  end if;
  return true;
end;
$$;

-- The metadata-authorized predecessor is deliberately retired. Existing
-- migration text stays immutable, but no current server path may invoke it.
revoke all on function public.activate_goalflow_email_beta(uuid, uuid, text)
from public, anon, authenticated, service_role;

revoke all on function public.goalflow_create_email_otp_attempt(text, text, text, text, text, text)
from public, anon, authenticated, service_role;
revoke all on function public.goalflow_mark_email_otp_delivery(uuid, text, boolean)
from public, anon, authenticated, service_role;
revoke all on function public.activate_goalflow_email_otp(text, uuid, text, uuid, timestamptz)
from public, anon, authenticated, service_role;

grant execute on function public.goalflow_create_email_otp_attempt(text, text, text, text, text, text)
to service_role;
grant execute on function public.goalflow_mark_email_otp_delivery(uuid, text, boolean)
to service_role;
grant execute on function public.activate_goalflow_email_otp(text, uuid, text, uuid, timestamptz)
to service_role;

commit;
