import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const build = readFileSync('android-native/app/build.gradle', 'utf8');

describe('native Android Robolectric dependency resolution', () => {
  it('uses Maven Central canonical endpoint for runtime Android SDK artifacts', () => {
    expect(build).toContain(
      'systemProperty "robolectric.dependency.repo.url", "https://repo.maven.apache.org/maven2"'
    );
    expect(build).not.toContain(
      'systemProperty "robolectric.dependency.repo.url", "https://repo1.maven.org/maven2"'
    );
  });
});
