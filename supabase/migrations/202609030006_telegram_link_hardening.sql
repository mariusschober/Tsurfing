-- Link and unlink Telegram identities inside database transactions. This keeps
-- service-role callers from bypassing cross-account ownership checks and
-- revokes every cached Mini App session when the binding changes.

create or replace function public.goalflow_link_telegram_identity(
  target_user_id uuid,
  target_telegram_user_id bigint,
  target_telegram_username text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_for_telegram public.telegram_identities%rowtype;
  existing_for_user public.telegram_identities%rowtype;
begin
  if target_user_id is null or target_telegram_user_id is null or target_telegram_user_id <= 0 then
    raise exception using errcode = '22023', message = 'Invalid Telegram identity link';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('telegram-link-user:' || target_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('telegram-link-id:' || target_telegram_user_id::text, 0));
  if not exists (
    select 1 from public.profiles
    where user_id = target_user_id and status = 'active'
  ) then return false; end if;

  select * into existing_for_telegram
  from public.telegram_identities
  where telegram_user_id = target_telegram_user_id
  for update;
  if found and existing_for_telegram.user_id <> target_user_id then return false; end if;

  select * into existing_for_user
  from public.telegram_identities
  where user_id = target_user_id
  for update;
  if found then
    if existing_for_user.telegram_user_id <> target_telegram_user_id then
      update public.telegram_mini_sessions
      set revoked_at = coalesce(revoked_at, clock_timestamp())
      where user_id = target_user_id and revoked_at is null;
    end if;
    update public.telegram_identities
    set telegram_user_id = target_telegram_user_id,
        telegram_username = nullif(trim(target_telegram_username), ''),
        bot_access_granted = true,
        updated_at = clock_timestamp()
    where user_id = target_user_id;
  else
    insert into public.telegram_identities (
      telegram_user_id, user_id, telegram_username, bot_access_granted
    ) values (
      target_telegram_user_id, target_user_id,
      nullif(trim(target_telegram_username), ''), true
    );
  end if;
  return true;
exception when unique_violation then
  return false;
end;
$$;

revoke all on function public.goalflow_link_telegram_identity(uuid, bigint, text)
from public, anon, authenticated, service_role;
grant execute on function public.goalflow_link_telegram_identity(uuid, bigint, text)
to service_role;
