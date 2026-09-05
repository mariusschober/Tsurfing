import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('web authentication bootstrap ordering', () => {
  it('subscribes to session changes before the initial asynchronous lookup', async () => {
    const source = await readFile('AppWrapper.tsx', 'utf8');
    const subscription = source.indexOf('unsubscribe = authService.onSessionChange(sessionChanged);');
    const lookup = source.indexOf('acceptSession(await authService.getSession()');

    expect(subscription).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(subscription);
    expect(source).toContain('version !== validationVersion');
  });
});
