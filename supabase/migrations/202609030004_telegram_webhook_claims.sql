-- Atomically claim Telegram updates so concurrent webhook deliveries cannot
-- execute the same logical operation twice. Processing leases make a claim
-- recoverable when a process dies before recording the durable outcome.

alter table public.telegram_updates
  add column if not exists processing_lease_id uuid,
  add column if not exists processing_lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0;

alter table public.telegram_updates
  drop constraint if exists telegram_updates_outcome_check;
alter table public.telegram_updates
  add constraint telegram_updates_outcome_check
  check (outcome in ('received', 'processing', 'processed', 'error')) not valid;
alter table public.telegram_updates validate constraint telegram_updates_outcome_check;

alter table public.telegram_updates
  drop constraint if exists telegram_updates_attempt_count_check;
alter table public.telegram_updates
  add constraint telegram_updates_attempt_count_check
  check (attempt_count >= 0) not valid;
alter table public.telegram_updates validate constraint telegram_updates_attempt_count_check;

create index if not exists telegram_updates_processing_lease_idx
  on public.telegram_updates (processing_lease_expires_at)
  where outcome = 'processing';

create or replace function public.goalflow_claim_telegram_update(
  target_update_id bigint,
  target_telegram_user_id bigint,
  target_payload jsonb,
  target_lease_id uuid,
  target_lease_seconds integer default 60
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_update public.telegram_updates%rowtype;
  lease_until timestamptz;
begin
  if target_update_id < 0 or target_payload is null or target_lease_id is null then
    raise exception using errcode = '22023', message = 'Invalid Telegram update claim';
  end if;
  lease_until := clock_timestamp()
    + make_interval(secs => least(greatest(target_lease_seconds, 5), 300));

  insert into public.telegram_updates (
    update_id, telegram_user_id, payload, outcome, processed_at,
    processing_lease_id, processing_lease_expires_at, attempt_count
  ) values (
    target_update_id, target_telegram_user_id, target_payload, 'processing', null,
    target_lease_id, lease_until, 1
  )
  on conflict (update_id) do nothing;
  if found then return 'claimed'; end if;

  select * into existing_update
  from public.telegram_updates
  where update_id = target_update_id
  for update;
  if not found then return 'unavailable'; end if;

  if existing_update.payload is not null and existing_update.payload <> target_payload then
    return 'collision';
  end if;
  if existing_update.telegram_user_id is not null
    and existing_update.telegram_user_id is distinct from target_telegram_user_id then
    return 'collision';
  end if;
  if existing_update.outcome = 'processed' then return 'duplicate'; end if;
  if existing_update.outcome = 'processing'
    and existing_update.processing_lease_expires_at > clock_timestamp() then
    return 'busy';
  end if;

  update public.telegram_updates
  set telegram_user_id = coalesce(telegram_user_id, target_telegram_user_id),
      payload = coalesce(payload, target_payload),
      processed_at = null,
      outcome = 'processing',
      error_code = null,
      processing_lease_id = target_lease_id,
      processing_lease_expires_at = lease_until,
      attempt_count = attempt_count + 1
  where update_id = target_update_id;
  return 'claimed';
end;
$$;

create or replace function public.goalflow_complete_telegram_update(
  target_update_id bigint,
  target_lease_id uuid,
  target_outcome text,
  target_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_outcome not in ('processed', 'error') then
    raise exception using errcode = '22023', message = 'Invalid Telegram update outcome';
  end if;
  update public.telegram_updates
  set processed_at = clock_timestamp(),
      outcome = target_outcome,
      error_code = case when target_outcome = 'processed' then null
        else coalesce(nullif(target_error_code, ''), 'processing_failed') end,
      processing_lease_id = null,
      processing_lease_expires_at = null
  where update_id = target_update_id
    and processing_lease_id = target_lease_id
    and outcome = 'processing';
  return found;
end;
$$;

revoke all on function public.goalflow_claim_telegram_update(bigint, bigint, jsonb, uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function public.goalflow_complete_telegram_update(bigint, uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.goalflow_claim_telegram_update(bigint, bigint, jsonb, uuid, integer)
to service_role;
grant execute on function public.goalflow_complete_telegram_update(bigint, uuid, text, text)
to service_role;
