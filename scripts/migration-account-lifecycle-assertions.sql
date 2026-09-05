\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, email_confirmed_at)
values
  ('33333333-1111-4111-8111-111111111111', 'beta-c@example.invalid', now()),
  ('44444444-1111-4111-8111-111111111111', 'owner-d@example.invalid', now()),
  ('55555555-1111-4111-8111-111111111111', 'unconfirmed@example.invalid', null);

insert into auth.sessions (id, user_id)
values
  (
    '33333333-2222-4222-8222-222222222222',
    '33333333-1111-4111-8111-111111111111'
  ),
  (
    '44444444-2222-4222-8222-222222222222',
    '44444444-1111-4111-8111-111111111111'
  );
update auth.sessions
set created_at = now() - interval '1 hour'
where id = '44444444-2222-4222-8222-222222222222';

insert into public.invite_codes (
  id, code_hash, label, max_uses, expires_at, created_by
) values (
  '33333333-3333-4333-8333-333333333333',
  repeat('a', 64), 'Email lifecycle test', 1, now() + interval '1 day',
  '11111111-1111-4111-8111-111111111111'
);
insert into public.email_otp_attempts (
  id, token_hash, email, purpose, approval, invite_id,
  captcha_token_hash, captcha_verified_at, request_ip_hash,
  delivery_state, expires_at
) values (
  '33333333-4444-4333-8333-333333333333',
  repeat('b', 64),
  'beta-c@example.invalid',
  'activation',
  'invite',
  '33333333-3333-4333-8333-333333333333',
  repeat('c', 64),
  now(),
  repeat('d', 64),
  'sent',
  now() + interval '10 minutes'
);

do $$
declare
  first_result boolean;
  retry_result boolean;
begin
  first_result := public.activate_goalflow_email_otp(
    repeat('b', 64),
    '33333333-1111-4111-8111-111111111111',
    'BETA-C@example.invalid',
    '33333333-2222-4222-8222-222222222222',
    now()
  );
  retry_result := public.activate_goalflow_email_otp(
    repeat('b', 64),
    '33333333-1111-4111-8111-111111111111',
    'beta-c@example.invalid',
    '33333333-2222-4222-8222-222222222222',
    now()
  );
  if first_result is not true or retry_result is not true then
    raise exception 'Email invite activation or its exact retry failed';
  end if;
  if (select use_count from public.invite_codes where id = '33333333-3333-4333-8333-333333333333') <> 1 then
    raise exception 'Email activation consumed an invite more than once';
  end if;
  if not exists (
    select 1 from public.profiles
    where user_id = '33333333-1111-4111-8111-111111111111'
      and role = 'beta' and status = 'active'
  ) or not exists (
    select 1 from public.entitlements
    where user_id = '33333333-1111-4111-8111-111111111111' and active
  ) then
    raise exception 'Email activation did not atomically bootstrap access';
  end if;
  if (select state from public.email_otp_attempts where id = '33333333-4444-4333-8333-333333333333') <> 'used' then
    raise exception 'Email OTP activation token was not consumed';
  end if;
  if public.activate_goalflow_email_otp(
    repeat('b', 64),
    '44444444-1111-4111-8111-111111111111',
    'owner-d@example.invalid',
    '44444444-2222-4222-8222-222222222222',
    now()
  ) is not false then
    raise exception 'Consumed email OTP activation replayed for another immutable identity';
  end if;
  insert into public.email_otp_attempts (
    id, token_hash, email, purpose, approval,
    captcha_token_hash, captcha_verified_at, request_ip_hash,
    delivery_state, expires_at
  ) values (
    '44444444-4444-4444-8444-444444444444',
    repeat('e', 64),
    'owner-d@example.invalid',
    'sign_in',
    'existing_account',
    repeat('f', 64),
    now(),
    repeat('1', 64),
    'sent',
    now() + interval '10 minutes'
  );
  if public.activate_goalflow_email_otp(
    repeat('e', 64),
    '44444444-1111-4111-8111-111111111111',
    'owner-d@example.invalid',
    '44444444-2222-4222-8222-222222222222',
    now()
  ) is not false then
    raise exception 'A session created before preflight bypassed typed email-code verification';
  end if;

  if public.goalflow_session_is_active(
    '33333333-1111-4111-8111-111111111111',
    '33333333-2222-4222-8222-222222222222'
  ) is not true then
    raise exception 'Live Auth session was rejected';
  end if;
  delete from auth.sessions
  where id = '33333333-2222-4222-8222-222222222222';
  if public.goalflow_session_is_active(
    '33333333-1111-4111-8111-111111111111',
    '33333333-2222-4222-8222-222222222222'
  ) is not false then
    raise exception 'Revoked Auth session remained active';
  end if;

  if public.bootstrap_goalflow_owner(
    '44444444-1111-4111-8111-111111111111',
    'owner-d@example.invalid'
  ) is not true or public.bootstrap_goalflow_owner(
    '44444444-1111-4111-8111-111111111111',
    'owner-d@example.invalid'
  ) is not true then
    raise exception 'Owner bootstrap was not idempotent';
  end if;
  if not exists (
    select 1 from public.profiles
    where user_id = '44444444-1111-4111-8111-111111111111'
      and role = 'owner' and status = 'active'
  ) or not exists (
    select 1 from public.entitlements
    where user_id = '44444444-1111-4111-8111-111111111111' and active
  ) then
    raise exception 'Owner bootstrap did not atomically create access';
  end if;
  if public.bootstrap_goalflow_owner(
    '55555555-1111-4111-8111-111111111111',
    'unconfirmed@example.invalid'
  ) is not false then
    raise exception 'Unconfirmed Auth user became owner';
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_class table_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
    where namespace_row.nspname = 'public'
      and table_row.relname = 'email_otp_attempts'
      and table_row.relrowsecurity
      and table_row.relforcerowsecurity
  ) then
    raise exception 'Email OTP attempts are not protected by forced RLS';
  end if;
  if has_table_privilege(
    'authenticated',
    'public.email_otp_attempts',
    'SELECT,INSERT,UPDATE,DELETE'
  ) then
    raise exception 'Authenticated users can access email OTP attempts directly';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.activate_goalflow_email_otp(text,uuid,text,uuid,timestamp with time zone)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.activate_goalflow_email_otp(text,uuid,text,uuid,timestamp with time zone)',
    'EXECUTE'
  ) then
    raise exception 'Email OTP activation RPC trust boundary is incorrect';
  end if;
  if has_function_privilege(
    'service_role',
    'public.activate_goalflow_email_beta(uuid,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'Metadata-authorized email activation function remains executable';
  end if;
end;
$$;

rollback;
