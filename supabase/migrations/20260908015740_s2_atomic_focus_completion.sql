-- Preserve the complete notes supported by the existing 4 MiB legacy transport.
-- Oversize values fail explicitly instead of silently changing their meaning.
do $notes$
declare definition text;
  marker text := 'left(coalesce(target_payload->>''description'', target_payload->>''notes'', ''''), 10000)';
begin
  if not exists(select 1 from pg_constraint where conrelid='public.tasks'::regclass and conname='tasks_notes_check'
    and pg_get_constraintdef(oid)='CHECK ((char_length(notes) <= 10000))') then
    raise exception 'Expected reviewed task note constraint is missing';
  end if;
  definition := pg_get_functiondef('public.project_goalflow_task_sync(uuid,text,jsonb,bigint,timestamptz,timestamptz)'::regprocedure);
  if position(marker in definition)=0 then raise exception 'Expected reviewed task note projection is missing'; end if;
  alter table public.tasks drop constraint tasks_notes_check;
  alter table public.tasks add constraint tasks_notes_utf8_check check (octet_length(notes)<=4194304);
  execute replace(definition,marker,'coalesce(target_payload->>''description'', target_payload->>''notes'', '''')');
end; $notes$;

create or replace function public.goalflow_complete_focus_v2(target_user_id uuid, operation jsonb)
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,goalflow_causal as $fn$
declare
  state goalflow_causal.accounts%rowtype;
  tracking_record public.sync_records%rowtype;
  task_record public.sync_records%rowtype;
  prior goalflow_causal.actions%rowtype;
  command jsonb := operation->'command';
  changes jsonb := operation->'changes';
  change jsonb;
  task_change jsonb;
  command_id uuid;
  response jsonb;
  results jsonb := '[]'::jsonb;
  transition jsonb;
  next_tracking jsonb;
  receipt jsonb;
