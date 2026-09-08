import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8'
);

describe('manual release workflow', () => {
  it('requires a successful beta gate from an exact main push run', () => {
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('set -euo pipefail');
    expect(workflow).toContain(
      '/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&head_sha=$GITHUB_SHA'
    );
    expect(workflow).toContain('.head_branch == "main"');
    expect(workflow).toContain('.event == "push"');
    expect(workflow).toContain('/actions/runs/$run_id/jobs?filter=latest');
    expect(workflow).toContain('.name == "beta-gate"');
    expect(workflow).not.toContain('/commits/$GITHUB_SHA/check-runs');
  });

  it('fails closed on signing and requires exactly one expected signer', () => {
    expect(workflow.match(/set -euo pipefail/g)?.length).toBeGreaterThanOrEqual(5);
    expect(workflow).toContain('mapfile -t signer_fingerprints');
    expect(workflow).toContain('[ "${#signer_fingerprints[@]}" -ne 1 ]');
    expect(workflow).toContain('ANDROID_EXPECT_SIGNED=1 bash android-native/scripts/verify-signing-strict.sh "$apk"');
    expect(workflow).not.toContain('tee /tmp/certs.txt');
    expect(workflow).not.toContain('present (length ${#val})');
    expect(workflow).not.toContain("find android-native/app/build/outputs -name '*.aab' -print -quit || true");
  });
});
