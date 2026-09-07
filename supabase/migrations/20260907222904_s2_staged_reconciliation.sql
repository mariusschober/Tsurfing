-- Immutable, authenticated staging for the complete reconciliation candidate.
-- No original WAL, request, receipt or history entry is rewritten or retired.
create table goalflow_causal.reconciliation_uploads (
  user_id uuid not null references auth.users(id) on delete cascade,
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  manifest jsonb not null,
  primary key(user_id,manifest_hash)
);
create table goalflow_causal.reconciliation_chunks (
  user_id uuid not null,
  manifest_hash text not null,
  chunk_index integer not null check(chunk_index between 0 and 63),
  chunk_data bytea not null check(octet_length(chunk_data) between 1 and 65536),
  primary key(user_id,manifest_hash,chunk_index),
  foreign key(user_id,manifest_hash) references goalflow_causal.reconciliation_uploads(user_id,manifest_hash) on delete cascade
);
alter table goalflow_causal.reconciliation_uploads enable row level security;
alter table goalflow_causal.reconciliation_chunks enable row level security;
revoke all on goalflow_causal.reconciliation_uploads,goalflow_causal.reconciliation_chunks from public,anon,authenticated;
grant select,insert on goalflow_causal.reconciliation_uploads,goalflow_causal.reconciliation_chunks to service_role;

create function goalflow_causal.validate_reconciliation_manifest(manifest jsonb)
returns void language plpgsql immutable set search_path=pg_catalog as $fn$
declare byte_count numeric; chunk_count numeric;
begin
  if jsonb_typeof(manifest) is distinct from 'object' or manifest->'schemaVersion' is distinct from '1'::jsonb
    or manifest->>'sha256' is null or manifest->>'sha256' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(manifest->'totalBytes') is distinct from 'number'
    or jsonb_typeof(manifest->'chunkCount') is distinct from 'number'
    or jsonb_typeof(manifest->'chunkHashes') is distinct from 'array' then
    raise exception 'Invalid reconciliation manifest' using errcode='22023';
  end if;
  byte_count := (manifest->>'totalBytes')::numeric;
  chunk_count := (manifest->>'chunkCount')::numeric;
  if byte_count<1 or byte_count>4194304 or trunc(byte_count)<>byte_count
    or chunk_count<>ceil(byte_count/65536) or jsonb_array_length(manifest->'chunkHashes')<>chunk_count
    or exists(select 1 from jsonb_array_elements(manifest->'chunkHashes') h
      where jsonb_typeof(h) is distinct from 'string' or h#>>'{}' !~ '^[0-9a-f]{64}$') then
    raise exception 'Reconciliation exceeds the supported staging envelope; preserve the complete candidate' using errcode='22023';
  end if;
end; $fn$;
revoke all on function goalflow_causal.validate_reconciliation_manifest(jsonb) from public,anon,authenticated;
grant execute on function goalflow_causal.validate_reconciliation_manifest(jsonb) to service_role;

create function public.goalflow_stage_reconciliation_chunk_v1(target_user_id uuid, request jsonb)
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,extensions,goalflow_causal as $fn$
declare
  upload_manifest jsonb := request->'manifest';
  prior_manifest jsonb;
  upload_index integer;
  upload_data bytea;
  prior_data bytea;
  expected_bytes integer;
  upload_key text;
begin
  perform goalflow_causal.validate_reconciliation_manifest(upload_manifest);
  upload_key := encode(sha256(convert_to(upload_manifest::text,'UTF8')),'hex');
  if target_user_id is null or jsonb_typeof(request->'chunkIndex') is distinct from 'number'
    or (request->>'chunkIndex')::numeric<>trunc((request->>'chunkIndex')::numeric)
    or (request->>'chunkIndex')::numeric<0 or (request->>'chunkIndex')::numeric>63
    or jsonb_typeof(request->'data') is distinct from 'string' or length(request->>'data')>87384
    or request->>'chunkSha256' is null or request->>'chunkSha256' !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid reconciliation chunk' using errcode='22023';
  end if;
  upload_index := (request->>'chunkIndex')::integer;
  expected_bytes := least(65536,(upload_manifest->>'totalBytes')::integer-upload_index*65536);
  upload_data := decode(request->>'data','base64');
  if upload_index>=(upload_manifest->>'chunkCount')::integer or octet_length(upload_data)<>expected_bytes
    or upload_manifest->'chunkHashes'->>upload_index is distinct from request->>'chunkSha256'
    or encode(sha256(upload_data),'hex')<>request->>'chunkSha256' then
    raise exception 'Reconciliation chunk does not match its manifest' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':reconciliation-upload:' || upload_key,0));
  select u.manifest into prior_manifest from goalflow_causal.reconciliation_uploads u
    where u.user_id=target_user_id and u.manifest_hash=upload_key;
  if found then
    if prior_manifest is distinct from upload_manifest then raise exception 'Reconciliation manifest is immutable' using errcode='22023'; end if;
  else
    insert into goalflow_causal.reconciliation_uploads(user_id,manifest_hash,manifest)
      values(target_user_id,upload_key,upload_manifest);
  end if;
  select c.chunk_data into prior_data from goalflow_causal.reconciliation_chunks c
    where c.user_id=target_user_id and c.manifest_hash=upload_key and c.chunk_index=upload_index;
  if found then
    if prior_data is distinct from upload_data then raise exception 'Reconciliation chunk is immutable' using errcode='22023'; end if;
  else
    insert into goalflow_causal.reconciliation_chunks(user_id,manifest_hash,chunk_index,chunk_data)
      values(target_user_id,upload_key,upload_index,upload_data);
  end if;
  return jsonb_build_object('staged',true,'manifest',upload_manifest,'chunkIndex',upload_index,'chunkSha256',request->'chunkSha256');
end; $fn$;
revoke all on function public.goalflow_stage_reconciliation_chunk_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_stage_reconciliation_chunk_v1(uuid,jsonb) to service_role;

create function public.goalflow_read_staged_reconciliation_v1(target_user_id uuid, target_manifest jsonb)
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,extensions,goalflow_causal as $fn$
declare stored_manifest jsonb; assembled bytea; chunk_count integer; upload_key text;
begin
  perform goalflow_causal.validate_reconciliation_manifest(target_manifest);
  upload_key := encode(sha256(convert_to(target_manifest::text,'UTF8')),'hex');
  select u.manifest into stored_manifest from goalflow_causal.reconciliation_uploads u
    where u.user_id=target_user_id and u.manifest_hash=upload_key;
  if not found or stored_manifest is distinct from target_manifest then
    raise exception 'Reconciliation manifest is missing or belongs to another account' using errcode='22023';
  end if;
  select count(*),string_agg(c.chunk_data,''::bytea order by c.chunk_index) into chunk_count,assembled
    from goalflow_causal.reconciliation_chunks c where c.user_id=target_user_id and c.manifest_hash=upload_key;
  if chunk_count<>(target_manifest->>'chunkCount')::integer or octet_length(assembled)<>(target_manifest->>'totalBytes')::integer
    or encode(sha256(assembled),'hex')<>target_manifest->>'sha256' then
    raise exception 'Reconciliation is incomplete or its complete hash differs' using errcode='22023';
  end if;
  -- The authenticated HTTP boundary applies the same candidate validation as
  -- legacy reconciliation, with a larger count bound. It then invokes the
  -- unchanged reconciliation RPC, which returns the exact candidate receipt.
  return convert_from(assembled,'UTF8')::jsonb;
end; $fn$;
revoke all on function public.goalflow_read_staged_reconciliation_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_read_staged_reconciliation_v1(uuid,jsonb) to service_role;
