-- Every accepted v2 receipt must still prove the exact submitted payload.
-- If preserving focus would change it, use the ordinary rejected receipt and
-- separate audited reconciliation operation instead of weakening that proof.
do $guard$
declare
  definition text;
  declaration text := '  resolution_conflict public.sync_conflicts%rowtype;';
  lock_result text := E'  record_existed := found;\n\n  if (record_existed and target_base_server_version is distinct from existing_record.server_version)';
  rejection_condition text := '    or (not record_existed and target_base_server_version is not null) then';
begin
  definition := pg_get_functiondef('public.push_sync_mutation_v2(uuid,uuid,text,text,text,bigint,integer,jsonb,timestamptz,timestamptz,uuid)'::regprocedure);
  if position(declaration in definition)=0 or position(lock_result in definition)=0 or position(rejection_condition in definition)=0 then
    raise exception 'Focus receipt guard requires the reviewed v2 mutation implementation';
  end if;
  definition := replace(definition,declaration,declaration || E'\n  focus_merge_required boolean := false;');
  definition := replace(definition,lock_result,E'  record_existed := found;\n\n  if record_existed and target_entity_type=''tracking'' and target_entity_id=''singleton'' and target_deleted_at is null then\n    focus_merge_required := public.goalflow_merge_tracking_focus(existing_record.payload,target_payload) is distinct from target_payload;\n  end if;\n\n  if (record_existed and target_base_server_version is distinct from existing_record.server_version)');
  definition := replace(definition,rejection_condition,E'    or (not record_existed and target_base_server_version is not null)\n    or focus_merge_required then');
  execute definition;
end;
$guard$;
