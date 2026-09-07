\set ON_ERROR_STOP on
begin;
do $$
declare
  owner_id constant uuid := '11111111-1111-4111-8111-111111111111';
  mutation_id constant uuid := '30303030-3030-4030-8030-303030303030';
  payload jsonb := '{"id":"legacy-mac-boolean-task","title":"Legacy Mac task","schedulePrecision":"day","scheduledFor":"2099-01-01","durationMinutes":25,"plannedOrder":true,"frogFailures":false,"version":true,"isFrog":false}';
  receipt jsonb;
  replay jsonb;
  canonical public.tasks%rowtype;
begin
  receipt := public.push_sync_mutation_v2(owner_id, mutation_id, 'legacy-mac', 'tasks', 'legacy-mac-boolean-task', null, 1, payload, '2099-01-01T00:00:00Z', null, null);
  if receipt->>'accepted' <> 'true' or receipt->'record'->'payload' <> payload then
    raise exception 'Legacy payload was not accepted and preserved exactly';
  end if;
  select * into strict canonical from public.tasks where user_id=owner_id and legacy_entity_id='legacy-mac-boolean-task';
  if canonical.planned_order <> 1 or canonical.frog_failures <> 0 or canonical.is_frog then
    raise exception 'Legacy numeric projection changed field meanings';
  end if;
  replay := public.push_sync_mutation_v2(owner_id, mutation_id, 'legacy-mac', 'tasks', 'legacy-mac-boolean-task', null, 1, payload, '2099-01-01T00:00:00Z', null, null);
  if replay->>'accepted' <> 'true' or replay->'serverVersion' <> receipt->'serverVersion' or replay->'record'->'payload' <> payload then
    raise exception 'Legacy receipt replay was not stable';
  end if;
  begin
    perform public.project_goalflow_task_sync(owner_id, 'bad-legacy-number', (payload || '{"id":"bad-legacy-number","plannedOrder":"true"}'::jsonb), 9999999, now(), null);
    raise exception 'Numeric string true should have failed';
  exception when invalid_text_representation then null;
  end;
  begin
    perform public.project_goalflow_task_sync(owner_id, 'non-native-boolean', ((payload - 'durationMinutes') || '{"id":"non-native-boolean"}'::jsonb), 9999999, now(), null);
    raise exception 'Non-native boolean should have failed';
  exception when invalid_text_representation then null;
  end;
end;
$$;
rollback;
