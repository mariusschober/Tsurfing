\set ON_ERROR_STOP on
begin;
do $$
declare
  owner_id constant uuid := '11111111-1111-4111-8111-111111111111';
  cloud_time timestamptz := now()-interval '1 hour';
  old_receipt jsonb;
  candidate jsonb;
  answer jsonb;
  replay jsonb;
  latest jsonb;
  original_id uuid := gen_random_uuid();
  base_version bigint;
begin
  old_receipt := public.push_sync_mutation_v2(owner_id,original_id,'cloud','settings','auto-test',null,1,
    '{"theme":"cloud"}',cloud_time,null,null);
  base_version := (old_receipt->>'serverVersion')::bigint;
  candidate := jsonb_build_object('conflictId','pull:auto-test','sourceMutationId',null,
    'entityType','settings','entityId','auto-test','localHistory',jsonb_build_array(jsonb_build_object(
      'mutationId',gen_random_uuid(),'version',2,'payload',jsonb_build_object('theme','older'),
      'updatedAt',cloud_time-interval '1 hour','deletedAt',null)));
  answer := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if answer->'record'->'payload' <> '{"theme":"cloud"}' or answer->'record'->>'server_version' <> base_version::text then
    raise exception 'Older local copy overwrote the authoritative cloud';
  end if;
  if (select result->'candidate' from public.sync_mutations where user_id=owner_id and mutation_id=(answer->>'receiptId')::uuid) <> candidate then
    raise exception 'Automatic reconciliation did not durably preserve the submitted history';
  end if;
  candidate := jsonb_set(candidate,'{localHistory,0,updatedAt}',to_jsonb(cloud_time));
  answer := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if answer->'record'->'payload' <> '{"theme":"cloud"}' then raise exception 'Cloud did not win timestamp tie'; end if;
  candidate := jsonb_set(candidate,'{localHistory,0,updatedAt}',to_jsonb(cloud_time+interval '30 minutes'));
  candidate := jsonb_set(candidate,'{localHistory,0,payload}','{"theme":"newer"}');
  answer := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if answer->'record'->'payload' <> '{"theme":"newer"}'
    or (answer->'record'->>'updated_at')::timestamptz <> cloud_time+interval '30 minutes' then
    raise exception 'Newer local edit or its original timestamp was lost';
  end if;
  replay := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if answer <> replay then raise exception 'Automatic reconciliation replay was not idempotent'; end if;
  latest := public.push_sync_mutation_v2(owner_id,gen_random_uuid(),'cloud','settings','auto-test',
    (answer->'record'->>'server_version')::bigint,(answer->'record'->>'version')::integer+1,
    '{"theme":"latest"}',now(),null,null);
  replay := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if replay->'record'->'payload' <> '{"theme":"latest"}' then raise exception 'Retry returned an obsolete cloud snapshot'; end if;
  if (select result from public.sync_mutations where user_id=owner_id and mutation_id=original_id) <> old_receipt then
    raise exception 'Original push receipt was modified';
  end if;
  candidate := jsonb_set(candidate,'{entityId}','"auto-missing"');
  answer := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if answer->>'serverMissing' <> 'false' or answer->'record'->'payload' <> '{"theme":"newer"}' then
    raise exception 'Missing cloud item was not added';
  end if;
  candidate := jsonb_set(candidate,'{entityId}','"auto-test"');
  candidate := jsonb_set(candidate,'{localHistory,0,updatedAt}',to_jsonb(now()+interval '1 day'));
  answer := public.reconcile_goalflow_sync_change(owner_id,candidate);
  if answer->'record'->'payload' <> '{"theme":"latest"}' then raise exception 'Incorrect future device clock replaced cloud'; end if;
  if has_function_privilege('anon','public.reconcile_goalflow_sync_change(uuid,jsonb)','execute')
    or has_function_privilege('authenticated','public.reconcile_goalflow_sync_change(uuid,jsonb)','execute') then
    raise exception 'Automatic reconciliation is exposed outside the authenticated server';
  end if;
end;
$$;
rollback;
