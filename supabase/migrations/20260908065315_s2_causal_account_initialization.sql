-- A fresh local client can join existing tracking or create a genuinely absent
-- zero baseline. Original cutover receipts keep their unchanged v2 contract.
alter table goalflow_causal.accounts
  add column initialization_request jsonb,
  add column initialization_receipt jsonb,
  add constraint causal_initialization_pair check (
    (initialization_request is null and initialization_receipt is null)
    or (jsonb_typeof(initialization_request) is not distinct from 'object'
      and jsonb_typeof(initialization_receipt) is not distinct from 'object')
  );
grant insert on public.sync_records to service_role;

create function public.goalflow_causal_initialize_v2(target_user_id uuid, operation jsonb)
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,goalflow_causal as $fn$
declare
  state goalflow_causal.accounts%rowtype;
  tracking_record public.sync_records%rowtype;
  defaults jsonb;
  baseline jsonb;
  cutover jsonb;
  receipt jsonb;
  epoch_id uuid;
  created boolean := false;
begin
  if jsonb_typeof(operation) is distinct from 'object'
    or operation - array['schemaVersion','accountId','initializationId','initialTracking'] <> '{}'::jsonb
    or operation->'schemaVersion' is distinct from '2'::jsonb
    or operation->>'accountId' is distinct from target_user_id::text
    or jsonb_typeof(operation->'initialTracking') is distinct from 'object'
    or operation->>'initializationId' is null
    or operation->>'initializationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Invalid causal initialization operation' using errcode='22023';
  end if;
  defaults := operation->'initialTracking';
  epoch_id := (operation->>'initializationId')::uuid;
  if defaults->'planViewCount' is distinct from '0'::jsonb
    or defaults->'dailyPostponeCount' is distinct from '0'::jsonb
    or coalesce(defaults->'focusSession','null'::jsonb) <> 'null'::jsonb then
    raise exception 'Initialization requires empty local defaults' using errcode='22023';
  end if;
  baseline := jsonb_build_object('schemaVersion',1,'baselineId',epoch_id,'accountId',target_user_id,
    'day',defaults->'date','counts',jsonb_build_object('planViewCount',0,'dailyPostponeCount',0),
    'evidenceIds',jsonb_build_array(epoch_id));
  perform public.goalflow_project_counters_v1(baseline,'[]'::jsonb);
  -- Same entity-first order as push, reconciliation and causal action writers.
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':tracking:singleton',0));
  select * into state from goalflow_causal.accounts where user_id=target_user_id for update;
  if found then
    if state.initialization_request is distinct from operation then
      raise exception 'An immutable causal enrollment already exists' using errcode='22023';
    end if;
    return state.initialization_receipt;
  end if;
  select * into tracking_record from public.sync_records
    where user_id=target_user_id and entity_type='tracking' and entity_id='singleton' for update;
  if not found then
    if exists(select 1 from public.sync_mutations where user_id=target_user_id
      and (entity_type='tracking' or entity_type is null))
      or exists(select 1 from public.sync_conflicts where user_id=target_user_id and entity_type='tracking') then
      raise exception 'Missing tracking has historical evidence; explicit recovery required' using errcode='40001';
    end if;
    -- Keep the committed publication-order lock inside next_change_version.
    insert into public.sync_records(user_id,entity_type,entity_id,version,server_version,device_id,payload,updated_at,deleted_at)
      values(target_user_id,'tracking','singleton',1,public.goalflow_next_change_version(),
        'causal-initialization-v2',defaults,date_trunc('milliseconds',clock_timestamp()),null)
      returning * into tracking_record;
    created := true;
  end if;
  if tracking_record.deleted_at is not null then
    raise exception 'Deleted tracking requires explicit recovery' using errcode='40001';
  end if;
  cutover := public.goalflow_causal_cutover_v2(target_user_id,jsonb_build_object(
    'schemaVersion',2,'accountId',target_user_id,'cutoverId',epoch_id,
    'expectedTrackingServerVersion',tracking_record.server_version,'expectedTrackingPayload',tracking_record.payload));
  receipt := jsonb_build_object('schemaVersion',2,'type','initialization','operation',operation,
    'created',created,'cutoverReceipt',cutover);
  update goalflow_causal.accounts set initialization_request=operation,initialization_receipt=receipt
    where user_id=target_user_id;
  return receipt;
end; $fn$;
revoke all on function public.goalflow_causal_initialize_v2(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_causal_initialize_v2(uuid,jsonb) to service_role;
