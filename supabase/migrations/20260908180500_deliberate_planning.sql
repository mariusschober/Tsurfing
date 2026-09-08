-- Additive compatibility support. Enforcement is enabled per account only
-- after compatible clients have been installed and staging has been verified.
create schema goalflow_planning;
revoke all on schema goalflow_planning from public,anon,authenticated;
grant usage on schema goalflow_planning to service_role;
create table goalflow_planning.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enforce_order_lock boolean not null default false
);
create table goalflow_planning.days (
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  policy jsonb not null,
  primary key(user_id,local_date),
  check (policy->>'accountId'=user_id::text and policy->>'localDate'=local_date::text)
);
create table goalflow_planning.operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  local_date date not null,
  command jsonb not null,
  response jsonb not null,
  primary key(user_id,operation_id)
);
create index planning_operations_day on goalflow_planning.operations(user_id,local_date);
alter table goalflow_planning.accounts enable row level security;
alter table goalflow_planning.days enable row level security;
alter table goalflow_planning.operations enable row level security;
revoke all on all tables in schema goalflow_planning from public,anon,authenticated;
grant select,insert,update on goalflow_planning.accounts,goalflow_planning.days to service_role;
grant select,insert on goalflow_planning.operations to service_role;
grant execute on function public.project_goalflow_daily_plan_sync(uuid,text,jsonb,bigint,timestamptz,timestamptz),
  public.project_goalflow_task_sync(uuid,text,jsonb,bigint,timestamptz,timestamptz) to service_role;

create function goalflow_planning.initial_policy(account_id uuid, at_day date, legacy jsonb default null)
returns jsonb language sql immutable set search_path=pg_catalog as $fn$
  select jsonb_build_object('schemaVersion',1,'accountId',account_id,'localDate',at_day::text,
    'revision',case when legacy is null then null else 'legacy:'||at_day::text||':'||(legacy->>'confirmedAt') end,
    'confirmedOrder',coalesce(legacy->'taskIds','[]'::jsonb),'acceptedReplans',0,'history','[]'::jsonb);
$fn$;

-- Equivalent to the shared deliberatePlanning.ts transaction decision. The
-- available list is derived from locked server records, never client payloads.
create function goalflow_planning.apply_confirmation(policy jsonb, command jsonb, available jsonb, xp bigint, setting text)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $fn$
declare
  old_receipt jsonb;
  ordered jsonb;
  common_before jsonb;
  common_after jsonb;
  changed boolean;
  cost integer := 0;
  debit integer := 0;
  code text := 'APPLIED';
  next_revision jsonb;
  next_count bigint;
  receipt jsonb;
  next_policy jsonb;
