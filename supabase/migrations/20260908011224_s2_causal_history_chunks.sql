-- Each immutable action revision is a separately resumable history entry.
create unique index causal_action_revision on goalflow_causal.actions
  (user_id, ((receipt->>'projectionRevision')::bigint));

create function public.goalflow_causal_history_chunk_v2(
  target_user_id uuid, target_epoch uuid, target_revision bigint,
  through_revision bigint, target_offset integer)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog as $fn$
declare
  state record;
  saved_receipt jsonb;
  body bytea;
  part bytea;
  total integer;
begin
  if target_user_id is null or target_epoch is null or target_revision is null
    or through_revision is null or target_offset is null
    or target_revision < 0 or through_revision < target_revision
    or through_revision > 9007199254740991 or target_offset < 0 or target_offset % 49152 <> 0 then
    raise exception 'Invalid causal history position' using errcode='22023';
  end if;
  select epoch,revision,cutover_receipt into state from goalflow_causal.accounts where user_id=target_user_id;
  if not found or state.epoch <> target_epoch or through_revision > state.revision then
    raise exception 'Causal history epoch or revision is unavailable' using errcode='22023';
  end if;
  if target_revision=0 then saved_receipt := state.cutover_receipt;
  else
    select receipt into saved_receipt from goalflow_causal.actions
      where user_id=target_user_id and (receipt->>'projectionRevision')::bigint=target_revision;
    if not found then raise exception 'Causal history has a missing revision' using errcode='22023'; end if;
  end if;
  body := convert_to(jsonb_build_object('schemaVersion',2,'accountId',target_user_id,'epoch',target_epoch,
    'revision',target_revision,'receipt',saved_receipt)::text,'UTF8');
  total := octet_length(body);
  if target_offset >= total then raise exception 'Causal history offset exceeds entry' using errcode='22023'; end if;
  part := substring(body from target_offset+1 for 49152);
  return jsonb_build_object('schemaVersion',2,'accountId',target_user_id,'epoch',target_epoch,
    'revision',target_revision,'throughRevision',through_revision,'offset',target_offset,'totalBytes',total,
    'sha256',encode(sha256(body),'hex'),'chunkSha256',encode(sha256(part),'hex'),
    'data',replace(encode(part,'base64'),E'\n',''),
    'nextOffset',case when target_offset+octet_length(part)<total then target_offset+octet_length(part) else null end);
end; $fn$;
revoke all on function public.goalflow_causal_history_chunk_v2(uuid,uuid,bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.goalflow_causal_history_chunk_v2(uuid,uuid,bigint,bigint,integer) to service_role;
