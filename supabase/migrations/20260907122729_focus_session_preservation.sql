-- Keep focus actions independent of daily tracking counters while preserving
-- the deployed transport, original mutation fingerprints, and audit receipts.
create or replace function public.goalflow_focus_session_time(focus jsonb)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  phase text;
  field text;
  stamp timestamptz;
  action_time timestamptz;
  start_time timestamptz;
  duration numeric;
  elapsed numeric;
begin
  if jsonb_typeof(focus) is distinct from 'object'
    or focus->'schemaVersion' is distinct from '1'::jsonb
    or jsonb_typeof(focus->'sessionId') is distinct from 'string'
    or (focus->>'sessionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(focus->'taskId') is distinct from 'string'
    or length(btrim(focus->>'taskId')) not between 1 and 240
    or jsonb_typeof(focus->'plannedDurationSeconds') is distinct from 'number'
    or jsonb_typeof(focus->'elapsedSeconds') is distinct from 'number'
    or jsonb_typeof(focus->'phase') is distinct from 'string'
    or (focus->>'phase') not in ('active','paused','stopped','completed') then
    raise exception using errcode='22023', message='Invalid shared focus session';
  end if;
  duration := (focus->>'plannedDurationSeconds')::numeric;
  elapsed := (focus->>'elapsedSeconds')::numeric;
  if duration <> trunc(duration) or duration not between 60 and 86400
    or elapsed <> trunc(elapsed) or elapsed not between 0 and 9007199254740991 then
    raise exception using errcode='22023', message='Invalid shared focus duration';
  end if;
  phase := focus->>'phase';
  if (phase='active' and (focus->'pausedAt' is distinct from 'null'::jsonb or focus->'endedAt' is distinct from 'null'::jsonb))
    or (phase='paused' and (jsonb_typeof(focus->'pausedAt') is distinct from 'string' or focus->'endedAt' is distinct from 'null'::jsonb))
    or (phase in ('stopped','completed') and (jsonb_typeof(focus->'endedAt') is distinct from 'string' or focus->'pausedAt' is distinct from 'null'::jsonb)) then
    raise exception using errcode='22023', message='Inconsistent shared focus phase';
  end if;
  foreach field in array array['startedAt','updatedAt','pausedAt','endedAt'] loop
    if field in ('pausedAt','endedAt') and focus->field='null'::jsonb then continue; end if;
    if jsonb_typeof(focus->field) is distinct from 'string'
      or (focus->>field) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
      raise exception using errcode='22023', message='Shared focus timestamps require an explicit timezone';
    end if;
    begin stamp := (focus->>field)::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
      raise exception using errcode='22023', message='Invalid shared focus timestamp';
    end;
    if not isfinite(stamp) then raise exception using errcode='22023', message='Invalid shared focus timestamp'; end if;
  end loop;
  action_time := (focus->>'updatedAt')::timestamptz;
  start_time := (focus->>'startedAt')::timestamptz;
  if action_time > now() + interval '5 minutes' or start_time > action_time
    or (phase='paused' and ((focus->>'pausedAt')::timestamptz not between start_time and action_time))
    or (phase in ('stopped','completed') and ((focus->>'endedAt')::timestamptz not between start_time and action_time)) then
    raise exception using errcode='22023', message='Shared focus timestamps are inconsistent or ahead of the server clock';
  end if;
  return action_time;
end;
$$;
revoke all on function public.goalflow_focus_session_time(jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_focus_session_time(jsonb) to service_role;

create or replace function public.goalflow_merge_tracking_focus(previous_payload jsonb, next_payload jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  old_focus jsonb := previous_payload->'focusSession';
  new_focus jsonb := next_payload->'focusSession';
  old_time timestamptz;
  new_time timestamptz;
begin
  if old_focus='null'::jsonb then old_focus := null; end if;
  if new_focus='null'::jsonb then new_focus := null; end if;
  if old_focus is not null then old_time := public.goalflow_focus_session_time(old_focus); end if;
  if new_focus is not null then new_time := public.goalflow_focus_session_time(new_focus); end if;
  if old_focus is null and new_focus is null then return next_payload; end if;
  if jsonb_typeof(next_payload) is distinct from 'object' then
    raise exception using errcode='22023', message='Tracking with a focus session must remain an object';
  end if;
  if old_focus is null then return next_payload; end if;
  if new_focus is not null and new_focus->>'sessionId'=old_focus->>'sessionId'
    and new_focus->>'taskId' is distinct from old_focus->>'taskId' then
    raise exception using errcode='22023', message='A shared focus session cannot change task identity';
  end if;
  -- Missing/null is a legacy writer, never an instruction to clear focus.
  -- A stopped/completed session can only be replaced by a new session identity.
  if new_focus is null or new_time <= old_time
    or (new_focus->>'sessionId'=old_focus->>'sessionId'
      and old_focus->>'phase' in ('stopped','completed') and new_focus->>'phase' in ('active','paused')) then
    return jsonb_set(next_payload,'{focusSession}',old_focus,true);
  end if;
  return next_payload;
end;
$$;
revoke all on function public.goalflow_merge_tracking_focus(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_merge_tracking_focus(jsonb,jsonb) to service_role;

create or replace function public.preserve_goalflow_tracking_focus()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.entity_type='tracking' and new.entity_id='singleton' then
    if tg_op='UPDATE' then
      new.payload := public.goalflow_merge_tracking_focus(old.payload,new.payload);
    else
      new.payload := public.goalflow_merge_tracking_focus(null,new.payload);
    end if;
    if new.deleted_at is not null and new.payload->'focusSession' is not null
      and new.payload->'focusSession'<>'null'::jsonb then
      raise exception using errcode='22023', message='Use an explicit stopped or completed focus session instead of deleting tracking';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.preserve_goalflow_tracking_focus() from public,anon,authenticated;
grant execute on function public.preserve_goalflow_tracking_focus() to service_role;
create trigger preserve_goalflow_tracking_focus_trigger
before insert or update of payload,deleted_at on public.sync_records
for each row execute function public.preserve_goalflow_tracking_focus();

-- Automatic reconciliation is a separate, audited operation. Existing push
-- fingerprints and receipts remain immutable, including rejected mutations.
create or replace function public.reconcile_goalflow_sync_change(
  target_user_id uuid,
  target_candidate jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  request_fingerprint text;
  operation_id uuid;
  existing_operation public.sync_mutations%rowtype;
  current_record public.sync_records%rowtype;
  original_conflict public.sync_conflicts%rowtype;
  latest jsonb;
  record_existed boolean;
  candidate_type text := target_candidate->>'entityType';
  candidate_id text := target_candidate->>'entityId';
  candidate_conflict text := target_candidate->>'conflictId';
  change_time timestamptz;
  next_version integer;
  push_result jsonb;
  winner text := 'cloud';
  audit_result jsonb;
  merged_payload jsonb;
  focus_projection jsonb;
  history_item jsonb;
  projection_time timestamptz;
begin
  if target_user_id is null or candidate_type is null or candidate_id is null
    or candidate_conflict is null or target_candidate->'localHistory' is null or candidate_type not in (
    'tasks','goals','habits','stats','progress','hashtags','accountability',
    'truenorth','amalgam','tracking','circadian','settings','daily_plans','task_events'
  ) or length(candidate_id) not between 1 and 240
    or length(candidate_conflict) not between 1 and 600
    or jsonb_typeof(target_candidate->'localHistory') <> 'array' then
    raise exception using errcode = '22023', message = 'Invalid automatic reconciliation candidate';
  end if;
  request_fingerprint := encode(digest(convert_to(
    'goalflow-auto-reconcile-v1:' || target_candidate::text, 'utf8'), 'sha256'), 'hex');
  -- A distinct deterministic operation identity makes network retries safe
  -- without reusing or rewriting any original client mutation identity.
  operation_id := (substr(request_fingerprint,1,8) || '-' || substr(request_fingerprint,9,4)
    || '-4' || substr(request_fingerprint,14,3) || '-8' || substr(request_fingerprint,18,3)
    || '-' || substr(request_fingerprint,21,12))::uuid;
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':' || operation_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':' || candidate_type || ':' || candidate_id, 0));
  select * into existing_operation from public.sync_mutations
    where user_id=target_user_id and mutation_id=operation_id;
  if found and (existing_operation.request_hash is distinct from request_fingerprint
    or existing_operation.result->>'operation' is distinct from 'automatic-reconciliation') then
    raise exception using errcode = '22023', message = 'Reconciliation operation identity mismatch';
  end if;

  if existing_operation.mutation_id is null then
    if candidate_conflict ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      select * into original_conflict from public.sync_conflicts
        where id=candidate_conflict::uuid and user_id=target_user_id for update;
      if not found or original_conflict.entity_type <> candidate_type
        or original_conflict.entity_id <> candidate_id
        or original_conflict.mutation_id::text is distinct from target_candidate->>'sourceMutationId' then
        raise exception using errcode = '22023', message = 'Reconciliation does not match the original conflict';
      end if;
    end if;
  end if;
  select * into current_record from public.sync_records
    where user_id=target_user_id and entity_type=candidate_type and entity_id=candidate_id for update;
  record_existed := found;

  if existing_operation.mutation_id is null then
    select item into latest from jsonb_array_elements(target_candidate->'localHistory') item
      order by (item->>'version')::bigint desc, item->>'mutationId' desc limit 1;
    if latest is not null then
      change_time := (latest->>'updatedAt')::timestamptz;
      if change_time is null or not isfinite(change_time) then
        raise exception using errcode = '22023', message = 'Reconciliation requires the original edit time';
      end if;
      -- Daily counters and focus controls have independent edit times. Fold
      -- focus from the whole preserved history: a later legacy daily edit may
      -- omit the preceding focus action without erasing it from that history.
      if candidate_type='tracking' and candidate_id='singleton'
        and (not record_existed or current_record.deleted_at is null) and (latest->>'deletedAt')::timestamptz is null
        and jsonb_typeof(latest->'payload')='object' then
        focus_projection := coalesce(current_record.payload,'{}'::jsonb);
        for history_item in select item from jsonb_array_elements(target_candidate->'localHistory') item
          order by (item->>'version')::bigint desc, item->>'mutationId' desc loop
          if (history_item->>'deletedAt')::timestamptz is null and jsonb_typeof(history_item->'payload')='object' then
            focus_projection := public.goalflow_merge_tracking_focus(focus_projection,history_item->'payload');
          end if;
        end loop;
        if not record_existed or (change_time > current_record.updated_at and change_time <= now()+interval '5 minutes') then
          merged_payload := latest->'payload';
          projection_time := change_time;
        else
          merged_payload := current_record.payload;
          projection_time := current_record.updated_at;
        end if;
        if focus_projection->'focusSession' is not null and focus_projection->'focusSession'<>'null'::jsonb then
          merged_payload := jsonb_set(merged_payload,'{focusSession}',focus_projection->'focusSession',true);
          projection_time := greatest(projection_time,public.goalflow_focus_session_time(focus_projection->'focusSession'));
        end if;
        if not record_existed or merged_payload is distinct from current_record.payload then
          next_version := greatest(coalesce(current_record.version,0)+1,(latest->>'version')::integer);
          push_result := public.push_sync_mutation_v2(target_user_id,gen_random_uuid(),
            'server-auto-reconcile',candidate_type,candidate_id,current_record.server_version,
            next_version,merged_payload,projection_time,null,null);
          if (push_result->>'accepted')::boolean is distinct from true then
            raise exception using errcode='40001', message='Automatic focus reconciliation must retry';
          end if;
          winner := 'field-merge';
        end if;
      else
      -- A device with a clock far in the future cannot silently displace a
      -- current cloud copy. The complete candidate remains in the audit receipt.
      if (not record_existed or (change_time > current_record.updated_at
        and change_time <= now() + interval '5 minutes'
        and candidate_type <> 'task_events'))
        and (not record_existed or latest->'payload' is distinct from current_record.payload
          or (latest->>'deletedAt')::timestamptz is distinct from current_record.deleted_at) then
        next_version := greatest(coalesce(current_record.version,0)+1, (latest->>'version')::integer);
        push_result := public.push_sync_mutation_v2(
          target_user_id, gen_random_uuid(), 'server-auto-reconcile', candidate_type, candidate_id,
          case when record_existed then current_record.server_version else null end,
          next_version, latest->'payload', change_time, (latest->>'deletedAt')::timestamptz, null
        );
        if (push_result->>'accepted')::boolean is distinct from true then
          raise exception using errcode = '40001', message = 'Automatic reconciliation must retry';
        end if;
        winner := 'local';
      end if;
      end if;
    end if;
    audit_result := jsonb_build_object(
      'operation','automatic-reconciliation','candidate',target_candidate,
      'previousCloud',case when record_existed then to_jsonb(current_record) else null end,
      'winner',winner
    );
    select * into current_record from public.sync_records
      where user_id=target_user_id and entity_type=candidate_type and entity_id=candidate_id;
    record_existed := found;
    insert into public.sync_mutations(user_id,mutation_id,device_id,server_version,accepted,
      entity_type,entity_id,request_hash,result)
    values(target_user_id,operation_id,'server-auto-reconcile',coalesce(current_record.server_version,0),true,
      candidate_type,candidate_id,request_fingerprint,audit_result);
    if original_conflict.id is not null then
      update public.sync_conflicts set resolved_at=coalesce(resolved_at,now())
        where id=original_conflict.id and user_id=target_user_id;
    end if;
  end if;
  -- On retry return the current canonical record, never an obsolete snapshot
  -- from the audit receipt. Clients still verify identity and revision before
  -- applying it, and preserve edits made while this request was in flight.
  return jsonb_build_object('reconciled',true,'receiptId',operation_id,
    'candidate',target_candidate,'serverMissing',not record_existed,
    'record',case when record_existed then to_jsonb(current_record) else null end);
end;
$$;
revoke all on function public.reconcile_goalflow_sync_change(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reconcile_goalflow_sync_change(uuid,jsonb) to service_role;
