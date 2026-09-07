-- Align explicit resolution with reconciliation: entity before conflict.
-- Preserve request fingerprints, acceptance logic and publication ordering.
do $lock_order$
declare
  definition text;
  entity_lock text := E'  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || '':'' || target_entity_type || '':'' || target_entity_id, 0));\n';
  conflict_start text := E'  if target_resolves_conflict_id is not null then\n    select * into resolution_conflict';
begin
  definition := pg_get_functiondef('public.push_sync_mutation_v2(uuid,uuid,text,text,text,bigint,integer,jsonb,timestamptz,timestamptz,uuid)'::regprocedure);
  if md5(definition) <> '95ada6932c85d9b24a7022277421c355' then
    raise exception 'S2 lock-order migration requires the exact reviewed focus receipt guard';
  end if;
  if position(entity_lock in definition)=0 or position(conflict_start in definition)=0 then
    raise exception 'S2 lock-order migration could not locate reviewed lock sites';
  end if;
  definition := replace(definition,entity_lock,'');
  definition := replace(definition,conflict_start,entity_lock || E'\n' || conflict_start);
  execute definition;
end;
$lock_order$;
