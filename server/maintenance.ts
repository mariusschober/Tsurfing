import { readConfig } from './config';
import { MaintenanceConfigurationError, runMaintenance } from './maintenanceTask';
import { createAdminClient } from './supabase';

let releaseSha: string | null = null;

try {
  const config = readConfig();
  releaseSha = config.RAILWAY_GIT_COMMIT_SHA?.toLowerCase() ?? null;
  const result = await runMaintenance(config, createAdminClient(config));
  console.log(JSON.stringify({
    level: 'info',
    event: 'maintenance.completed',
    releaseSha,
    backupUserCount: result.backupUserCount
  }));
} catch (error) {
  console.error(JSON.stringify({
    level: 'error',
    event: 'maintenance.failed',
    releaseSha,
    category: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof MaintenanceConfigurationError ? { problems: error.problems } : {})
  }));
  process.exitCode = 1;
}
