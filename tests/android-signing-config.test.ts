import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const configurations = [
  fs.readFileSync('android-native/app/build.gradle', 'utf8'),
  fs.readFileSync('android/app/build.gradle', 'utf8')
];

describe('Android signing configuration', () => {
  it.each(configurations)('uses a private unique file and removes decoded signing material', configuration => {
    expect(configuration).toContain('File.createTempFile(');
    expect(configuration).toContain('decoded.setReadable(true, true)');
    expect(configuration).toContain('decoded.setWritable(true, true)');
    expect(configuration).toContain('gradle.buildFinished');
    expect(configuration).toContain('decoded.exists() && !decoded.delete()');
    expect(configuration).not.toContain('new File("/tmp/goalflow.keystore")');
  });
});