begin
  if target_user_id is null or jsonb_typeof(operation) is distinct from 'object'
    or operation->'schemaVersion' is distinct from '2'::jsonb or operation->>'type' is distinct from 'completion'
    or command->>'kind' is distinct from 'complete' or command->>'accountId' is distinct from target_user_id::text
    or jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes) not between 1 and 6 then
    raise exception 'Invalid atomic completion' using errcode='22023';
  end if;
  command_id := (command->>'actionId')::uuid;
  if command_id is null then raise exception 'Completion identity is required' using errcode='22023'; end if;
  if (select count(distinct x->>'mutationId') from jsonb_array_elements(changes) x) <> jsonb_array_length(changes)
    or (select count(distinct x->>'entityType') from jsonb_array_elements(changes) x) <> jsonb_array_length(changes)
    or (select count(distinct (x->>'entityType',x->>'entityId')) from jsonb_array_elements(changes) x) <> jsonb_array_length(changes)
    or (select count(*) from jsonb_array_elements(changes) x where x->>'entityType'='tasks' and x->>'entityId'=command->>'taskId') <> 1 then
    raise exception 'Completion members have missing or duplicate identities' using errcode='22023';
  end if;
  for change in select value from jsonb_array_elements(changes) loop
    if jsonb_typeof(change) is distinct from 'object'
      or change->>'entityType' is null or change->>'entityType' not in ('tasks','stats','progress','goals','habits','task_events')
      or change->>'mutationId' is null or (change->>'mutationId')::uuid=command_id
      or change->>'entityId' is null or length(change->>'entityId') not between 1 and 240
      or change->>'deviceId' is null or length(change->>'deviceId') not between 1 and 128
      or jsonb_typeof(change->'payload') is distinct from 'object'
      or jsonb_typeof(change->'version') is distinct from 'number' or (change->>'version')::bigint not between 1 and 2147483647
      or not (change ? 'baseServerVersion') or (change->'baseServerVersion'<>'null'::jsonb and (jsonb_typeof(change->'baseServerVersion')<>'number' or (change->>'baseServerVersion')::bigint<0))
      or change->>'updatedAt' is null or change->'deletedAt' is distinct from 'null'::jsonb
      or coalesce(change->'resolvesConflictId','null'::jsonb)<>'null'::jsonb then
      raise exception 'Invalid completion member' using errcode='22023';
    end if;
    perform (change->>'updatedAt')::timestamptz;
    if change->>'entityType'='tasks' then
      if change->>'entityId' is distinct from command->>'taskId' or change->'payload'->>'id' is distinct from command->>'taskId'
        or change->'payload'->'completed' is distinct from 'true'::jsonb
        or change->'payload'->>'lifecycleStatus' is distinct from 'completed'
        or coalesce(change->'payload'->'deletedAt','null'::jsonb)<>'null'::jsonb then
        raise exception 'Completion task payload does not prove its target and final state' using errcode='22023';
      end if;
      task_change := change;
    end if;
  end loop;
  -- Legacy pushes acquire mutation identity before entity identity. Acquire
  -- every member in that order before any row writes or publication lock.
  for change in select jsonb_build_object('mutationId',id) from (
    select command_id::text id union select x->>'mutationId' from jsonb_array_elements(changes) x
  ) ids order by id loop
    perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':' || (change->>'mutationId'),0));
  end loop;
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':tracking:singleton',0));
  select * into state from goalflow_causal.accounts where user_id=target_user_id for update;
  if not found or operation->>'epoch' is distinct from state.epoch::text then
    raise exception 'Causal completion epoch is unavailable' using errcode='22023';
  end if;
  select * into prior from goalflow_causal.actions where user_id=target_user_id and action_id=command_id;
  if found then
    if prior.request is distinct from operation then raise exception 'Completion identity has a different request' using errcode='22023'; end if;
    return prior.receipt;
  end if;
  if command_id=state.epoch or exists(select 1 from public.sync_mutations where user_id=target_user_id and mutation_id=command_id)
    or exists(select 1 from goalflow_causal.counter_days where user_id=target_user_id and baseline->>'baselineId'=command_id::text) then
    raise exception 'Completion identity belongs to historical evidence' using errcode='22023';
  end if;
  for change in select value from jsonb_array_elements(changes) order by value->>'entityType',value->>'entityId' loop
    if (change->>'mutationId')::uuid=state.epoch
      or exists(select 1 from goalflow_causal.actions where user_id=target_user_id and action_id=(change->>'mutationId')::uuid)
      or exists(select 1 from goalflow_causal.counter_days where user_id=target_user_id and baseline->>'baselineId'=change->>'mutationId')
      or exists(select 1 from public.sync_mutations where user_id=target_user_id and mutation_id=(change->>'mutationId')::uuid) then
      raise exception 'A completion member already belongs to retained evidence' using errcode='22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':' || (change->>'entityType') || ':' || (change->>'entityId'),0));
  end loop;
  select * into tracking_record from public.sync_records where user_id=target_user_id and entity_type='tracking' and entity_id='singleton' for update;
  if not found or tracking_record.deleted_at is not null
    or goalflow_causal.protected_tracking(tracking_record.payload) is distinct from goalflow_causal.protected_tracking(state.tracking) then
    raise exception 'Tracking authority requires recovery' using errcode='22023';
  end if;
  select * into task_record from public.sync_records where user_id=target_user_id and entity_type='tasks' and entity_id=command->>'taskId' for update;
  if not found or task_record.deleted_at is not null or jsonb_typeof(task_record.payload) is distinct from 'object'
    or task_record.payload->'completed'='true'::jsonb or task_record.payload->'wontDo'='true'::jsonb
    or task_record.payload->>'lifecycleStatus' in ('completed','dropped','archived','broken_down') then
    raise exception 'Completion target is no longer open' using errcode='22023';
  end if;
  for change in select value from jsonb_array_elements(changes) loop
    if (change->>'entityType'='goals' and change->>'entityId' is distinct from task_record.payload->>'goalId')
      or (change->>'entityType'='habits' and change->>'entityId' is distinct from task_record.payload->>'habitId')
      or (change->>'entityType' in ('stats','progress') and change->>'entityId'<>'singleton')
      or (change->>'entityType'='task_events' and (coalesce(change->'payload'->>'taskId',change->'payload'->>'task_id') is distinct from command->>'taskId' or coalesce(change->'payload'->>'eventType',change->'payload'->>'event_type') is distinct from 'completed')) then
      raise exception 'Completion effect belongs to a different target' using errcode='22023';
    end if;
  end loop;
  transition := public.goalflow_apply_focus_v1(state.focus_journal,command);
  next_tracking := tracking_record.payload;
  if (transition->'outcome'->>'accepted')::boolean then
    -- Every final note/effect commits before focus becomes terminal, inside
    -- this same database transaction. Any rejection rolls back ALL members.
    for change in select value from jsonb_array_elements(changes) loop
      response := public.push_sync_mutation_v2(target_user_id,(change->>'mutationId')::uuid,change->>'deviceId',
        change->>'entityType',change->>'entityId',(change->>'baseServerVersion')::bigint,(change->>'version')::integer,
        change->'payload',(change->>'updatedAt')::timestamptz,null,null);
      if response->'accepted' is distinct from 'true'::jsonb or response->'record'->'payload' is distinct from change->'payload'
        or response->'record'->>'entity_type' is distinct from change->>'entityType' or response->'record'->>'entity_id' is distinct from change->>'entityId'
        or response->'record'->>'device_id' is distinct from change->>'deviceId'
        or response->'record'->'version' is distinct from change->'version'
        or (response->'record'->>'updated_at')::timestamptz is distinct from (change->>'updatedAt')::timestamptz
        or response->'record'->'deleted_at' is distinct from 'null'::jsonb then
        raise exception 'Atomic completion member needs reconciliation; no completion effects committed' using errcode='22023';
      end if;
      results := results || jsonb_build_array(response || jsonb_build_object('mutationId',change->'mutationId'));
    end loop;
    next_tracking := jsonb_set(next_tracking,'{focusSession}',transition->'journal'->'sessions'->(transition->'journal'->>'currentSessionId')->'projection');
  end if;
  if state.revision>=9007199254740991 then raise exception 'Causal revision exhausted' using errcode='22023'; end if;
  update goalflow_causal.accounts set tracking=next_tracking,focus_journal=transition->'journal',revision=state.revision+1 where user_id=target_user_id;
  if next_tracking is distinct from tracking_record.payload then
    update public.sync_records set payload=next_tracking,version=version+1,server_version=public.goalflow_next_change_version(),
      device_id='causal-completion-v2',updated_at=greatest(clock_timestamp(),updated_at+interval '1 millisecond')
      where user_id=target_user_id and entity_type='tracking' and entity_id='singleton' returning * into tracking_record;
  end if;
  receipt := jsonb_build_object('schemaVersion',2,'operation',operation,'epoch',state.epoch,
    'accepted',transition->'outcome'->'accepted','outcome',transition->'outcome','projectionRevision',state.revision+1,
    'record',to_jsonb(tracking_record),'changes',results);
  if octet_length(convert_to(jsonb_build_object('schemaVersion',2,'accountId',target_user_id,'epoch',state.epoch,
    'revision',state.revision+1,'receipt',receipt)::text,'UTF8'))>16777216 then
    raise exception 'Completion history exceeds the supported entry envelope; no effects committed' using errcode='22023';
  end if;
  insert into goalflow_causal.actions(user_id,action_id,request,receipt) values(target_user_id,command_id,operation,receipt);
  return receipt;
end; $fn$;
revoke all on function public.goalflow_complete_focus_v2(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_complete_focus_v2(uuid,jsonb) to service_role;
