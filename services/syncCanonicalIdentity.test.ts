import { describe, expect, it } from 'vitest';
import { stableJson } from './syncProtocol';

describe('canonical JSON preserves every own payload key', () => {
  it('retains nested __proto__ as data for exact action and receipt identity', () => {
    const payload = JSON.parse('{"nested":{"__proto__":{"value":1},"constructor":false},"__proto__":{"kept":true}}');
    expect(stableJson(payload)).toBe('{"__proto__":{"kept":true},"nested":{"__proto__":{"value":1},"constructor":false}}');
    expect(stableJson(payload)).not.toBe(stableJson({ nested: { constructor: false } }));
    expect(Object.prototype.hasOwnProperty.call(payload, '__proto__')).toBe(true);
  });
});
