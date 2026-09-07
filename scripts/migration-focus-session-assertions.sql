\set ON_ERROR_STOP on
begin;
-- Every row below belongs to the migration fixture and is rolled back.
delete from public.sync_records where user_id='11111111-1111-4111-8111-111111111111' and entity_type='tracking' and entity_id='singleton';
create function pg_temp.push_focus_tracking(payload jsonb, changed_at timestamptz, mutation uuid default gen_random_uuid())
returns jsonb language plpgsql as $$
declare
  stored public.sync_records%rowtype;
  receipt jsonb;
  reconciled jsonb;
  candidate jsonb;
  next_version integer;
begin
  select * into stored from public.sync_records where user_id='11111111-1111-4111-8111-111111111111' and entity_type='tracking' and entity_id='singleton';
  next_version := coalesce(stored.version,0)+1;
  receipt := public.push_sync_mutation_v2('11111111-1111-4111-8111-111111111111',mutation,'focus-test','tracking','singleton',stored.server_version,next_version,payload,changed_at,null,null);
  if (receipt->>'accepted')::boolean then
    if receipt->'record'->'payload' is distinct from payload then raise exception 'An accepted receipt did not prove the exact submitted payload'; end if;
    return receipt;
  end if;
  candidate := jsonb_build_object('conflictId',receipt->>'conflictId','sourceMutationId',mutation,
    'entityType','tracking','entityId','singleton','localHistory',jsonb_build_array(jsonb_build_object(
      'mutationId',mutation,'version',next_version,'payload',payload,'updatedAt',changed_at,'deletedAt',null)));
  reconciled := public.reconcile_goalflow_sync_change('11111111-1111-4111-8111-111111111111',candidate);
  if reconciled->'candidate'<>candidate then raise exception 'Reconciliation did not echo the exact candidate'; end if;
  return jsonb_build_object('accepted',true,'serverVersion',reconciled->'record'->'server_version','record',reconciled->'record');
end;
$$;
do $$
declare
  owner_id constant uuid := '11111111-1111-4111-8111-111111111111';
  base_time timestamptz := now()-interval '20 minutes';
  focus jsonb;
  active jsonb;
  paused jsonb;
  stopped jsonb;
  answer jsonb;
  original_answer jsonb;
  original_hash text;
  original_id uuid := gen_random_uuid();
  base_version bigint;
  current_version bigint;
  rejected_id uuid := gen_random_uuid();
  rejected_receipt jsonb;
  rejected_hash text;
  candidate jsonb;
  replay jsonb;
  invalid jsonb;
  changed uuid;
