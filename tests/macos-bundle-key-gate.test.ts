import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const verifier = path.join(repositoryRoot, 'macos-native/scripts/verify-built-app-key.sh');
const temporaryDirectories: string[] = [];

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const legacyKey = (role: 'anon' | 'service_role'): string =>
  [base64url({ alg: 'HS256', typ: 'JWT' }), base64url({ role }), 'synthetic-signature'].join('.');

const verify = async (key: string, plutilFails = false): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'goalflow-macos-key-gate-'));
  temporaryDirectories.push(root);
  const app = path.join(root, 'GoalflowMac.app');
  const bin = path.join(root, 'bin');
  await mkdir(path.join(app, 'Contents'), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(app, 'Contents/Info.plist'), 'fixture');

  const fakePlutil = path.join(bin, 'plutil');
  await writeFile(fakePlutil, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${GOALFLOW_PLUTIL_FAIL:-false}" = "true" ]; then exit 1; fi
if [ "$2" = "SUPABASE_PUBLISHABLE_KEY" ]; then
  printf '%s' "$GOALFLOW_TEST_KEY"
elif [ "$2" = "role" ]; then
  node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).role)' "$6"
else
  exit 1
fi
`);
  await chmod(fakePlutil, 0o755);

  return execFileSync('bash', [verifier, app], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GOALFLOW_TEST_KEY: key,
      GOALFLOW_PLUTIL_FAIL: String(plutilFails),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    },
  });
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('macOS distributable Supabase key gate', () => {
  it('accepts only client-safe current and legacy keys', async () => {
    await expect(verify('')).resolves.toContain('PASS (unconfigured)');
    await expect(verify('sb_publishable_goalflow_synthetic_value')).resolves.toContain('PASS');
    await expect(verify(legacyKey('anon'))).resolves.toContain('PASS');
  });

  it('rejects current and legacy server credentials', async () => {
    const currentServerKey = ['sb', 'secret', 'goalflow-test-only-server-value'].join('_');
    await expect(verify(currentServerKey)).rejects.toThrow();
    await expect(verify(legacyKey('service_role'))).rejects.toThrow();
    await expect(verify('not-a-publishable-key')).rejects.toThrow();
  });

  it('is the post-build gate used by CI', async () => {
    const workflow = await import('node:fs/promises').then(({ readFile }) =>
      readFile(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'),
    );
    expect(workflow).toContain('macos-native/scripts/verify-built-app-key.sh "$app"');
    expect(workflow).not.toContain("grep -ERaiq 'sb_secret_");
  });

  it('fails closed when the built property list cannot be inspected', async () => {
    await expect(verify('', true)).rejects.toThrow();
  });
});
