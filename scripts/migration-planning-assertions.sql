begin;
insert into auth.users(id) values('91919191-9191-4191-8191-919191919191');
create function pg_temp.fail_planning_write() returns trigger language plpgsql as $fn$ begin
  if current_setting('test.fail_planning',true)='yes' and new.device_id='planning-v1' and new.entity_type='daily_plans' then
    raise exception 'Synthetic final planning failure';
  end if;
  return new;
end; $fn$;
create trigger planning_failure before insert or update on public.sync_records for each row execute function pg_temp.fail_planning_write();
set local role service_role;
do $test$
declare
  owner_id uuid := '91919191-9191-4191-8191-919191919191';
  a text := '92929292-9292-4292-8292-929292929292';
  b text := '93939393-9393-4393-8393-939393939393';
  request jsonb;
  response jsonb;
  revision jsonb := 'null'::jsonb;
  first_request jsonb;
  latest jsonb;
  snapshot jsonb;
  policy_snapshot jsonb;
  record public.sync_records%rowtype;
  denied boolean;
  pure_policy jsonb;
  pure_result jsonb;
  mode text;
begin
  perform public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'fixture','tasks',a,null,1,
    jsonb_build_object('id',a,'title','First','description','Keep this note','scheduledFor','2026-09-08','dateAssigned','2026-09-08','completed',false,'plannedOrder',0,'createdAt',1),'2026-09-08T00:00:00Z',null,null);
  perform public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'fixture','tasks',b,null,1,
    jsonb_build_object('id',b,'title','Second','scheduledFor','2026-09-08','dateAssigned','2026-09-08','completed',false,'plannedOrder',1,'createdAt',2),'2026-09-08T00:00:00Z',null,null);
  perform public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'fixture','progress','singleton',null,1,'{"xp":200,"level":1}','2026-09-08T00:00:00Z',null,null);
  perform public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'fixture','settings','singleton',null,1,'{"penaltyMode":"classic"}','2026-09-08T00:00:00Z',null,null);
  for i in 0..4 loop
    request := jsonb_build_object('schemaVersion',1,'operationId',gen_random_uuid(),'accountId',owner_id,'localDate','2026-09-08',
      'baselineRevision',revision,'proposedOrder',case when i%2=0 then jsonb_build_array(a,b) else jsonb_build_array(b,a) end,
      'ratings','[]'::jsonb,'maximumAcceptedXp',50,'capturedAt','2026-09-08T18:00:00.000Z');
    if i=0 then first_request := request; end if;
    response := public.goalflow_confirm_order_v1(owner_id,request);
    if response->'receipt'->>'code'<>'APPLIED' or (response->'receipt'->>'acceptedReplans')::int<>i
      or (response->'receipt'->>'actualDebit')::int<>(case when i<4 then 0 else 50 end) then raise exception 'Incorrect daily allowance: %',response; end if;
    revision := response->'receipt'->'revision';
  end loop;
  latest := response;
  if public.goalflow_confirm_order_v1(owner_id,request) is distinct from latest then raise exception 'Duplicate receipt changed'; end if;
  if (select (payload->>'xp')::int from public.sync_records where user_id=owner_id and entity_type='progress')<>150 then raise exception 'Duplicate XP debit'; end if;
  if (select payload->>'description' from public.sync_records where user_id=owner_id and entity_type='tasks' and entity_id=a)<>'Keep this note' then raise exception 'Confirmation overwrote independent notes'; end if;
  first_request := first_request||jsonb_build_object('operationId',gen_random_uuid());
  response := public.goalflow_confirm_order_v1(owner_id,first_request);
  if response->'receipt'->>'code'<>'STALE_REVISION' or response->'receipt'->'actualDebit'<>'0'::jsonb then raise exception 'Stale order was applied'; end if;
  if public.goalflow_confirm_order_v1(owner_id,first_request) is distinct from response then raise exception 'Stale retry changed outcome'; end if;
  request := request||jsonb_build_object('operationId',gen_random_uuid(),'baselineRevision',revision,'proposedOrder',jsonb_build_array(b,a),'maximumAcceptedXp',25);
  response := public.goalflow_confirm_order_v1(owner_id,request);
  if response->'receipt'->>'code'<>'COST_CHANGED' or response->'receipt'->'requiredCost'<>'50'::jsonb then raise exception 'Unconsented cost was accepted'; end if;
  select jsonb_agg(to_jsonb(r) order by entity_type,entity_id) into snapshot from public.sync_records r where user_id=owner_id;
  select policy into policy_snapshot from goalflow_planning.days where user_id=owner_id and local_date='2026-09-08';
  request := request||jsonb_build_object('operationId',gen_random_uuid(),'maximumAcceptedXp',50);
  perform set_config('test.fail_planning','yes',true);
  denied := false;
  begin perform public.goalflow_confirm_order_v1(owner_id,request);
  exception when raise_exception then
    if sqlerrm<>'Synthetic final planning failure' then raise; end if;
    denied := true;
  end;
  perform set_config('test.fail_planning','no',true);
  if not denied then raise exception 'Failure injection did not run'; end if;
  if snapshot is distinct from (select jsonb_agg(to_jsonb(r) order by entity_type,entity_id) from public.sync_records r where user_id=owner_id)
    or policy_snapshot is distinct from (select policy from goalflow_planning.days where user_id=owner_id and local_date='2026-09-08')
    or exists(select 1 from goalflow_planning.operations where user_id=owner_id and operation_id=(request->>'operationId')::uuid) then
    raise exception 'Partial planning transaction survived failure';
  end if;
  -- Penalty mode variants share the same pure reducer as the atomic command.
  foreach mode in array array['classic','gentle','off'] loop
    pure_policy := policy_snapshot;
    pure_result := goalflow_planning.apply_confirmation(pure_policy,request,
      jsonb_build_array(jsonb_build_object('id',a,'precedence',2),jsonb_build_object('id',b,'precedence',2)),200,mode);
    if (pure_result->'receipt'->>'actualDebit')::int<>(case mode when 'classic' then 50 when 'gentle' then 25 else 0 end) then raise exception 'Incorrect penalty mode'; end if;
  end loop;
  -- Supported older clients cannot reorder once enforcement is enabled.
  insert into goalflow_planning.accounts(user_id,enforce_order_lock) values(owner_id,true);
  select * into record from public.sync_records where user_id=owner_id and entity_type='tasks' and entity_id=a;
  denied := false;
  begin perform public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'old-client','tasks',a,record.server_version,record.version+1,
    record.payload||'{"plannedOrder":99}'::jsonb,clock_timestamp(),null,null);
  exception when feature_not_supported then denied := true; end;
  if not denied then raise exception 'Old client bypassed the order lock'; end if;
  -- Notes stay editable through ordinary synchronization.
  response := public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'compatible-client','tasks',a,record.server_version,record.version+1,
    record.payload||'{"description":"An independently edited note"}'::jsonb,clock_timestamp(),null,null);
  if response->'accepted'<>'true'::jsonb then raise exception 'Permitted note edit was blocked'; end if;
  -- Operation-scoped review still includes a task moved off the original day.
  select * into record from public.sync_records where user_id=owner_id and entity_type='tasks' and entity_id=a;
  response := public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'compatible-client','tasks',a,record.server_version,record.version+1,
    record.payload||'{"scheduledFor":"2026-09-09","dateAssigned":"2026-09-09"}'::jsonb,clock_timestamp(),null,null);
  if response->'accepted'<>'true'::jsonb then raise exception 'Review fixture reschedule failed'; end if;
  snapshot := public.goalflow_planning_review_v1(owner_id,(first_request->>'operationId')::uuid);
  if snapshot is null or snapshot->'response' is distinct from (select o.response from goalflow_planning.operations o
    where o.user_id=owner_id and o.operation_id=(first_request->>'operationId')::uuid)
    or not exists(select 1 from jsonb_array_elements(snapshot->'records') r where r->>'entity_id'=a
      and r->'payload'->>'scheduledFor'='2026-09-09') then raise exception 'Review lost original receipt or moved task'; end if;
  if public.goalflow_planning_review_v1('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',(first_request->>'operationId')::uuid) is not null
    then raise exception 'Review crossed account boundary'; end if;
end; $test$;
rollback;
