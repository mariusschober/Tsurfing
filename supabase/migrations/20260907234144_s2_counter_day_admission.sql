-- Explicit day admission for the dormant causal protocol. No account cutover
-- occurs here. Historical days or days with legacy claims never infer zero.
create function public.goalflow_counter_day_v2(target_user_id uuid, operation jsonb)
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,goalflow_causal as $fn$
declare
  state goalflow_causal.accounts%rowtype;
  tracking_record public.sync_records%rowtype;
  prior goalflow_causal.actions%rowtype;
  command jsonb := operation->'command';
  command_action_id uuid;
  requested_day date;
  baseline jsonb;
  baseline_id uuid;
  digest_hex text;
  events jsonb;
  counts jsonb;
  next_tracking jsonb;
  receipt jsonb;
begin
  if jsonb_typeof(operation) is distinct from 'object'
    or operation->'schemaVersion' is distinct from '2'::jsonb
    or operation->>'type' is distinct from 'counterDay'
    or jsonb_typeof(command) is distinct from 'object'
    or command->'schemaVersion' is distinct from '1'::jsonb
    or command->>'accountId' is distinct from target_user_id::text
    or command->>'kind' is null or command->>'kind' not in ('establish','select')
    or command->>'actionId' is null
    or command->>'actionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(command->'actorId') is distinct from 'string'
    or length(btrim(command->>'actorId')) not between 1 and 240
    or command->>'day' is null or command->>'day' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or command->>'capturedAt' is null
    or command->>'capturedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    or not exists(select 1 from pg_timezone_names where name=command->>'timeZone') then
    raise exception 'Invalid counter day operation' using errcode='22023';
  end if;
  requested_day := (command->>'day')::date;
  perform (command->>'capturedAt')::timestamptz;
  command_action_id := (command->>'actionId')::uuid;
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':tracking:singleton',0));
  select * into state from goalflow_causal.accounts where user_id=target_user_id for update;
  if not found or operation->>'epoch' is distinct from state.epoch::text then
    raise exception 'Causal capability epoch is missing or stale' using errcode='22023';
  end if;
  select * into prior from goalflow_causal.actions a where a.user_id=target_user_id and a.action_id=command_action_id;
  if found then
    if prior.request is distinct from operation then raise exception 'Action identity has a different request' using errcode='22023'; end if;
    return prior.receipt;
  end if;
  if command_action_id=state.epoch
    or exists(select 1 from public.sync_mutations m where m.user_id=target_user_id and m.mutation_id=command_action_id)
    or exists(select 1 from goalflow_causal.counter_days d where d.user_id=target_user_id and d.baseline->>'baselineId'=command_action_id::text) then
    raise exception 'Action identity belongs to historical evidence' using errcode='22023';
  end if;
  select * into tracking_record from public.sync_records
    where user_id=target_user_id and entity_type='tracking' and entity_id='singleton' for update;
  if not found or tracking_record.deleted_at is not null
    or goalflow_causal.protected_tracking(tracking_record.payload) is distinct from goalflow_causal.protected_tracking(state.tracking) then
    raise exception 'Canonical tracking authority needs recovery' using errcode='22023';
  end if;
  select d.baseline into baseline from goalflow_causal.counter_days d where d.user_id=target_user_id and d.day=requested_day;
  if not found then
    if requested_day <= (state.cutover_request->'expectedTrackingPayload'->>'date')::date
      or exists(select 1 from public.sync_mutations m where m.user_id=target_user_id and m.accepted
        and (coalesce(m.entity_type,m.result->'record'->>'entity_type') is null
          or (coalesce(m.entity_type,m.result->'record'->>'entity_type')='tracking'
            and (jsonb_typeof(m.result->'record'->'payload') is distinct from 'object'
              or m.result->'record'->'payload'->>'date' is null))))
      or exists(select 1 from public.sync_mutations m where m.user_id=target_user_id
        and (m.entity_type='tracking' or m.result->'record'->>'entity_type'='tracking')
        and m.result->'record'->'payload'->>'date'=command->>'day')
      or exists(select 1 from public.sync_conflicts c where c.user_id=target_user_id and c.entity_type='tracking'
        and (c.local_payload->>'date'=command->>'day' or c.server_payload->>'date'=command->>'day')) then
      raise exception 'Historical counter day needs explicit baseline review; all evidence remains preserved' using errcode='22023';
    end if;
    -- Same account/epoch/day has the same baseline identity on every retry or
    -- client. No clock or actor-specific reset can replace this baseline.
    digest_hex := encode(sha256(convert_to(state.epoch::text || ':counter-day:' || (command->>'day'),'UTF8')),'hex');
    baseline_id := (substr(digest_hex,1,8)||'-'||substr(digest_hex,9,4)||'-8'||substr(digest_hex,14,3)||'-8'||substr(digest_hex,18,3)||'-'||substr(digest_hex,21,12))::uuid;
    if baseline_id=command_action_id
      or exists(select 1 from goalflow_causal.actions a where a.user_id=target_user_id and a.action_id=baseline_id)
      or exists(select 1 from public.sync_mutations m where m.user_id=target_user_id and m.mutation_id=baseline_id) then
      raise exception 'Counter baseline identity belongs to existing evidence' using errcode='22023';
    end if;
    baseline := jsonb_build_object('schemaVersion',1,'baselineId',baseline_id,'accountId',target_user_id,
      'day',command->'day','counts',jsonb_build_object('planViewCount',0,'dailyPostponeCount',0),
      'evidenceIds',jsonb_build_array(state.epoch,baseline_id));
    perform public.goalflow_project_counters_v1(baseline,'[]'::jsonb);
    insert into goalflow_causal.counter_days(user_id,day,baseline) values(target_user_id,requested_day,baseline);
  end if;
  select coalesce(jsonb_agg(a.request->'command'),'[]'::jsonb) into events
    from goalflow_causal.actions a where a.user_id=target_user_id and a.counter_day=requested_day;
  counts := public.goalflow_project_counters_v1(baseline,events);
  next_tracking := tracking_record.payload;
  if command->>'kind'='select' then next_tracking := next_tracking || counts || jsonb_build_object('date',command->'day'); end if;
  if state.revision>=9007199254740991 then raise exception 'Causal revision exhausted' using errcode='22023'; end if;
  update goalflow_causal.accounts set tracking=next_tracking,revision=state.revision+1 where user_id=target_user_id;
  if next_tracking is distinct from tracking_record.payload then
    update public.sync_records set payload=next_tracking,version=version+1,
      server_version=public.goalflow_next_change_version(),device_id='causal-action-v2',
      updated_at=greatest(clock_timestamp(),updated_at+interval '1 millisecond')
      where user_id=target_user_id and entity_type='tracking' and entity_id='singleton'
      returning * into tracking_record;
  end if;
  receipt := jsonb_build_object('schemaVersion',2,'operation',operation,'epoch',state.epoch,'accepted',true,
    'projectionRevision',state.revision+1,'baseline',baseline,'counts',counts,'record',to_jsonb(tracking_record));
  insert into goalflow_causal.actions(user_id,action_id,request,receipt)
    values(target_user_id,command_action_id,operation,receipt);
  return receipt;
end; $fn$;
revoke all on function public.goalflow_counter_day_v2(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_counter_day_v2(uuid,jsonb) to service_role;
grant select on public.sync_conflicts to service_role;

-- A baseline identity is audit evidence across every day, not a reusable action
-- ID on some other day or command kind. Preserve the existing receipt contract.
do $guard$
declare definition text;
  marker text := 'if command_action_id=state.epoch or exists(select 1 from public.sync_mutations m where m.user_id=target_user_id and m.mutation_id=command_action_id) then';
begin
  definition := pg_get_functiondef('public.goalflow_admit_action_v2(uuid,jsonb)'::regprocedure);
  if position(marker in definition)=0 then raise exception 'Counter days require the reviewed causal identity guard'; end if;
  definition := replace(definition,marker,
    'if exists(select 1 from goalflow_causal.counter_days d where d.user_id=target_user_id and d.baseline->>''baselineId''=command_action_id::text) or command_action_id=state.epoch or exists(select 1 from public.sync_mutations m where m.user_id=target_user_id and m.mutation_id=command_action_id) then');
  execute definition;
end; $guard$;
