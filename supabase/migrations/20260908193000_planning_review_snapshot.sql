-- Review evidence is scoped to a retained command, never to client-supplied
-- task IDs. One SQL statement observes the receipt, policy and records together.
create function public.goalflow_planning_review_v1(target_user_id uuid, target_operation_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public,goalflow_planning as $fn$
  with operation as (
    select command,response,local_date from goalflow_planning.operations
    where user_id=target_user_id and operation_id=target_operation_id
  ), relevant as (
    select r.* from public.sync_records r cross join operation o
    where r.user_id=target_user_id and (
      (r.entity_type='tasks' and (
        coalesce(r.payload->>'scheduledFor',r.payload->>'dateAssigned')=o.local_date::text
        or r.entity_id in (select jsonb_array_elements_text(o.command->'proposedOrder'))))
      or (r.entity_type='progress' and r.entity_id='singleton')
      or (r.entity_type='daily_plans' and r.entity_id=o.local_date::text))
  )
  select jsonb_build_object('schemaVersion',1,'accountId',target_user_id,
    'operationId',target_operation_id,'response',o.response,
    'policy',(select policy from goalflow_planning.days where user_id=target_user_id and local_date=o.local_date),
    'records',coalesce((select jsonb_agg(to_jsonb(r) order by entity_type,entity_id) from relevant r),'[]'::jsonb),
    'missingTaskIds',coalesce((select jsonb_agg(id order by id)
      from jsonb_array_elements_text(o.command->'proposedOrder') id
      where not exists(select 1 from relevant r where r.entity_type='tasks' and r.entity_id=id)),'[]'::jsonb))
  from operation o;
$fn$;
revoke all on function public.goalflow_planning_review_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.goalflow_planning_review_v1(uuid,uuid) to service_role;