begin
  if command->'schemaVersion' is distinct from '1'::jsonb or command->>'accountId' is distinct from policy->>'accountId'
    or command->>'localDate' is distinct from policy->>'localDate'
    or command->>'operationId' is null or command->>'operationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or not(command ? 'baselineRevision') or jsonb_typeof(command->'proposedOrder') is distinct from 'array'
    or jsonb_typeof(command->'ratings') is distinct from 'array'
    or (command ? 'priorityChanges' and jsonb_typeof(command->'priorityChanges') is distinct from 'array')
    or jsonb_typeof(command->'maximumAcceptedXp') is distinct from 'number'
    or (command->>'maximumAcceptedXp')::numeric not between 0 and 50
    or trunc((command->>'maximumAcceptedXp')::numeric)<>(command->>'maximumAcceptedXp')::numeric
    or command->>'capturedAt' is null or xp not between 0 and 9007199254740991
    or setting not in ('classic','gentle','off') then
    raise exception 'Invalid planning confirmation' using errcode='22023';
  end if;
  if jsonb_array_length(coalesce(command->'priorityChanges','[]'::jsonb))>10000
    or exists(select 1 from jsonb_array_elements(coalesce(command->'priorityChanges','[]'::jsonb)) x
      where jsonb_typeof(x)<>'object' or x->>'taskId' is null or length(x->>'taskId') not between 1 and 240 or x->'isFrog' is distinct from 'true'::jsonb)
    or (select count(distinct x->>'taskId') from jsonb_array_elements(coalesce(command->'priorityChanges','[]'::jsonb)) x)
      <>jsonb_array_length(coalesce(command->'priorityChanges','[]'::jsonb)) then raise exception 'Invalid Frog promotion' using errcode='22023'; end if;
  if (command->>'localDate')::date::text <> command->>'localDate' then raise exception 'Invalid planning day' using errcode='22023'; end if;
  perform (command->>'capturedAt')::timestamptz;
  if jsonb_array_length(command->'proposedOrder')>10000 or jsonb_array_length(command->'ratings')>10000
    or exists(select 1 from jsonb_array_elements(command->'proposedOrder') x where jsonb_typeof(x)<>'string' or length(x#>>'{}') not between 1 and 240)
    or (select count(distinct x) from jsonb_array_elements(command->'proposedOrder') x)<>jsonb_array_length(command->'proposedOrder')
    or (select count(distinct x->>'taskId') from jsonb_array_elements(command->'ratings') x)<>jsonb_array_length(command->'ratings')
    or exists(select 1 from jsonb_array_elements(command->'ratings') x where jsonb_typeof(x)<>'object'
      or x->>'taskId' is null or length(x->>'taskId') not between 1 and 240
      or jsonb_typeof(x->'excitement') is distinct from 'number' or jsonb_typeof(x->'roi') is distinct from 'number'
      or (x->>'excitement')::numeric not between 0 and 100 or (x->>'roi')::numeric not between 0 and 100
      or trunc((x->>'excitement')::numeric)<>(x->>'excitement')::numeric or trunc((x->>'roi')::numeric)<>(x->>'roi')::numeric) then
    raise exception 'Invalid planning order or ratings' using errcode='22023';
  end if;
  select x into old_receipt from jsonb_array_elements(policy->'history') x where x->'command'->>'operationId'=command->>'operationId';
  if found then
    if old_receipt->'command' is distinct from command then raise exception 'Planning identity has different content' using errcode='22023'; end if;
    return jsonb_build_object('policy',policy,'receipt',old_receipt,'xp',xp,'ratings','[]'::jsonb,'replay',true);
  end if;
  select coalesce(jsonb_agg(task->'id' order by case when (task->>'precedence')::int>1
    and coalesce(command->'priorityChanges','[]'::jsonb) @> jsonb_build_array(jsonb_build_object('taskId',task->'id','isFrog',true)) then 1 else (task->>'precedence')::int end,
    coalesce((select n from jsonb_array_elements(command->'proposedOrder') with ordinality p(id,n) where p.id=task->'id'),10001+a.n)), '[]'::jsonb)
    into ordered from jsonb_array_elements(available) with ordinality a(task,n);
  select coalesce(jsonb_agg(x order by n),'[]'::jsonb) into common_before
    from jsonb_array_elements(policy->'confirmedOrder') with ordinality p(x,n) where ordered @> jsonb_build_array(x);
  select coalesce(jsonb_agg(x order by n),'[]'::jsonb) into common_after
    from jsonb_array_elements(ordered) with ordinality p(x,n) where policy->'confirmedOrder' @> jsonb_build_array(x);
  changed := policy->'revision'<>'null'::jsonb and common_before<>common_after;
  next_count := (policy->>'acceptedReplans')::bigint;
  if changed and next_count>=3 then cost := case setting when 'classic' then 50 when 'gentle' then 25 else 0 end; end if;
  if command->'baselineRevision' is distinct from policy->'revision' then code := 'STALE_REVISION';
  elsif cost>(command->>'maximumAcceptedXp')::int then code := 'COST_CHANGED'; end if;
  next_revision := policy->'revision';
  if code='APPLIED' then
    next_revision := command->'operationId';
    if changed then next_count := next_count+1; end if;
    debit := least(xp,cost);
  else
    select coalesce(jsonb_agg(task->'id' order by (task->>'precedence')::int,
      coalesce((select n from jsonb_array_elements(policy->'confirmedOrder') with ordinality p(id,n) where p.id=task->'id'),10001+a.n)), '[]'::jsonb)
      into ordered from jsonb_array_elements(available) with ordinality a(task,n);
  end if;
  receipt := jsonb_build_object('command',command,'code',code,'revision',next_revision,'acceptedReplans',next_count,
    'actualDebit',debit,'requiredCost',cost,'order',ordered);
  next_policy := policy || jsonb_build_object('revision',next_revision,'acceptedReplans',next_count,
    'confirmedOrder',case when code='APPLIED' then ordered else policy->'confirmedOrder' end,
    'history',(policy->'history')||jsonb_build_array(receipt));
  return jsonb_build_object('policy',next_policy,'receipt',receipt,'xp',xp-debit,'replay',false,
    'ratings',case when code='APPLIED' then coalesce((select jsonb_agg(x) from jsonb_array_elements(command->'ratings') x
      where ordered @> jsonb_build_array(x->'taskId')),'[]'::jsonb) else '[]'::jsonb end);
end; $fn$;

revoke all on function goalflow_planning.initial_policy(uuid,date,jsonb),goalflow_planning.apply_confirmation(jsonb,jsonb,jsonb,bigint,text) from public,anon,authenticated;
grant execute on function goalflow_planning.initial_policy(uuid,date,jsonb),goalflow_planning.apply_confirmation(jsonb,jsonb,jsonb,bigint,text) to service_role;

insert into goalflow_planning.days(user_id,local_date,policy)
select user_id,entity_id::date,goalflow_planning.initial_policy(user_id,entity_id::date,payload)
from public.sync_records where entity_type='daily_plans' and deleted_at is null
  and entity_id ~ '^\d{4}-\d{2}-\d{2}$' and payload->>'confirmedAt' is not null
on conflict do nothing;

create function public.goalflow_confirm_order_v1(target_user_id uuid, command jsonb)
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,goalflow_planning as $fn$
declare
  command_id uuid := (command->>'operationId')::uuid;
  at_day date := (command->>'localDate')::date;
  prior goalflow_planning.operations%rowtype;
  policy jsonb;
  legacy jsonb;
  available jsonb;
  transition jsonb;
  balance public.sync_records%rowtype;
  item public.sync_records%rowtype;
  entity record;
  proposed jsonb;
  rating jsonb;
  records jsonb := '[]'::jsonb;
  response jsonb;
  setting text;
  saved_context text := current_setting('goalflow.planning_confirmation',true);
  rank integer;
begin
  if target_user_id is null or command->>'accountId' is distinct from target_user_id::text or command_id is null or at_day is null then
    raise exception 'Planning confirmation scope is invalid' using errcode='22023';
  end if;
  -- Same leading lock order as causal completion, followed by sorted entity
  -- locks, and only then publication. No server member mutation IDs are needed:
  -- the entire command has one durable receipt and one SQL transaction.
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text||':'||command_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text||':tracking:singleton',0));
  select * into prior from goalflow_planning.operations where user_id=target_user_id and operation_id=command_id;
  if found then
    if prior.command is distinct from command then raise exception 'Planning identity has different content' using errcode='22023'; end if;
    return prior.response;
  end if;
  if exists(select 1 from public.sync_mutations where user_id=target_user_id and mutation_id=command_id)
    or exists(select 1 from goalflow_causal.actions where user_id=target_user_id and action_id=command_id)
    or exists(select 1 from goalflow_causal.accounts where user_id=target_user_id and epoch=command_id) then
    raise exception 'Planning identity belongs to existing evidence' using errcode='22023';
  end if;
  for entity in select kind,id from (
    select entity_type kind,entity_id id from public.sync_records where user_id=target_user_id and entity_type='tasks'
    union select 'daily_plans',at_day::text union select 'progress','singleton' union select 'settings','singleton'
  ) all_entities order by kind,id loop
    perform pg_advisory_xact_lock(hashtextextended(target_user_id::text||':'||entity.kind||':'||entity.id,0));
  end loop;
  select payload into legacy from public.sync_records where user_id=target_user_id and entity_type='daily_plans' and entity_id=at_day::text and deleted_at is null;
  if legacy->>'confirmedAt' is null then legacy := null; end if;
  insert into goalflow_planning.days(user_id,local_date,policy)
    values(target_user_id,at_day,goalflow_planning.initial_policy(target_user_id,at_day,legacy)) on conflict do nothing;
  select d.policy into policy from goalflow_planning.days d where user_id=target_user_id and local_date=at_day for update;
  select * into balance from public.sync_records where user_id=target_user_id and entity_type='progress' and entity_id='singleton' for update;
  if not found or balance.deleted_at is not null or jsonb_typeof(balance.payload->'xp') is distinct from 'number'
    or (balance.payload->>'xp')::numeric<>trunc((balance.payload->>'xp')::numeric) then
    raise exception 'Planning requires the synchronized XP balance' using errcode='22023';
  end if;
  select coalesce(payload->>'penaltyMode','off') into setting from public.sync_records
    where user_id=target_user_id and entity_type='settings' and entity_id='singleton' and deleted_at is null;
  setting := coalesce(setting,'off');
  select coalesce(jsonb_agg(jsonb_build_object('id',entity_id,'precedence',
    case when payload->'beforeFrog'='true'::jsonb and coalesce(payload->>'habitId','')<>'' then 0 when payload->'isFrog'='true'::jsonb then 1 else 2 end)
    order by case when payload->'beforeFrog'='true'::jsonb and coalesce(payload->>'habitId','')<>'' then 0 when payload->'isFrog'='true'::jsonb then 1 else 2 end,
      coalesce((payload->>'plannedOrder')::numeric,9007199254740991),coalesce(payload->>'scheduledTime','99:99'),
      coalesce(payload->>'createdAt',''),entity_id),'[]'::jsonb) into available
    from public.sync_records where user_id=target_user_id and entity_type='tasks' and deleted_at is null
      and coalesce(payload->>'schedulePrecision','day')='day'
      and coalesce(payload->>'scheduledFor',payload->>'dateAssigned')=at_day::text
      and coalesce(payload->'completed','false'::jsonb)='false'::jsonb and coalesce(payload->'wontDo','false'::jsonb)='false'::jsonb
      and coalesce(payload->>'lifecycleStatus','open')='open' and coalesce(payload->'deletedAt','null'::jsonb)='null'::jsonb;
  transition := goalflow_planning.apply_confirmation(policy,command,available,(balance.payload->>'xp')::bigint,setting);
  update goalflow_planning.days set policy=transition->'policy' where user_id=target_user_id and local_date=at_day;
  if transition->'receipt'->>'code'='APPLIED' then
    perform set_config('goalflow.planning_confirmation','on',true);
    for item in select * from public.sync_records where user_id=target_user_id and entity_type='tasks'
      and transition->'receipt'->'order' @> jsonb_build_array(entity_id) order by entity_id for update loop
      select n-1 into rank from jsonb_array_elements_text(transition->'receipt'->'order') with ordinality ids(id,n) where id=item.entity_id;
      select x into rating from jsonb_array_elements(transition->'ratings') x where x->>'taskId'=item.entity_id;
      proposed := (item.payload-'session')||jsonb_build_object('plannedOrder',rank);
      if coalesce(command->'priorityChanges','[]'::jsonb) @> jsonb_build_array(jsonb_build_object('taskId',item.entity_id,'isFrog',true)) then
        proposed := proposed||'{"isFrog":true}'::jsonb;
      end if;
      if rating is not null then proposed := proposed||jsonb_build_object('excitement',rating->'excitement','roi',rating->'roi'); end if;
      if proposed is distinct from item.payload then
        update public.sync_records set payload=proposed,version=version+1,server_version=public.goalflow_next_change_version(),
          device_id='planning-v1',updated_at=greatest(clock_timestamp(),updated_at+interval '1 millisecond')
          where user_id=target_user_id and entity_type='tasks' and entity_id=item.entity_id returning * into item;
        perform public.project_goalflow_task_sync(target_user_id,item.entity_id,item.payload,item.server_version,item.updated_at,item.deleted_at);
      end if;
      records := records||jsonb_build_array(to_jsonb(item));
    end loop;
    if (transition->>'xp')::bigint<>(balance.payload->>'xp')::bigint then
      update public.sync_records set payload=jsonb_set(payload,'{xp}',transition->'xp'),version=version+1,
        server_version=public.goalflow_next_change_version(),device_id='planning-v1',updated_at=greatest(clock_timestamp(),updated_at+interval '1 millisecond')
        where user_id=target_user_id and entity_type='progress' and entity_id='singleton' returning * into balance;
    end if;
    records := records||jsonb_build_array(to_jsonb(balance));
    insert into public.sync_records(user_id,entity_type,entity_id,version,server_version,device_id,payload,updated_at,deleted_at)
      values(target_user_id,'daily_plans',at_day::text,1,public.goalflow_next_change_version(),'planning-v1',
        jsonb_build_object('id',at_day::text,'localDate',at_day::text,'taskIds',transition->'receipt'->'order',
          'confirmedAt',floor(extract(epoch from (command->>'capturedAt')::timestamptz)*1000)),clock_timestamp(),null)
      on conflict(user_id,entity_type,entity_id) do update set payload=excluded.payload,version=sync_records.version+1,
        server_version=excluded.server_version,device_id=excluded.device_id,updated_at=greatest(excluded.updated_at,sync_records.updated_at+interval '1 millisecond'),deleted_at=null
      returning * into item;
    perform public.project_goalflow_daily_plan_sync(target_user_id,item.entity_id,item.payload,item.server_version,item.updated_at,null);
    records := records||jsonb_build_array(to_jsonb(item));
    perform set_config('goalflow.planning_confirmation',coalesce(saved_context,''),true);
  end if;
  response := jsonb_build_object('schemaVersion',1,'accountId',target_user_id,'receipt',transition->'receipt',
    'policy',transition->'policy','records',records);
  insert into goalflow_planning.operations(user_id,operation_id,local_date,command,response) values(target_user_id,command_id,at_day,command,response);
  return response;
