\set ON_ERROR_STOP on

do $$
begin
  create role anon noinherit;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role authenticated noinherit;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role service_role noinherit bypassrls;
exception when duplicate_object then null;
end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Minimal local facsimile of the managed Realtime authorization surface.
-- Production owns this schema; it is present here only so the immutable SQL
-- can be exercised on ordinary PostgreSQL in the empty and upgrade matrices.
create schema if not exists realtime;
create table if not exists realtime.messages (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  extension text not null,
  event text,
  payload jsonb,
  private boolean not null default false,
  inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
alter table realtime.messages force row level security;
grant usage on schema realtime to authenticated;
grant select, insert on table realtime.messages to authenticated;

create or replace function realtime.topic()
returns text
language sql
stable
as $$
  select nullif(current_setting('realtime.topic', true), '');
$$;
grant execute on function realtime.topic() to authenticated;

create or replace function realtime.send(
  payload jsonb,
  event text,
  topic text,
  private boolean default true
)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  insert into realtime.messages (topic, extension, event, payload, private)
  values (
    topic,
    'broadcast',
    event,
    case
      when payload ? 'id' then payload
      else jsonb_set(payload, '{id}', to_jsonb(gen_random_uuid()))
    end,
    private
  );
$$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id) on delete cascade,
  name text not null,
  owner_id text,
  created_at timestamptz not null default now()
);