begin
  active := jsonb_build_object('schemaVersion',1,'sessionId','33333333-3333-4333-8333-333333333333',
    'taskId','22222222-2222-4222-8222-222222222222','phase','active','plannedDurationSeconds',1800,
    'startedAt',base_time,'elapsedSeconds',0,'pausedAt',null,'endedAt',null,'updatedAt',base_time);
  answer := pg_temp.push_focus_tracking(jsonb_build_object('date','2026-09-07','planViewCount',1,'dailyPostponeCount',0,'focusSession',active),base_time);
  if answer->'record'->'payload'->'focusSession'<>active then raise exception 'Initial focus was not stored'; end if;
  base_version := (answer->>'serverVersion')::bigint;

  -- An unaware client can update its counters without deleting shared focus.
  original_answer := public.push_sync_mutation_v2(owner_id,original_id,'old-client','tracking','singleton',base_version,2,
    '{"date":"2026-09-07","planViewCount":2,"dailyPostponeCount":0}',base_time+interval '1 minute',null,null);
  if (original_answer->>'accepted')::boolean is distinct from false then
    raise exception 'A legacy payload was accepted despite requiring a canonical merge';
  end if;
  candidate := jsonb_build_object('conflictId',original_answer->>'conflictId','sourceMutationId',original_id,
    'entityType','tracking','entityId','singleton','localHistory',jsonb_build_array(jsonb_build_object(
      'mutationId',original_id,'version',2,'payload','{"date":"2026-09-07","planViewCount":2,"dailyPostponeCount":0}'::jsonb,
      'updatedAt',base_time+interval '1 minute','deletedAt',null)));
  answer := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if answer->'record'->'payload'->'focusSession'<>active or answer->'record'->'payload'->>'planViewCount'<>'2' then
    raise exception 'Legacy tracking recovery removed focus or lost counters';
  end if;
  select request_hash into original_hash from public.sync_mutations where user_id=owner_id and mutation_id=original_id;
  paused := active || jsonb_build_object('phase','paused','elapsedSeconds',120,'pausedAt',base_time+interval '2 minutes','updatedAt',base_time+interval '2 minutes');
  answer := pg_temp.push_focus_tracking(jsonb_build_object('planViewCount',3,'focusSession',paused),base_time+interval '2 minutes');
  current_version := (answer->>'serverVersion')::bigint;
  replay := public.push_sync_mutation_v2(owner_id,original_id,'old-client','tracking','singleton',base_version,2,
    '{"date":"2026-09-07","planViewCount":2,"dailyPostponeCount":0}',base_time+interval '1 minute',null,null);
  if replay<>original_answer or (select request_hash from public.sync_mutations where user_id=owner_id and mutation_id=original_id)<>original_hash
    or (select server_version from public.sync_records where user_id=owner_id and entity_type='tracking' and entity_id='singleton')<>current_version then
    raise exception 'Field preservation rewrote an original receipt or replayed its write';
  end if;

  -- Even with the current CAS revision, a copied old focus field cannot resume.
  answer := pg_temp.push_focus_tracking(jsonb_build_object('planViewCount',4,'focusSession',active),base_time+interval '3 minutes');
  if answer->'record'->'payload'->'focusSession'<>paused then raise exception 'Stale daily payload resumed a paused timer'; end if;
  answer := pg_temp.push_focus_tracking('{"planViewCount":5,"focusSession":null}',base_time+interval '4 minutes');
  if answer->'record'->'payload'->'focusSession'<>paused then raise exception 'Ambiguous null cleared shared focus'; end if;
  stopped := paused || jsonb_build_object('phase','stopped','pausedAt',null,'endedAt',base_time+interval '5 minutes','updatedAt',base_time+interval '5 minutes');
  answer := pg_temp.push_focus_tracking(jsonb_build_object('focusSession',stopped),base_time+interval '5 minutes');
  focus := active || jsonb_build_object('updatedAt',base_time+interval '6 minutes');
  answer := pg_temp.push_focus_tracking(jsonb_build_object('planViewCount',6,'focusSession',focus),base_time+interval '6 minutes');
  if answer->'record'->'payload'->'focusSession'<>stopped then raise exception 'A terminal session was resurrected under the same identity'; end if;

  active := active || jsonb_build_object('sessionId',gen_random_uuid(),'startedAt',base_time+interval '7 minutes','updatedAt',base_time+interval '7 minutes');
  answer := pg_temp.push_focus_tracking(jsonb_build_object('planViewCount',7,'focusSession',active),base_time+interval '7 minutes');
  if answer->'record'->'payload'->'focusSession'<>active then raise exception 'A legitimate new session could not start'; end if;
  focus := active || jsonb_build_object('phase','paused','pausedAt',base_time+interval '7 minutes');
  answer := pg_temp.push_focus_tracking(jsonb_build_object('planViewCount',8,'focusSession',focus),base_time+interval '8 minutes');
  if answer->'record'->'payload'->'focusSession'<>active then raise exception 'Cloud did not win the focus timestamp tie'; end if;

  -- The focus action is newer than cloud focus, but older than a daily counter
  -- edit. Reconciliation must retain both, not discard the paused action.
  answer := pg_temp.push_focus_tracking('{"planViewCount":99}',base_time+interval '15 minutes');
  paused := active || jsonb_build_object('phase','paused','elapsedSeconds',120,'pausedAt',base_time+interval '9 minutes','updatedAt',base_time+interval '9 minutes');
  rejected_receipt := public.push_sync_mutation_v2(owner_id,rejected_id,'offline','tracking','singleton',base_version,100,
    jsonb_build_object('planViewCount',8,'focusSession',paused),base_time+interval '9 minutes',null,null);
  if (rejected_receipt->>'accepted')::boolean is distinct from false then raise exception 'Stale CAS did not produce a conflict'; end if;
  select request_hash into rejected_hash from public.sync_mutations where user_id=owner_id and mutation_id=rejected_id;
  candidate := jsonb_build_object('conflictId',rejected_receipt->>'conflictId','sourceMutationId',rejected_id,
    'entityType','tracking','entityId','singleton','localHistory',jsonb_build_array(jsonb_build_object(
      'mutationId',rejected_id,'version',100,'payload',jsonb_build_object('planViewCount',8,'focusSession',paused),
      'updatedAt',base_time+interval '9 minutes','deletedAt',null)));
  answer := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if answer->'record'->'payload'->'focusSession'<>paused or answer->'record'->'payload'->>'planViewCount'<>'99' then
    raise exception 'Daily timestamp suppressed a newer focus action or counters regressed';
  end if;
  if (select result from public.sync_mutations where user_id=owner_id and mutation_id=rejected_id)<>rejected_receipt
    or (select request_hash from public.sync_mutations where user_id=owner_id and mutation_id=rejected_id)<>rejected_hash
    or (select result->'candidate' from public.sync_mutations where user_id=owner_id and mutation_id=(answer->>'receiptId')::uuid)<>candidate then
    raise exception 'Original rejected receipt or automatic history audit was changed';
  end if;

  -- A later local legacy writer omitted focus, but the full preserved history
  -- still contains the stop action. Counters and stop must both survive.
  stopped := paused || jsonb_build_object('phase','completed','pausedAt',null,'endedAt',base_time+interval '10 minutes','updatedAt',base_time+interval '10 minutes');
  candidate := jsonb_build_object('conflictId','pull:focus-history','sourceMutationId',null,'entityType','tracking','entityId','singleton',
    'localHistory',jsonb_build_array(
      jsonb_build_object('mutationId',gen_random_uuid(),'version',101,'payload',jsonb_build_object('focusSession',stopped),'updatedAt',base_time+interval '10 minutes','deletedAt',null),
      jsonb_build_object('mutationId',gen_random_uuid(),'version',102,'payload','{"planViewCount":100}'::jsonb,'updatedAt',base_time+interval '16 minutes','deletedAt',null)));
  answer := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if answer->'record'->'payload'->'focusSession'<>stopped or answer->'record'->'payload'->>'planViewCount'<>'100' then
    raise exception 'A legacy tail in history erased completion';
  end if;
  active := active || jsonb_build_object('sessionId',gen_random_uuid(),'startedAt',base_time+interval '17 minutes','updatedAt',base_time+interval '17 minutes');
  answer := pg_temp.push_focus_tracking(jsonb_build_object('planViewCount',100,'focusSession',active),base_time+interval '17 minutes');
  replay := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if replay->'record'->'payload'->'focusSession'<>active then raise exception 'Automatic retry returned or reapplied stale terminal state'; end if;

  foreach invalid in array array[
    jsonb_set(active,'{plannedDurationSeconds}','"1800"'),
    jsonb_set(active,'{elapsedSeconds}','null'),
    jsonb_set(active,'{elapsedSeconds}','true'),
    jsonb_set(active,'{elapsedSeconds}','-1'),
    jsonb_set(active,'{elapsedSeconds}','1.5'),
    jsonb_set(active,'{updatedAt}',to_jsonb((now()+interval '1 day')::text)),
    jsonb_set(active,'{updatedAt}',to_jsonb(to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS'))),
    jsonb_set(active,'{pausedAt}',to_jsonb(base_time)),
    jsonb_set(active,'{taskId}','"wrong-task"')
  ] loop
    begin
      perform pg_temp.push_focus_tracking(jsonb_build_object('focusSession',invalid),now());
      raise exception 'Malformed or inconsistent focus action was accepted';
    exception when sqlstate '22023' then null;
    end;
  end loop;
  begin
    select server_version into current_version from public.sync_records where user_id=owner_id and entity_type='tracking' and entity_id='singleton';
    perform public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'old-client','tracking','singleton',current_version,200,'{}',now(),now(),null);
    raise exception 'Tracking tombstone silently deleted shared focus';
  exception when sqlstate '22023' then null;
  end;
  -- Recovery must also fold history before the first shared tracking row exists.
  delete from public.sync_records where user_id=owner_id and entity_type='tracking' and entity_id='singleton';
  candidate := jsonb_set(candidate,'{conflictId}','"recovery:missing-focus"');
  answer := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if answer->'record'->'payload'->'focusSession'<>stopped or answer->'record'->'payload'->>'planViewCount'<>'100' then
    raise exception 'Missing-cloud recovery discarded focus from earlier history';
  end if;
  if has_function_privilege('authenticated','public.goalflow_merge_tracking_focus(jsonb,jsonb)','execute')
    or has_function_privilege('anon','public.goalflow_focus_session_time(jsonb)','execute') then
    raise exception 'Internal focus helpers were exposed to untrusted roles';
  end if;
end;
$$;
rollback;
