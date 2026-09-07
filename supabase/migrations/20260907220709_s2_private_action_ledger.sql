-- Dormant additive protocol. No account is enrolled by this migration.
create schema goalflow_causal;
revoke all on schema goalflow_causal from public, anon, authenticated;
grant usage on schema goalflow_causal to service_role;

create table goalflow_causal.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  epoch uuid not null,
  cutover_request jsonb not null,
  cutover_receipt jsonb not null,
  tracking jsonb not null,
  focus_journal jsonb not null,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991)
);
create table goalflow_causal.counter_days (
  user_id uuid not null references goalflow_causal.accounts(user_id) on delete cascade,
  day date not null,
  baseline jsonb not null,
  primary key (user_id,day)
);
create table goalflow_causal.actions (
  user_id uuid not null references goalflow_causal.accounts(user_id) on delete cascade,
  action_id uuid not null,
  request jsonb not null,
  receipt jsonb not null,
  counter_day date,
  primary key (user_id,action_id)
);
create index causal_counter_day_actions on goalflow_causal.actions(user_id,counter_day)
  where counter_day is not null;
alter table goalflow_causal.accounts enable row level security;
alter table goalflow_causal.counter_days enable row level security;
alter table goalflow_causal.actions enable row level security;
revoke all on all tables in schema goalflow_causal from public,anon,authenticated;
grant select,insert,update on goalflow_causal.accounts to service_role;
grant select,insert on goalflow_causal.counter_days,goalflow_causal.actions to service_role;
grant select,update on public.sync_records to service_role;
grant select on public.sync_mutations to service_role;
grant execute on function public.goalflow_next_change_version() to service_role;

create function goalflow_causal.protected_tracking(value jsonb)
returns jsonb language sql immutable set search_path=pg_catalog as $fn$
  select coalesce(jsonb_object_agg(key,val),'{}'::jsonb)
  from jsonb_each(value) as fields(key,val)
  where key in ('date','planViewCount','dailyPostponeCount','focusSession');
$fn$;
revoke all on function goalflow_causal.protected_tracking(jsonb) from public,anon,authenticated;
grant execute on function goalflow_causal.protected_tracking(jsonb) to service_role;

-- This is an exact compare-and-establish operation, not inferred legacy repair.
-- The captured canonical projection remains the baseline; local contradictory
-- evidence must be retained separately and must never be silently added here.
create function public.goalflow_causal_cutover_v2(target_user_id uuid, operation jsonb)
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,goalflow_causal as $fn$
declare
  state goalflow_causal.accounts%rowtype;
  tracking_record public.sync_records%rowtype;
  baseline jsonb;
  journal jsonb;
  receipt jsonb;
  epoch_id uuid;
begin
  if jsonb_typeof(operation) is distinct from 'object'
    or operation->'schemaVersion' is distinct from '2'::jsonb
    or operation->>'accountId' is distinct from target_user_id::text
    or jsonb_typeof(operation->'expectedTrackingPayload') is distinct from 'object'
    or jsonb_typeof(operation->'expectedTrackingServerVersion') is distinct from 'number'
    or (operation->>'cutoverId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or operation->>'cutoverId' is null then
    raise exception 'Invalid causal cutover operation' using errcode='22023';
  end if;
  epoch_id := (operation->>'cutoverId')::uuid;
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':tracking:singleton',0));
  select * into state from goalflow_causal.accounts where user_id=target_user_id for update;
  if found then
    if state.cutover_request is distinct from operation then
      raise exception 'An immutable causal cutover already exists' using errcode='22023';
    end if;
    return state.cutover_receipt;
  end if;
  select * into tracking_record from public.sync_records
    where user_id=target_user_id and entity_type='tracking' and entity_id='singleton' for update;
  if not found or tracking_record.deleted_at is not null
    or tracking_record.payload is distinct from operation->'expectedTrackingPayload'
    or to_jsonb(tracking_record.server_version) is distinct from operation->'expectedTrackingServerVersion' then
    raise exception 'Canonical tracking changed or is unavailable; preserve captures and retry review' using errcode='40001';
  end if;
  if exists(select 1 from public.sync_mutations where user_id=target_user_id and mutation_id=epoch_id) then
    raise exception 'Cutover identity belongs to a legacy mutation' using errcode='22023';
  end if;
  baseline := jsonb_build_object('schemaVersion',1,'baselineId',epoch_id,'accountId',target_user_id,
    'day',tracking_record.payload->'date','counts',jsonb_build_object(
      'planViewCount',tracking_record.payload->'planViewCount','dailyPostponeCount',tracking_record.payload->'dailyPostponeCount'),
    'evidenceIds',jsonb_build_array(epoch_id));
  perform public.goalflow_project_counters_v1(baseline,'[]'::jsonb);
  journal := public.goalflow_initial_focus_journal_v1(target_user_id::text,tracking_record.payload->'focusSession');
  receipt := jsonb_build_object('schemaVersion',2,'operation',operation,'epoch',epoch_id,
    'projectionRevision',0,'baseline',baseline,'record',to_jsonb(tracking_record));
  insert into goalflow_causal.accounts(user_id,epoch,cutover_request,cutover_receipt,tracking,focus_journal)
    values(target_user_id,epoch_id,operation,receipt,tracking_record.payload,journal);
  insert into goalflow_causal.counter_days(user_id,day,baseline)
    values(target_user_id,(baseline->>'day')::date,baseline);
  return receipt;
