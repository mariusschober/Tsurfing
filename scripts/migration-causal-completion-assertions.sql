begin;
insert into auth.users(id) values ('81818181-8181-4181-8181-818181818181');
create function pg_temp.fail_completion_write() returns trigger language plpgsql as $$ begin
  if current_setting('s2.fail_completion',true)='yes' and new.device_id='causal-completion-v2' then raise exception 'synthetic final completion failure'; end if;
  return new;
end $$;
create trigger s2_completion_failure before update on public.sync_records for each row execute function pg_temp.fail_completion_write();
set local role service_role;
do $test$
declare
  owner_id uuid := '81818181-8181-4181-8181-818181818181';
  epoch_id uuid := '82828282-8282-4282-8282-828282828282';
  task_id uuid := '83838383-8383-4383-8383-838383838383';
  session_id uuid := '84848484-8484-4484-8484-848484848484';
  event_id uuid := '85858585-8585-4585-8585-858585858585';
  action_id uuid := '86868686-8686-4686-8686-868686868686';
  before_task jsonb; after_task jsonb; tracking jsonb; task_receipt jsonb; stats_receipt jsonb; progress_receipt jsonb; tracking_receipt jsonb;
  operation jsonb; change jsonb; result jsonb; retry jsonb; bad jsonb; snapshot jsonb; after_snapshot jsonb;
  mutation_count integer; final_notes text := repeat('🧭',12000);
