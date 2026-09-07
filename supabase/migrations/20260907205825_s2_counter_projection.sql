-- Pure counter equation used by the additive action ledger. Authorization and
-- correction evidence are checked by the admitting transaction, not this helper.
create or replace function public.goalflow_project_counters_v1(baseline jsonb, events jsonb)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public, extensions
as $function$
declare
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  event jsonb;
  evidence jsonb;
  seen jsonb := '{}'::jsonb;
  action_id text;
  counter_type text;
  plan_count numeric;
  postpone_count numeric;
  delta numeric;
  valid boolean;
begin
  valid := jsonb_typeof(baseline)='object' and baseline->'schemaVersion'='1'::jsonb
    and baseline->>'baselineId' ~ uuid_pattern and baseline->>'accountId' ~ uuid_pattern
    and baseline->>'day' ~ '^\d{4}-\d{2}-\d{2}$'
    and jsonb_typeof(baseline->'counts')='object'
    and jsonb_typeof(baseline->'counts'->'planViewCount')='number'
    and jsonb_typeof(baseline->'counts'->'dailyPostponeCount')='number'
    and jsonb_typeof(baseline->'evidenceIds')='array';
  if valid is distinct from true then raise exception 'INVALID_BASELINE' using errcode='22023'; end if;
  begin
    if to_char((baseline->>'day')::date,'YYYY-MM-DD') <> baseline->>'day' then raise exception 'invalid day'; end if;
  exception when others then raise exception 'INVALID_BASELINE' using errcode='22023'; end;
  plan_count := (baseline->'counts'->>'planViewCount')::numeric;
  postpone_count := (baseline->'counts'->>'dailyPostponeCount')::numeric;
  if plan_count<0 or plan_count>9007199254740991 or trunc(plan_count)<>plan_count
    or postpone_count<0 or postpone_count>9007199254740991 or trunc(postpone_count)<>postpone_count then
    raise exception 'INVALID_BASELINE' using errcode='22023';
  end if;
  for evidence in select value from jsonb_array_elements(baseline->'evidenceIds') loop
    if jsonb_typeof(evidence)<>'string' or (evidence#>>'{}') !~ uuid_pattern then
      raise exception 'INVALID_BASELINE' using errcode='22023';
    end if;
  end loop;
  if (select count(*)<>count(distinct value) from jsonb_array_elements(baseline->'evidenceIds')) then
    raise exception 'INVALID_BASELINE' using errcode='22023';
  end if;
  if jsonb_typeof(events) is distinct from 'array' then raise exception 'INVALID_DELTA' using errcode='22023'; end if;
  for event in select value from jsonb_array_elements(events) loop
    valid := jsonb_typeof(event)='object' and event->'schemaVersion'='1'::jsonb
      and event->>'actionId' ~ uuid_pattern and event->>'accountId' ~ uuid_pattern
      and jsonb_typeof(event->'actorId')='string' and length(event->>'actorId') between 1 and 240
      and event->>'day' ~ '^\d{4}-\d{2}-\d{2}$'
      and jsonb_typeof(event->'timeZone')='string' and event->>'timeZone' ~ '^[A-Za-z0-9_+./-]{1,128}$'
      and event->>'counter' in ('planViewCount','dailyPostponeCount')
      and jsonb_typeof(event->'delta')='number'
      and (event->'businessActionId'='null'::jsonb or event->>'businessActionId' ~ uuid_pattern)
      and (event->'correctionOf'='null'::jsonb or event->>'correctionOf' ~ uuid_pattern)
      and event->>'capturedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$';
    if valid is distinct from true then raise exception 'INVALID_DELTA' using errcode='22023'; end if;
    begin
      if to_char((event->>'day')::date,'YYYY-MM-DD') <> event->>'day'
        or to_char((event->>'capturedAt')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> event->>'capturedAt' then
        raise exception 'invalid instant';
      end if;
    exception when others then raise exception 'INVALID_DELTA' using errcode='22023'; end;
    delta := (event->>'delta')::numeric;
    if delta=0 or abs(delta)>9007199254740991 or trunc(delta)<>delta
      or (event->'correctionOf'='null'::jsonb and delta<>1) then
      raise exception 'INVALID_DELTA' using errcode='22023';
    end if;
    if event->>'accountId'<>baseline->>'accountId' then raise exception 'SCOPE_MISMATCH' using errcode='22023'; end if;
    action_id := event->>'actionId';
    if baseline->'evidenceIds' ? action_id then raise exception 'IDENTITY_MISMATCH' using errcode='22023'; end if;
    if seen ? action_id then
      if seen->action_id <> event then raise exception 'IDENTITY_MISMATCH' using errcode='22023'; end if;
      continue;
    end if;
    seen := jsonb_set(seen,array[action_id],event,true);
    if event->>'day'<>baseline->>'day' then continue; end if;
    counter_type := event->>'counter';
    if counter_type='planViewCount' then plan_count := plan_count+delta;
    else postpone_count := postpone_count+delta; end if;
  end loop;
  if plan_count<0 or plan_count>9007199254740991 or postpone_count<0 or postpone_count>9007199254740991 then
    raise exception 'RANGE' using errcode='22023';
  end if;
  return baseline->'counts' || jsonb_build_object('planViewCount',plan_count,'dailyPostponeCount',postpone_count);
end;
$function$;
revoke all on function public.goalflow_project_counters_v1(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_project_counters_v1(jsonb,jsonb) to service_role;
