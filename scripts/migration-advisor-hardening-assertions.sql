\set ON_ERROR_STOP on

do $$
declare
  policy_count integer;
  unsafe_policy text;
  missing_index text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_proc function_row
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname = 'validate_goalflow_task_schedule'
      and function_row.pronargs = 0
      and function_row.proconfig @> array['search_path=pg_catalog']::text[]
  ) then
    raise exception 'Task schedule validator does not have a fixed pg_catalog search path';
  end if;

  select count(*)
    into policy_count
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and policyname = any (array[
      'users read own profile',
      'users own sync records',
      'users own scheduled tasks',
      'users own daily plans',
      'users read own task events',
      'users read own telegram identity',
      'users read own pending captures',
      'users read own free entitlement',
      'users own sync conflicts',
      'users read own backup metadata'
    ]);
  if policy_count <> 10 then
    raise exception 'Expected 10 optimized ownership policies, found %', policy_count;
  end if;

  select format('%I.%I', tablename, policyname)
    into unsafe_policy
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and policyname = any (array[
      'users read own profile',
      'users own sync records',
      'users own scheduled tasks',
      'users own daily plans',
      'users read own task events',
      'users read own telegram identity',
      'users read own pending captures',
      'users read own free entitlement',
      'users own sync conflicts',
      'users read own backup metadata'
    ])
    and (
      qual is null
      or position('select auth.uid()' in lower(qual)) = 0
      or (
        cmd = 'ALL'
        and (
          with_check is null
          or position('select auth.uid()' in lower(with_check)) = 0
        )
      )
    )
  limit 1;
  if unsafe_policy is not null then
    raise exception 'Ownership policy does not use an auth.uid() init plan: %', unsafe_policy;
  end if;

  select expected.index_name
    into missing_index
  from unnest(array[
    'backup_metadata_user_id_idx',
    'email_auth_attempts_auth_user_id_idx',
    'email_auth_attempts_invite_id_idx',
    'email_otp_attempts_auth_user_id_idx',
    'email_otp_attempts_invite_id_idx',
    'invite_codes_created_by_idx',
    'invite_redemptions_auth_user_id_idx',
    'profiles_invited_by_idx',
    'task_events_task_id_idx',
    'task_events_user_id_task_id_idx',
    'tasks_user_id_parent_task_id_idx',
    'tasks_parent_task_id_idx',
    'telegram_auth_attempts_invite_id_idx',
    'telegram_captures_user_id_idx',
    'telegram_mini_sessions_identity_idx'
  ]) as expected(index_name)
  where not exists (
    select 1
    from pg_catalog.pg_indexes index_row
    where index_row.schemaname = 'public'
      and index_row.indexname = expected.index_name
  )
  limit 1;
  if missing_index is not null then
    raise exception 'Advisor hardening index is missing: %', missing_index;
  end if;
end;
$$;