end; $fn$;
revoke all on function public.goalflow_confirm_order_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_confirm_order_v1(uuid,jsonb) to service_role;

create function public.goalflow_planning_day_v1(target_user_id uuid, target_day date)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public,goalflow_planning as $fn$
  select jsonb_build_object('schemaVersion',1,'accountId',target_user_id,'policy',coalesce(
    (select policy from goalflow_planning.days where user_id=target_user_id and local_date=target_day),
    goalflow_planning.initial_policy(target_user_id,target_day,(select payload from public.sync_records
      where user_id=target_user_id and entity_type='daily_plans' and entity_id=target_day::text and deleted_at is null and payload->>'confirmedAt' is not null))),
    'enforcementEnabled',coalesce((select enforce_order_lock from goalflow_planning.accounts where user_id=target_user_id),false),
    'records',coalesce((select jsonb_agg(to_jsonb(r) order by entity_type,entity_id) from public.sync_records r
      where user_id=target_user_id and ((entity_type='tasks' and coalesce(payload->>'scheduledFor',payload->>'dateAssigned')=target_day::text)
        or (entity_type='daily_plans' and entity_id=target_day::text) or (entity_type='progress' and entity_id='singleton'))),'[]'::jsonb));
$fn$;
revoke all on function public.goalflow_planning_day_v1(uuid,date) from public,anon,authenticated;
grant execute on function public.goalflow_planning_day_v1(uuid,date) to service_role;

