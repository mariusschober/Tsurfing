import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { readConfig } from './config';
import { runMaintenance } from './maintenanceTask';

const configuredEnvironment = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://staging.goalflow.invalid',
  OWNER_USER_ID: '00000000-0000-4000-8000-000000000001',
  SUPABASE_URL: 'https://goalflow-staging.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value',
  SUPABASE_SECRET_KEY: 'sb_secret_test_value',
  ENABLE_LOCAL_DEMO: 'false',
  TELEGRAM_ENABLED: 'false',
  AI_ENABLED: 'false',
  VOICE_ENABLED: 'false',
  TURNSTILE_ENABLED: 'false',
  BACKUPS_ENABLED: 'true',
  BACKUP_MASTER_KEY: '00'.repeat(32)
};

const admin = {} as SupabaseClient;

describe('one-shot maintenance contract', () => {
  it('reports completion only after the backup runner resolves', async () => {
    const runner = vi.fn().mockResolvedValue(3);
    const result = await runMaintenance(readConfig(configuredEnvironment), admin, runner);

    expect(result).toEqual({ backupUserCount: 3 });
    expect(runner).toHaveBeenCalledOnce();
  });

  it('propagates backup failures to the process boundary', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('database unavailable'));
    await expect(runMaintenance(readConfig(configuredEnvironment), admin, runner))
      .rejects.toThrow('database unavailable');
  });

  it('refuses disabled backups or an unavailable server client', async () => {
    const disabled = readConfig({ ...configuredEnvironment, BACKUPS_ENABLED: 'false' });
    await expect(runMaintenance(disabled, admin)).rejects.toMatchObject({
      problems: expect.arrayContaining(['backups_not_enabled'])
    });

    await expect(runMaintenance(readConfig(configuredEnvironment), undefined))
      .rejects.toMatchObject({
        problems: expect.arrayContaining(['supabase_admin_client_unavailable'])
      });
  });

  it('refuses to run outside the complete production boot contract', async () => {
    const incomplete = readConfig({
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://staging.goalflow.invalid',
      BACKUPS_ENABLED: 'true',
      BACKUP_MASTER_KEY: '00'.repeat(32)
    });

    await expect(runMaintenance(incomplete, admin))
      .rejects.toMatchObject({
        problems: expect.arrayContaining([
          'supabase_url_missing',
          'supabase_public_key_missing',
          'supabase_server_key_missing',
          'owner_user_id_missing'
        ])
      });
  });
});
