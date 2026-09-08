import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8'
);
const sourceGate = readFileSync(
  new URL('../macos-native/scripts/verify-project-sources.sh', import.meta.url),
  'utf8'
);

describe('macOS beta artifact', () => {
  it('labels, verifies, fingerprints, and retains the ad-hoc candidate honestly', () => {
    const buildStep = workflow.slice(
      workflow.indexOf('Build ad-hoc signed macOS beta candidate'),
      workflow.indexOf('Upload ad-hoc signed macOS beta candidate')
    );
    expect(workflow).toContain('Build ad-hoc signed macOS beta candidate');
    expect(workflow).toContain('codesign --verify --deep --strict "$app"');
    expect(workflow).toContain('tsurfing-macos-ad-hoc-beta.zip');
    expect(workflow).toContain('shasum -a 256 --check tsurfing-macos-ad-hoc-beta.zip.sha256');
    expect(workflow).toContain('signing=ad-hoc');
    expect(workflow).toContain('notarization=not-requested');
    expect(workflow).toContain('name: tsurfing-macos-ad-hoc-beta');
    expect(workflow).toContain('if-no-files-found: error');
    expect(buildStep).toContain('checked_out_commit="$(git rev-parse HEAD)"');
    expect(buildStep).not.toContain('$GITHUB_SHA');
  });

  it('fails closed when Swift source discovery is empty or ambiguous', () => {
    expect(sourceGate).toContain('[ -s "$source_list" ]');
    expect(sourceGate).toContain('Duplicate Swift basenames');
    expect(sourceGate).toContain("find macos-native/GoalflowMac macos-native/GoalflowMacTests");
    expect(sourceGate).toContain("LC_ALL=C sort | uniq -d");
    expect(sourceGate).toContain("exit(count < 2)");
    expect(sourceGate).not.toContain('rg ');
    expect(sourceGate).not.toContain('done < <(cd "$repo_root"');
  });
});
