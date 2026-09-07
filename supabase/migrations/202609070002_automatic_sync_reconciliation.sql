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
