-- Forward-only hardening for the actionable Supabase database advisor findings.
--
-- Server-only tables intentionally retain forced RLS with no client policies.
-- This migration fixes the mutable trigger search path, evaluates auth.uid()
-- once per statement in the existing ownership policies, and adds only the
-- foreign-key indexes that the live staging catalog proved were missing.

begin;

alter function public.validate_goalflow_task_schedule()
  set search_path = pg_catalog;

drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile"
  on public.profiles
  for select
  to public
  using ((select auth.uid()) = user_id);

drop policy if exists "users own sync records" on public.sync_records;
create policy "users own sync records"
  on public.sync_records
  for all
  to public
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users own scheduled tasks" on public.tasks;
create policy "users own scheduled tasks"
  on public.tasks
  for all
  to public
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users own daily plans" on public.daily_plans;
create policy "users own daily plans"
  on public.daily_plans
  for all
  to public
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users read own task events" on public.task_events;
create policy "users read own task events"
  on public.task_events
  for select
  to public
  using ((select auth.uid()) = user_id);

drop policy if exists "users read own telegram identity" on public.telegram_identities;
create policy "users read own telegram identity"
  on public.telegram_identities
  for select
  to public
  using ((select auth.uid()) = user_id);

drop policy if exists "users read own pending captures" on public.telegram_captures;
create policy "users read own pending captures"
  on public.telegram_captures
  for select
  to public
  using ((select auth.uid()) = user_id);

drop policy if exists "users read own free entitlement" on public.entitlements;
create policy "users read own free entitlement"
  on public.entitlements
  for select
  to public
  using ((select auth.uid()) = user_id);

drop policy if exists "users own sync conflicts" on public.sync_conflicts;
create policy "users own sync conflicts"
  on public.sync_conflicts
  for all
  to public
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users read own backup metadata" on public.backup_metadata;
create policy "users read own backup metadata"
  on public.backup_metadata
  for select
  to public
  using ((select auth.uid()) = user_id);

create index if not exists backup_metadata_user_id_idx
  on public.backup_metadata (user_id);
create index if not exists email_auth_attempts_auth_user_id_idx
  on public.email_auth_attempts (auth_user_id);
create index if not exists email_auth_attempts_invite_id_idx
  on public.email_auth_attempts (invite_id);
create index if not exists email_otp_attempts_auth_user_id_idx
  on public.email_otp_attempts (auth_user_id);
create index if not exists email_otp_attempts_invite_id_idx
  on public.email_otp_attempts (invite_id);
create index if not exists invite_codes_created_by_idx
  on public.invite_codes (created_by);
create index if not exists invite_redemptions_auth_user_id_idx
  on public.invite_redemptions (auth_user_id);
create index if not exists profiles_invited_by_idx
  on public.profiles (invited_by);
create index if not exists task_events_task_id_idx
  on public.task_events (task_id);
create index if not exists task_events_user_id_task_id_idx
  on public.task_events (user_id, task_id);
create index if not exists tasks_user_id_parent_task_id_idx
  on public.tasks (user_id, parent_task_id);
create index if not exists tasks_parent_task_id_idx
  on public.tasks (parent_task_id);
create index if not exists telegram_auth_attempts_invite_id_idx
  on public.telegram_auth_attempts (invite_id);
create index if not exists telegram_captures_user_id_idx
  on public.telegram_captures (user_id);
create index if not exists telegram_mini_sessions_identity_idx
  on public.telegram_mini_sessions (telegram_user_id, user_id);

commit;
