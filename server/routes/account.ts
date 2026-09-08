import { Router } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { telegramIdentity } from './telegramAuth';

const userIdExportTables = [
  'profiles', 'tasks', 'daily_plans', 'task_events', 'telegram_identities', 'telegram_captures',
  'sync_records', 'sync_mutations', 'sync_conflicts', 'api_mutation_receipts', 'ai_usage',
  'entitlements', 'backup_metadata'
] as const;

export const createAccountRouter = (
  admin?: SupabaseClient,
  telegramProviderId = 'custom:telegram',
  telegramEnabled = false
) => {
  const router = Router();

  router.get('/account/export', async (request, response) => {
    if (!admin) return response.status(503).json({ error: { code: 'not_configured', message: 'Account export is not configured.' } });
    try {
      const collections: Record<string, unknown> = {};
      for (const table of userIdExportTables) {
        const { data, error } = await admin.from(table).select('*').eq('user_id', request.user!.id);
        if (error) throw error;
        collections[table] = data ?? [];
      }
      const { data: inviteCodes, error: inviteError } = await admin.from('invite_codes')
        .select('*').eq('created_by', request.user!.id);
      const { data: inviteRedemptions, error: redemptionError } = await admin.from('invite_redemptions')
        .select('*').eq('auth_user_id', request.user!.id);
      const { data: emailAttempts, error: attemptError } = await admin.from('email_auth_attempts')
        .select('id,invite_id,email,state,expires_at,auth_user_id,created_at,used_at')
        .eq('auth_user_id', request.user!.id);
      if (inviteError || redemptionError || attemptError) throw inviteError || redemptionError || attemptError;
      collections.invite_codes = inviteCodes ?? [];
      collections.invite_redemptions = inviteRedemptions ?? [];
      collections.email_auth_attempts = emailAttempts ?? [];
      const telegramIds = (collections.telegram_identities as Array<{ telegram_user_id?: number }> ?? [])
        .map(identity => identity.telegram_user_id)
        .filter((value): value is number => Number.isSafeInteger(value));
      if (telegramIds.length) {
        const { data: updates, error: updateError } = await admin.from('telegram_updates')
          .select('*').in('telegram_user_id', telegramIds);
        if (updateError) throw updateError;
        collections.telegram_updates = updates ?? [];
      } else {
        collections.telegram_updates = [];
      }
      return response.json({ schemaVersion: 3, exportedAt: new Date().toISOString(), collections });
    } catch {
      return response.status(500).json({ error: { code: 'account_export_failed', message: 'Account data could not be exported.' } });
    }
  });

  router.get('/account/telegram', async (request, response) => {
    if (!telegramEnabled || !admin) return response.json({ enabled: false, linked: false, username: null });
    const { data, error } = await admin.from('telegram_identities')
      .select('telegram_username,bot_access_granted').eq('user_id', request.user!.id).maybeSingle();
    if (error) return response.status(503).json({ error: { code: 'telegram_status_unavailable', message: 'Telegram status could not be verified.' } });
    return response.json({ enabled: true, linked: data?.bot_access_granted === true, username: data?.telegram_username ?? null });
  });

  router.post('/account/telegram/link', async (request, response) => {
    if (!telegramEnabled || !admin) return response.status(503).json({ error: { code: 'not_configured', message: 'Telegram linking is not configured.' } });
    if (request.user?.role === 'owner' && request.user.aal !== 'aal2') return response.status(403).json({ error: { code: 'mfa_required', message: 'Two-factor authentication is required before the owner can link Telegram.' } });
    try {
      const { data, error } = await admin.auth.admin.getUserById(request.user.id);
      if (error || !data.user) throw error || new Error('Auth user missing.');
      const identity = telegramIdentity(data.user, telegramProviderId);
      if (!identity) return response.status(409).json({ error: { code: 'telegram_identity_missing', message: 'Complete Telegram authorization before linking the bot.' } });
      const { data: linked, error: linkError } = await admin.rpc('goalflow_link_telegram_identity', {
        target_user_id: request.user.id,
        target_telegram_user_id: identity.id,
        target_telegram_username: identity.username
      });
      if (linkError) throw linkError;
      if (linked !== true) {
        return response.status(409).json({ error: { code: 'telegram_identity_in_use', message: 'This Telegram identity is already linked to another Tsurfing account.' } });
      }
      return response.json({ linked: true, username: identity.username || null });
    } catch {
      return response.status(500).json({ error: { code: 'telegram_link_failed', message: 'Telegram could not be linked to this account.' } });
    }
  });

  router.delete('/account/telegram/link', async (request, response) => {
    if (!telegramEnabled || !admin) return response.status(503).json({ error: { code: 'not_configured', message: 'Telegram linking is not configured.' } });
    if (request.user?.role === 'owner' && request.user.aal !== 'aal2') return response.status(403).json({ error: { code: 'mfa_required', message: 'Two-factor authentication is required before the owner can unlink Telegram.' } });
    const { error } = await admin.rpc('goalflow_revoke_user_telegram_access', { target_user_id: request.user!.id });
    if (error) return response.status(503).json({ error: { code: 'telegram_unlink_failed', message: 'Telegram access could not be revoked.' } });
    return response.json({ linked: false });
  });

  router.delete('/account', (_request, response) => {
    return response.status(409).json({
      error: {
        code: 'account_deletion_disabled',
        message: 'Self-service deletion is disabled during beta until the database and backup removal can commit safely together.'
      }
    });
  });

  return router;
};
