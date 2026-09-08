-- Read-only discovery. No account is enrolled and rollout remains disabled.
create function public.goalflow_causal_capability_v2(target_user_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog as $fn$
declare
  state record;
begin
  if target_user_id is null then raise exception 'An account UUID is required' using errcode='22023'; end if;
  select epoch,revision into state from goalflow_causal.accounts where user_id=target_user_id;
  if not found then
    return jsonb_build_object('schemaVersion',2,'accountId',target_user_id,'enrolled',false,
      'epoch',null,'projectionRevision',null,'rolloutReady',false);
  end if;
  return jsonb_build_object('schemaVersion',2,'accountId',target_user_id,'enrolled',true,
    'epoch',state.epoch,'projectionRevision',state.revision,'rolloutReady',false);
end; $fn$;
revoke all on function public.goalflow_causal_capability_v2(uuid) from public,anon,authenticated;
grant execute on function public.goalflow_causal_capability_v2(uuid) to service_role;