end; $fn$;
revoke all on function public.goalflow_causal_cutover_v2(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_causal_cutover_v2(uuid,jsonb) to service_role;

-- Legacy push must return its original rejected receipt, rather than letting a
-- preservation trigger change the payload of an accepted legacy operation.
do $guard$
declare
  definition text;
  marker text := E'  if (record_existed and target_base_server_version is distinct from existing_record.server_version)';
begin
  definition := pg_get_functiondef('public.push_sync_mutation_v2(uuid,uuid,text,text,text,bigint,integer,jsonb,timestamptz,timestamptz,uuid)'::regprocedure);
  if position(marker in definition)=0 or position('or focus_merge_required then' in definition)=0 then
    raise exception 'Causal cutover requires the reviewed legacy receipt guard';
  end if;
  definition := replace(definition,marker,E'  if target_entity_type=''tracking'' and target_entity_id=''singleton'' then\n    if exists(select 1 from goalflow_causal.accounts a where a.user_id=target_user_id\n      and (target_deleted_at is not null or jsonb_typeof(target_payload) is distinct from ''object''\n        or goalflow_causal.protected_tracking(a.tracking) is distinct from goalflow_causal.protected_tracking(target_payload))) then\n      focus_merge_required := true;\n    end if;\n  end if;\n\n' || marker);
  execute definition;
end; $guard$;

-- Every writer, including reconciliation, must match private causal authority.
-- Only enrolled accounts bypass the legacy timestamp merge; new action causality
-- must also work for equal timestamps and backward clock movement.
create or replace function public.preserve_goalflow_tracking_focus()
returns trigger language plpgsql security invoker set search_path='' as $fn$
declare authoritative jsonb;
begin
  if new.entity_type='tracking' and new.entity_id='singleton' then
    select a.tracking into authoritative from goalflow_causal.accounts a where a.user_id=new.user_id;
    if found then
      if new.deleted_at is not null or jsonb_typeof(new.payload) is distinct from 'object'
        or goalflow_causal.protected_tracking(authoritative) is distinct from goalflow_causal.protected_tracking(new.payload) then
        raise exception 'Tracking requires a causal action; original legacy evidence remains pending' using errcode='22023';
      end if;
      return new;
    end if;
    if tg_op='UPDATE' then new.payload := public.goalflow_merge_tracking_focus(old.payload,new.payload);
    else new.payload := public.goalflow_merge_tracking_focus(null,new.payload); end if;
    if new.deleted_at is not null and new.payload->'focusSession' is not null and new.payload->'focusSession'<>'null'::jsonb then
      raise exception 'Use an explicit stopped or completed focus session instead of deleting tracking' using errcode='22023';
    end if;
  end if;
  return new;
end; $fn$;

create function public.goalflow_admit_action_v2(target_user_id uuid, operation jsonb)
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,goalflow_causal as $fn$
declare
  state goalflow_causal.accounts%rowtype;
  tracking_record public.sync_records%rowtype;
  task_record public.sync_records%rowtype;
  prior goalflow_causal.actions%rowtype;
  command jsonb := operation->'command';
  command_action_id uuid;
  reply jsonb;
  outcome jsonb;
  baseline jsonb;
  events jsonb;
  counts jsonb;
  next_tracking jsonb;
  receipt jsonb;
  attributed_day date;
  accepted boolean;
begin
  if jsonb_typeof(operation) is distinct from 'object' or operation->'schemaVersion' is distinct from '2'::jsonb
    or operation->>'type' not in ('focus','counter') or operation->>'type' is null
    or jsonb_typeof(command) is distinct from 'object' or command->>'accountId' is distinct from target_user_id::text
    or command->>'actionId' is null
    or command->>'actionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Invalid causal action envelope' using errcode='22023';
  end if;
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
  if command_action_id=state.epoch or exists(select 1 from public.sync_mutations m where m.user_id=target_user_id and m.mutation_id=command_action_id) then
    raise exception 'Action identity belongs to historical evidence' using errcode='22023';
  end if;
  select * into tracking_record from public.sync_records
    where user_id=target_user_id and entity_type='tracking' and entity_id='singleton' for update;
  if not found or tracking_record.deleted_at is not null
    or goalflow_causal.protected_tracking(tracking_record.payload) is distinct from goalflow_causal.protected_tracking(state.tracking) then
    raise exception 'Canonical tracking authority needs recovery' using errcode='22023';
  end if;
  next_tracking := tracking_record.payload;
  if operation->>'type'='focus' then
    if command->>'kind'='complete' then raise exception 'Completion requires atomic final notes and effects' using errcode='22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':tasks:' || (command->>'taskId'),0));
    select * into task_record from public.sync_records
      where user_id=target_user_id and entity_type='tasks' and entity_id=command->>'taskId' for update;
    if not found or task_record.deleted_at is not null or jsonb_typeof(task_record.payload) is distinct from 'object' then
      raise exception 'Focus target is missing or invalid' using errcode='22023';
    end if;
    if command->>'kind' in ('start','resume','extendAndResume') and
      (task_record.payload->'completed'='true'::jsonb or task_record.payload->'wontDo'='true'::jsonb
       or task_record.payload->>'lifecycleStatus' in ('completed','dropped','archived','broken_down')) then
      raise exception 'Focus target is no longer open' using errcode='22023';
    end if;
    reply := public.goalflow_apply_focus_v1(state.focus_journal,command);
    state.focus_journal := reply->'journal';
    outcome := reply->'outcome';
    accepted := (outcome->>'accepted')::boolean;
    if accepted then
      next_tracking := jsonb_set(next_tracking,'{focusSession}',state.focus_journal->'sessions'->(state.focus_journal->>'currentSessionId')->'projection');
    end if;
  else
    if command->'correctionOf' is distinct from 'null'::jsonb then
      raise exception 'Counter correction requires verified historical evidence' using errcode='22023';
    end if;
    if not exists(select 1 from pg_timezone_names where name=command->>'timeZone') then
      raise exception 'Counter timezone is not an IANA zone' using errcode='22023';
    end if;
    attributed_day := (command->>'day')::date;
    select d.baseline into baseline from goalflow_causal.counter_days d where d.user_id=target_user_id and d.day=attributed_day;
    if not found then raise exception 'The attributed day needs an explicitly established baseline' using errcode='22023'; end if;
    select coalesce(jsonb_agg(a.request->'command'),'[]'::jsonb) into events
      from goalflow_causal.actions a where a.user_id=target_user_id and a.counter_day=attributed_day;
    counts := public.goalflow_project_counters_v1(baseline,events || jsonb_build_array(command));
    if next_tracking->>'date'=command->>'day' then next_tracking := next_tracking || counts; end if;
    accepted := true;
    outcome := jsonb_build_object('accepted',true,'code','APPLIED','day',command->'day','counts',counts);
  end if;
  if state.revision>=9007199254740991 then raise exception 'Causal revision exhausted' using errcode='22023'; end if;
  update goalflow_causal.accounts set tracking=next_tracking,focus_journal=state.focus_journal,revision=state.revision+1
    where user_id=target_user_id;
  if next_tracking is distinct from tracking_record.payload then
    -- Retain the transaction-scoped publication lock until commit.
    update public.sync_records set payload=next_tracking,version=version+1,
      server_version=public.goalflow_next_change_version(),device_id='causal-action-v2',
      updated_at=greatest(clock_timestamp(),updated_at + interval '1 millisecond')
      where user_id=target_user_id and entity_type='tracking' and entity_id='singleton'
      returning * into tracking_record;
  end if;
  receipt := jsonb_build_object('schemaVersion',2,'operation',operation,'epoch',state.epoch,
    'accepted',accepted,'outcome',outcome,'projectionRevision',state.revision+1,'record',to_jsonb(tracking_record));
  insert into goalflow_causal.actions(user_id,action_id,request,receipt,counter_day)
    values(target_user_id,command_action_id,operation,receipt,attributed_day);
  return receipt;
end; $fn$;
revoke all on function public.goalflow_admit_action_v2(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_admit_action_v2(uuid,jsonb) to service_role;
