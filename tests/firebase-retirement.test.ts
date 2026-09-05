import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('retired Firebase integration', () => {
  it('does not restore Google Services build hooks or client configuration', () => {
    const rootBuild = fs.readFileSync('android/build.gradle', 'utf8');
    const appBuild = fs.readFileSync('android/app/build.gradle', 'utf8');

    expect(rootBuild).not.toContain('com.google.gms:google-services');
    expect(appBuild).not.toContain("apply plugin: 'com.google.gms.google-services'");
    expect(appBuild).not.toContain('google-services.json');
    expect(fs.existsSync('android/app/google-services.json')).toBe(false);
  });
});
