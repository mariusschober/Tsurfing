import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const betaWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

describe('dependency advisory gate', () => {
  it('scans the exact committed lockfile with the current pinned OSV action', () => {
    expect(betaWorkflow).toContain('dependency-audit:');
    expect(betaWorkflow).toContain('timeout-minutes: 10');
    expect(betaWorkflow).toContain(
      'google/osv-scanner-action/osv-scanner-action@baa4139e56d6312335d899e6ba045fa16d1d3d0b # v2.5.1'
    );
    expect(betaWorkflow).toContain('--lockfile=package-lock.json');
    expect(betaWorkflow).toContain('--allow-no-lockfiles=false');
  });

  it('propagates the scanner result without retries, skips, or permissive handling', () => {
    const auditJob = betaWorkflow.slice(
      betaWorkflow.indexOf('  dependency-audit:'),
      betaWorkflow.indexOf('\n  verify:')
    );
    expect(auditJob).not.toContain('continue-on-error');
    expect(auditJob).not.toContain('retry');
    expect(auditJob).not.toContain('if:');
  });

  it('is required by the aggregate and signed beta while release reuses the exact green main gate', () => {
    expect(betaWorkflow).toContain(
      'needs: [verify, dependency-audit, secrets, migrations, android, native-android, web-release, macos, hosted-staging, hosted-cross-client]'
    );
    expect(betaWorkflow).toContain('dependency-audit=${{ needs.dependency-audit.result }}');
    expect(betaWorkflow).toContain('dependency-audit failed: ${{ needs.dependency-audit.result }}');
    expect(releaseWorkflow).toContain('does not have a successful Beta Gate push run on main');
    expect(releaseWorkflow).toContain('.name == "beta-gate"');
  });
});
