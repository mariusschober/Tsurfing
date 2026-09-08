begin;
insert into auth.users(id) values ('81818181-8181-4181-8181-818181818181'),('82828282-8282-4282-8282-828282828282');
insert into goalflow_causal.accounts(user_id,epoch,cutover_request,cutover_receipt,tracking,focus_journal,revision)
values ('81818181-8181-4181-8181-818181818181','83838383-8383-4383-8383-838383838383','{}','{}','{}','{}',3);
set local role service_role;
do $test$
declare enrolled jsonb; absent jsonb;
begin
  enrolled := public.goalflow_causal_capability_v2('81818181-8181-4181-8181-818181818181');
  absent := public.goalflow_causal_capability_v2('82828282-8282-4282-8282-828282828282');
  if enrolled is distinct from '{"schemaVersion":2,"accountId":"81818181-8181-4181-8181-818181818181","enrolled":true,"epoch":"83838383-8383-4383-8383-838383838383","projectionRevision":3,"rolloutReady":false}'::jsonb then raise exception 'Enrolled discovery mismatch'; end if;
  if absent is distinct from '{"schemaVersion":2,"accountId":"82828282-8282-4282-8282-828282828282","enrolled":false,"epoch":null,"projectionRevision":null,"rolloutReady":false}'::jsonb then raise exception 'Absent discovery mismatch'; end if;
  if exists(select 1 from goalflow_causal.accounts where user_id='82828282-8282-4282-8282-828282828282') then raise exception 'Discovery enrolled an account'; end if;
  begin
    perform public.goalflow_causal_capability_v2(null);
    raise exception 'Null account accepted';
  exception when invalid_parameter_value then null; end;
end $test$;
set local role authenticated;
do $test$ begin
  begin
    perform public.goalflow_causal_capability_v2('81818181-8181-4181-8181-818181818181');
    raise exception 'Authenticated role obtained private capability';
  exception when insufficient_privilege then null; end;
end $test$;
set local role anon;
do $test$ begin
  begin
    perform public.goalflow_causal_capability_v2('81818181-8181-4181-8181-818181818181');
    raise exception 'Anonymous role obtained private capability';
  exception when insufficient_privilege then null; end;
end $test$;
reset role;
do $test$ begin
  if (select prosecdef or provolatile <> 's' from pg_proc where oid='public.goalflow_causal_capability_v2(uuid)'::regprocedure) then raise exception 'Capability must be stable security invoker'; end if;
  if (select revision from goalflow_causal.accounts where user_id='81818181-8181-4181-8181-818181818181') <> 3 then raise exception 'Discovery changed revision'; end if;
end $test$;
rollback;
