import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const verifier = fileURLToPath(new URL('./verify-room-schema-hashes.mjs', import.meta.url));
const schemaDir = 'android-native/app/schemas/com.mariusschober.goalflow.nativeapp.data.GoalflowDatabase';
const schema = JSON.stringify({ database: { identityHash: 'test-only-identity' } });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function verify(files: Record<string, string>, manifest: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsurfing-room-hash-'));
  try {
    const directory = path.join(root, schemaDir); mkdirSync(directory, { recursive: true });
    for (const [file, content] of Object.entries(files)) writeFileSync(path.join(directory, file), content);
    writeFileSync(path.join(directory, 'ROOM_SCHEMA_SHA256_MANIFEST.json'), JSON.stringify(manifest));
    return spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it('accepts a complete matching Room hash manifest', () => {
  const result = verify({ '1.json': schema, '10.json': schema }, { '1.json': hash(schema), '10.json': hash(schema) });
  expect(result.status).toBe(0); expect(result.stdout).toContain('"checked":2');
});
it('rejects a newly added Room schema omitted from the hash manifest', () => {
  const result = verify({ '1.json': schema, '10.json': schema }, { '1.json': hash(schema) });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('ROOM_SCHEMA_MANIFEST_MISMATCH');
  expect(result.stdout).not.toContain('"status":"PASS"');
});
it('rejects a removed schema even when its old hash is still listed', () => {
  const result = verify({ '1.json': schema }, { '1.json': hash(schema), '10.json': hash(schema) });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('ROOM_SCHEMA_MANIFEST_MISMATCH');
});
it('continues rejecting an altered historical schema', () => {
  const result = verify({ '1.json': `${schema}\n` }, { '1.json': hash(schema) });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('ROOM_SCHEMA_HASH_MISMATCH');
});
it('continues requiring Room identity evidence even when content hashes match', () => {
  const invalid = JSON.stringify({ database: {} });
  const result = verify({ '1.json': invalid }, { '1.json': hash(invalid) });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('ROOM_SCHEMA_MISSING_IDENTITY');
});
