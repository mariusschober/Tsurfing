import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const restoreCommand = readFileSync(new URL('../scripts/restore-production-backup.ts', import.meta.url), 'utf8');
const maintenance = readFileSync(new URL('../server/maintenance.ts', import.meta.url), 'utf8');
const runbook = readFileSync(new URL('../docs/operations/BETA_RUNBOOK.md', import.meta.url), 'utf8');

describe('hosted restore operation gate', () => {
  it('binds destructive restore to the exact deployed commit', () => {
    expect(restoreCommand).toContain("const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/");
    expect(restoreCommand).toContain("execute && (confirmedUser !== userId || !expectedRevision)");
    expect(restoreCommand).toContain("config.RAILWAY_GIT_COMMIT_SHA?.toLowerCase() ?? null");
    expect(restoreCommand).toContain("releaseSha !== expectedRevision");
    expect(restoreCommand).toContain("Restore deployment revision does not match --expect-revision.");
    expect(restoreCommand).toContain("releaseSha,");
  });

  it('reports safe revision provenance for scheduled maintenance', () => {
    expect(maintenance).toContain("releaseSha = config.RAILWAY_GIT_COMMIT_SHA?.toLowerCase() ?? null");
    expect(maintenance).toContain("event: 'maintenance.completed'");
    expect(maintenance).toContain("event: 'maintenance.failed'");
  });

  it('documents the exact-revision argument for dry-run and execute', () => {
    expect(runbook.match(/--expect-revision/g)).toHaveLength(2);
    expect(runbook).toContain('the exact 40-character candidate commit');
    expect(runbook).toContain('refuses to execute unless Railway exposes that exact deployed');
  });
});
