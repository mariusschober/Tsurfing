-- Confirm a Telegram capture and create its task in one transaction. The task
-- RPC retains its durable receipt semantics; this wrapper closes the state gap
-- between a committed task and a separately updated capture row.

create or replace function public.goalflow_confirm_telegram_capture(
  target_user_id uuid,
  target_capture_id uuid,
  target_mutation_id uuid,
  target_local_date date,
  task_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  capture_row public.telegram_captures%rowtype;
  task_response jsonb;
  changed_rows integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    target_user_id::text || ':telegram-capture:' || target_capture_id::text,
    0
  ));

  select * into capture_row
  from public.telegram_captures
  where id = target_capture_id and user_id = target_user_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Telegram capture was not found';
  end if;
  if capture_row.state not in ('pending', 'confirmed') then
    raise exception using errcode = '22023', message = 'Telegram capture is no longer pending';
  end if;
  if capture_row.state = 'pending' and capture_row.expires_at <= clock_timestamp() then
    raise exception using errcode = '22023', message = 'Telegram capture expired';
  end if;
  if not exists (
    select 1 from public.profiles
    where user_id = target_user_id and status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Goalflow account is not active';
  end if;
  if coalesce(task_payload->>'taskId', '') <> target_capture_id::text
    or coalesce(task_payload->>'source', '') <> 'telegram'
    or trim(coalesce(task_payload->>'title', '')) <> capture_row.title then
    raise exception using errcode = '22023', message = 'Telegram task does not match its capture';
  end if;

  task_response := public.goalflow_create_task_idempotent(
    target_user_id,
    target_mutation_id,
    target_local_date,
    task_payload
  );
  if task_response->>'id' <> target_capture_id::text
    or task_response->>'user_id' <> target_user_id::text
    or task_response->>'source' <> 'telegram' then
    raise exception using errcode = 'XX000', message = 'Telegram task acknowledgment was invalid';
  end if;

  if capture_row.state = 'pending' then
    update public.telegram_captures
    set state = 'confirmed'
    where id = target_capture_id
      and user_id = target_user_id
      and state = 'pending';
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Telegram capture state changed';
    end if;
  end if;
  return task_response;
end;
$$;

revoke all on function public.goalflow_confirm_telegram_capture(uuid, uuid, uuid, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.goalflow_confirm_telegram_capture(uuid, uuid, uuid, date, jsonb)
  to service_role;
