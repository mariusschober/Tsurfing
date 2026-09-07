-- Older Mac outboxes encoded NSNumber 0/1 as JSON false/true. Preserve the
-- immutable wire payload and receipt fingerprint; decode only known numeric
-- fields in the canonical task projection, and only for native-shaped tasks.
-- All other invalid numeric values continue to fail validation.
do $legacy_mac_numbers$
declare
  function_oid oid := to_regprocedure('public.project_goalflow_task_sync(uuid,text,jsonb,bigint,timestamptz,timestamptz)');
  definition text;
  field_name text;
  before_expression text;
  after_expression text;
begin
  if function_oid is null then raise exception 'Task sync projection is missing'; end if;
  definition := pg_get_functiondef(function_oid);
  foreach field_name in array array['plannedOrder', 'frogFailures', 'rescheduleCount', 'duration', 'estimatedMinutes'] loop
    before_expression := format('(target_payload->>%L)::integer', field_name);
    after_expression := format(
      '(case when target_payload ? ''durationMinutes'' and jsonb_typeof(target_payload->%L) = ''boolean'' then case when (target_payload->>%L)::boolean then 1 else 0 end else %s end)',
      field_name, field_name, before_expression
    );
    if position(after_expression in definition) > 0 then continue; end if;
    if length(definition) - length(replace(definition, before_expression, '')) <> length(before_expression) then
      raise exception 'Task sync numeric projection has an unexpected body for %', field_name;
    end if;
    definition := replace(definition, before_expression, after_expression);
  end loop;
  execute definition;
end;
$legacy_mac_numbers$;
