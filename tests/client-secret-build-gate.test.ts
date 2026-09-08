import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanClientContent } from '../scripts/scan-client-secrets.mjs';

const legacyKey = (role: 'anon' | 'service_role'): string => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role })).toString('base64url'),
  'synthetic-signature'
].join('.');

describe('production client secret build gate', () => {
  it('runs both client artifact checks as part of the deployable build', () => {
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const build = manifest.scripts.build;
    expect(build).toContain('npm run verify:client-secrets');
    expect(build).toContain('npm run verify:client-artifacts');
    expect(build.indexOf('npm run verify:client-secrets')).toBeGreaterThan(build.indexOf('npm run build:server'));
  });

  it('detects current secret keys and legacy service-role JWTs in emitted JavaScript', () => {
    const scanner = fs.readFileSync('scripts/scan-client-secrets.mjs', 'utf8');
    expect(scanner).toContain("legacySupabaseRole(candidate) === 'service_role'");
    expect(scanner).toContain('/sb_secret_[A-Za-z0-9_-]{8,}/');
    expect(scanClientContent('const key="sb_secret_synthetic_value";', 'bundle.js')).toEqual([
      'bundle.js: Supabase secret-key-shaped value'
    ]);
    expect(scanClientContent(`const key="${legacyKey('service_role')}";`, 'bundle.js')).toEqual([
      'bundle.js: legacy Supabase service-role JWT'
    ]);
    expect(scanClientContent(`const key="${legacyKey('anon')}";`, 'bundle.js')).toEqual([]);
  });

  it('rejects semantic test-access markers without treating library digit alphabets as backdoors', () => {
    const artifactGate = fs.readFileSync('scripts/verify-client-artifacts.mjs', 'utf8');
    const testGate = fs.readFileSync('scripts/verify-test-build.mjs', 'utf8');
    expect(artifactGate).toContain("'goalflow-test-access'");
    expect(artifactGate).toContain("'Tsurfing Test'");
    expect(artifactGate).not.toContain("'123456'");
    expect(testGate).toContain("bundle.includes('goalflow-test-access')");
    expect(testGate).toContain("bundle.includes('123456')");
  });
});
