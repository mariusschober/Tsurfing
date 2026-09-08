begin;
insert into auth.users(id) values ('91919191-9191-4191-8191-919191919191'),('92929292-9292-4292-8292-929292929292');
insert into goalflow_causal.accounts(user_id,epoch,cutover_request,cutover_receipt,tracking,focus_journal,revision)
values ('91919191-9191-4191-8191-919191919191','93939393-9393-4393-8393-939393939393','{}',
  jsonb_build_object('synthetic',repeat('🧭',20000),'__proto__',jsonb_build_object('retained',true)),'{}','{}',1001);
insert into goalflow_causal.actions(user_id,action_id,request,receipt)
select '91919191-9191-4191-8191-919191919191',('94000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'{}',
  jsonb_build_object('projectionRevision',n,'synthetic',n) from generate_series(1,1001) n;
set local role service_role;
do $test$
declare
  chunk jsonb; retry jsonb; retained jsonb; assembled bytea; part bytea; offset_bytes integer; revision_no integer;
begin
  for revision_no in 0..1001 loop
    offset_bytes := 0; assembled := ''::bytea;
    loop
      chunk := public.goalflow_causal_history_chunk_v2('91919191-9191-4191-8191-919191919191','93939393-9393-4393-8393-939393939393',revision_no,1001,offset_bytes);
      retry := public.goalflow_causal_history_chunk_v2('91919191-9191-4191-8191-919191919191','93939393-9393-4393-8393-939393939393',revision_no,1001,offset_bytes);
      if chunk is distinct from retry then raise exception 'History chunk retry changed'; end if;
      part := decode(chunk->>'data','base64');
      if octet_length(part)>49152 or encode(sha256(part),'hex')<>chunk->>'chunkSha256' then raise exception 'Chunk byte boundary failed'; end if;
      assembled := assembled || part;
      exit when chunk->'nextOffset'='null'::jsonb;
      offset_bytes := (chunk->>'nextOffset')::integer;
    end loop;
    if octet_length(assembled)<>(chunk->>'totalBytes')::integer or encode(sha256(assembled),'hex')<>chunk->>'sha256' then raise exception 'History entry checksum failed'; end if;
    if revision_no=0 then select cutover_receipt into retained from goalflow_causal.accounts where user_id='91919191-9191-4191-8191-919191919191';
    else select receipt into retained from goalflow_causal.actions where user_id='91919191-9191-4191-8191-919191919191' and (receipt->>'projectionRevision')::integer=revision_no; end if;
    if convert_from(assembled,'UTF8')::jsonb->'receipt' is distinct from retained then raise exception 'History receipt changed'; end if;
  end loop;
  begin
    perform public.goalflow_causal_history_chunk_v2('92929292-9292-4292-8292-929292929292','93939393-9393-4393-8393-939393939393',0,0,0);
    raise exception 'Another account borrowed history';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.goalflow_causal_history_chunk_v2('91919191-9191-4191-8191-919191919191','93939393-9393-4393-8393-939393939393',0,1001,1);
    raise exception 'Misaligned offset accepted';
  exception when invalid_parameter_value then null; end;
  retry := public.goalflow_causal_history_chunk_v2('91919191-9191-4191-8191-919191919191','93939393-9393-4393-8393-939393939393',0,1001,0);
  update goalflow_causal.accounts set revision=1002 where user_id='91919191-9191-4191-8191-919191919191';
  chunk := public.goalflow_causal_history_chunk_v2('91919191-9191-4191-8191-919191919191','93939393-9393-4393-8393-939393939393',0,1001,0);
  if retry is distinct from chunk then raise exception 'Newer revision changed retained history'; end if;
  begin
    perform public.goalflow_causal_history_chunk_v2('91919191-9191-4191-8191-919191919191','93939393-9393-4393-8393-939393939393',1002,1002,0);
    raise exception 'Missing history revision accepted';
  exception when invalid_parameter_value then null; end;
end $test$;
set local role authenticated;
do $test$ begin
  begin
    perform public.goalflow_causal_history_chunk_v2('91919191-9191-4191-8191-919191919191','93939393-9393-4393-8393-939393939393',0,0,0);
    raise exception 'Direct client history access accepted';
  exception when insufficient_privilege then null; end;
end $test$;
reset role;
rollback;
