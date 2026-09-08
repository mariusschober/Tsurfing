import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  new URL('../scripts/package-dmg.sh', import.meta.url),
  'utf8'
);

describe('macOS packaging script', () => {
  it('does not swallow packaging or notarization failures', () => {
    expect(script).toMatch(/^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
    expect(script).not.toMatch(/\|\|\s*(?:true|echo)\b/);
    expect(script).not.toContain('DerivedData');
    expect(script).toContain('trap cleanup EXIT');
    expect(script).toContain('mktemp "${TMPDIR:-/tmp}/goalflow-export-options.XXXXXX"');
    expect(script).toContain('codesign --verify --deep --strict');
    expect(script).toContain('create-dmg is required');
    expect(script).toContain('hdiutil verify "$DMG"');
    expect(script).toContain('notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait');
    expect(script).toContain('shasum -a 256 --check "$DMG.sha256"');
  });
});