begin
  before_task := jsonb_build_object('id',task_id,'title','Synthetic completion target','description','Original notes','scheduledFor','2026-09-08','completed',false,'lifecycleStatus','open','future',jsonb_build_object('retained',true));
  tracking := jsonb_build_object('date','2026-09-08','planViewCount',27,'dailyPostponeCount',3,'future',jsonb_build_object('retained',true),
    'focusSession',jsonb_build_object('schemaVersion',1,'sessionId',session_id,'taskId',task_id,'phase','active','plannedDurationSeconds',600,
      'startedAt','2026-09-08T00:00:00.000Z','updatedAt','2026-09-08T00:00:00.000Z','elapsedSeconds',0,'pausedAt',null,'endedAt',null));
  task_receipt := public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'fixture','tasks',task_id::text,null,1,before_task,'2026-09-08T00:00:00Z',null,null);
  stats_receipt := public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'fixture','stats','singleton',null,1,'{"2026-09-08":{"tasksCompleted":0}}','2026-09-08T00:00:00Z',null,null);
  progress_receipt := public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'fixture','progress','singleton',null,1,'{"xp":0,"level":1}','2026-09-08T00:00:00Z',null,null);
  tracking_receipt := public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'fixture','tracking','singleton',null,1,tracking,'2026-09-08T00:00:00Z',null,null);
  perform public.goalflow_causal_cutover_v2(owner_id,jsonb_build_object('schemaVersion',2,'accountId',owner_id,'cutoverId',epoch_id,
    'expectedTrackingPayload',tracking,'expectedTrackingServerVersion',tracking_receipt->'serverVersion'));
  after_task := before_task || jsonb_build_object('description',final_notes,'completed',true,'lifecycleStatus','completed','completedAt',1788825900000);
  operation := jsonb_build_object('schemaVersion',2,'epoch',epoch_id,'type','completion','command',jsonb_build_object(
    'schemaVersion',1,'accountId',owner_id,'actorId','fixture','actionId',action_id,'kind','complete','sessionId',session_id,'taskId',task_id,
    'epoch',session_id,'expectedRevision',session_id,'expectedCurrentSessionId',session_id,'capturedAt','2026-09-08T00:05:00.000Z','durationSeconds',null),
    'changes',jsonb_build_array(
      jsonb_build_object('mutationId',gen_random_uuid(),'deviceId','fixture','entityType','tasks','entityId',task_id,'baseServerVersion',task_receipt->'serverVersion','version',2,'payload',after_task,'updatedAt','2026-09-08T00:05:00.000Z','deletedAt',null),
      jsonb_build_object('mutationId',gen_random_uuid(),'deviceId','fixture','entityType','stats','entityId','singleton','baseServerVersion',stats_receipt->'serverVersion','version',2,'payload','{"2026-09-08":{"tasksCompleted":1}}'::jsonb,'updatedAt','2026-09-08T00:05:00.000Z','deletedAt',null),
      jsonb_build_object('mutationId',gen_random_uuid(),'deviceId','fixture','entityType','progress','entityId','singleton','baseServerVersion',progress_receipt->'serverVersion','version',2,'payload','{"xp":10,"level":1}'::jsonb,'updatedAt','2026-09-08T00:05:00.000Z','deletedAt',null),
      jsonb_build_object('mutationId',gen_random_uuid(),'deviceId','fixture','entityType','task_events','entityId',event_id,'baseServerVersion',null,'version',1,
        'payload',jsonb_build_object('id',event_id,'taskId',task_id,'eventType','completed','localDate','2026-09-08','createdAt','2026-09-08T00:05:00.000Z'),
        'updatedAt','2026-09-08T00:05:00.000Z','deletedAt',null)));
  select jsonb_agg(to_jsonb(r) order by entity_type,entity_id) into snapshot from public.sync_records r where user_id=owner_id;
  select count(*) into mutation_count from public.sync_mutations where user_id=owner_id;
  change := operation->'changes'->3 || jsonb_build_object('mutationId',gen_random_uuid(),'entityId',gen_random_uuid());
  change := jsonb_set(change,'{payload,id}',change->'entityId');
  bad := jsonb_set(operation,'{changes}',operation->'changes' || jsonb_build_array(change));
  begin
    perform public.goalflow_complete_focus_v2(owner_id,bad);
    raise exception 'Completion admitted duplicate event effects';
  exception when invalid_parameter_value then null; end;
  bad := jsonb_set(operation,'{changes,2,baseServerVersion}','0');
  begin
    perform public.goalflow_complete_focus_v2(owner_id,bad);
    raise exception 'Conflicting effect partially completed task';
  exception when invalid_parameter_value then null; end;
  select jsonb_agg(to_jsonb(r) order by entity_type,entity_id) into after_snapshot from public.sync_records r where user_id=owner_id;
  if snapshot is distinct from after_snapshot or (select count(*) from public.sync_mutations where user_id=owner_id)<>mutation_count
    or (select revision from goalflow_causal.accounts where user_id=owner_id)<>0 then raise exception 'Failed member advanced state or receipt evidence'; end if;
  perform set_config('s2.fail_completion','yes',true);
  begin
    perform public.goalflow_complete_focus_v2(owner_id,operation);
    raise exception 'Injected final write unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'synthetic final completion failure' then raise; end if;
  end;
  perform set_config('s2.fail_completion','no',true);
  select jsonb_agg(to_jsonb(r) order by entity_type,entity_id) into after_snapshot from public.sync_records r where user_id=owner_id;
  if snapshot is distinct from after_snapshot or exists(select 1 from public.task_events where user_id=owner_id and id=event_id)
    or (select revision from goalflow_causal.accounts where user_id=owner_id)<>0 then raise exception 'Interrupted completion lost atomicity'; end if;
  result := public.goalflow_complete_focus_v2(owner_id,operation);
  retry := public.goalflow_complete_focus_v2(owner_id,operation);
  if result is distinct from retry or result->'accepted' is distinct from 'true'::jsonb or jsonb_array_length(result->'changes')<>4
    or result->'record'->'payload'->'focusSession'->>'phase'<>'completed'
    or (select notes from public.tasks where user_id=owner_id and id=task_id) is distinct from final_notes
    or (select count(*) from public.task_events where user_id=owner_id and id=event_id)<>1
    or (select revision from goalflow_causal.accounts where user_id=owner_id)<>1 then raise exception 'Completion receipt, full notes, or exactly-once effects failed'; end if;
  for change in select value from jsonb_array_elements(operation->'changes') loop
    if (select payload from public.sync_records where user_id=owner_id and entity_type=change->>'entityType' and entity_id=change->>'entityId') is distinct from change->'payload' then raise exception 'Completion changed exact submitted payload'; end if;
  end loop;
  begin
    perform public.goalflow_complete_focus_v2(owner_id,jsonb_set(operation,'{changes,0,payload,description}','"different notes"'));
    raise exception 'Completion identity accepted changed final notes';
  exception when invalid_parameter_value then null; end;
  bad := jsonb_set(operation,'{command,actionId}',to_jsonb(gen_random_uuid()));
  bad := jsonb_set(bad,'{changes}',(select jsonb_agg(value || jsonb_build_object('mutationId',gen_random_uuid())) from jsonb_array_elements(bad->'changes')));
  begin
    perform public.goalflow_complete_focus_v2(owner_id,bad);
    raise exception 'New action identity awarded completed task twice';
  exception when invalid_parameter_value then null; end;
  if (select payload->'2026-09-08'->>'tasksCompleted' from public.sync_records where user_id=owner_id and entity_type='stats')<>'1' then
    raise exception 'Duplicate completion changed its statistics';
  end if;
end $test$;
set local role authenticated;
do $test$ begin
  begin
    perform public.goalflow_complete_focus_v2('81818181-8181-4181-8181-818181818181','{}');
    raise exception 'Direct authenticated completion was allowed';
  exception when insufficient_privilege then null; end;
end $test$;
reset role;
rollback;