create function goalflow_planning.guard_order_write()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public,goalflow_planning as $fn$
declare
  at_day date;
  policy jsonb;
  before_ids jsonb;
  after_ids jsonb;
begin
  if current_setting('goalflow.planning_confirmation',true)='on' then return new; end if;
  -- Keep unrelated entity writes outside the private planning schema. SQL
  -- privilege checks do not depend on boolean short-circuit evaluation.
  if new.entity_type not in ('tasks','daily_plans') then return new; end if;
  if new.entity_type='daily_plans' and new.deleted_at is null and new.payload->>'confirmedAt' is not null then
    at_day := new.entity_id::date;
    select d.policy into policy from goalflow_planning.days d where d.user_id=new.user_id and d.local_date=at_day;
    if policy is null then
      insert into goalflow_planning.days(user_id,local_date,policy)
        values(new.user_id,at_day,goalflow_planning.initial_policy(new.user_id,at_day,new.payload)) on conflict do nothing;
      return new;
    end if;
    if coalesce((select enforce_order_lock from goalflow_planning.accounts where user_id=new.user_id),false)
      and policy->'revision'<>'null'::jsonb then
      select coalesce(jsonb_agg(x order by n),'[]'::jsonb) into before_ids from jsonb_array_elements(policy->'confirmedOrder') with ordinality p(x,n)
        where new.payload->'taskIds' @> jsonb_build_array(x);
      select coalesce(jsonb_agg(x order by n),'[]'::jsonb) into after_ids from jsonb_array_elements(new.payload->'taskIds') with ordinality p(x,n)
        where policy->'confirmedOrder' @> jsonb_build_array(x);
      if before_ids<>after_ids then raise exception 'Update required: confirm ordering through the planning command' using errcode='0A000'; end if;
    end if;
  elsif new.entity_type='tasks' and tg_op='UPDATE' and new.deleted_at is null
    and coalesce(new.payload->>'scheduledFor',new.payload->>'dateAssigned')=coalesce(old.payload->>'scheduledFor',old.payload->>'dateAssigned')
    and coalesce((select enforce_order_lock from goalflow_planning.accounts where user_id=new.user_id),false)
    and exists(select 1 from goalflow_planning.days d where d.user_id=new.user_id
      and d.local_date::text=coalesce(new.payload->>'scheduledFor',new.payload->>'dateAssigned') and d.policy->'revision'<>'null'::jsonb)
    and (jsonb_build_array(new.payload->'plannedOrder',new.payload->'isFrog',new.payload->'beforeFrog')
      is distinct from jsonb_build_array(old.payload->'plannedOrder',old.payload->'isFrog',old.payload->'beforeFrog')) then
    raise exception 'Update required: order is locked; use a planning confirmation' using errcode='0A000';
  end if;
  return new;
end; $fn$;
revoke all on function goalflow_planning.guard_order_write() from public,anon,authenticated;
create trigger guard_planning_order before insert or update on public.sync_records
  for each row execute function goalflow_planning.guard_order_write();
