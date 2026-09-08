/** Tagged JSON preserves absent/undefined fields in retained cutover preimages.
 * Unsupported structured-clone values fail export explicitly rather than being
 * silently discarded by JSON.stringify. This is not a trust/receipt validator. */
export function encodeCausalBackup(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === undefined) return ['undefined'];
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return ['value', value];
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return ['value', value];
  if (typeof value !== 'object' || value === null || ancestors.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw new Error('The causal journal contains a value this backup format cannot preserve. The original database remains unchanged.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length || !Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean)) throw new Error('Sparse or extended arrays require explicit backup recovery. The original database remains unchanged.');
      return ['array', value.map(item => encodeCausalBackup(item, ancestors))];
    }
    return ['object', Object.entries(value).map(([key, item]) => [key, encodeCausalBackup(item, ancestors)])];
  } finally { ancestors.delete(value); }
}

export function decodeCausalBackup(value: unknown): unknown {
  const invalid = () => { throw new Error('The causal backup encoding is invalid. Nothing was restored.'); };
  if (!Array.isArray(value)) return invalid();
  if (value.length === 1 && value[0] === 'undefined') return undefined;
  if (value.length !== 2) return invalid();
  const [tag, payload] = value;
  if (tag === 'value') {
    if (payload === null || typeof payload === 'string' || typeof payload === 'boolean'
      || (typeof payload === 'number' && Number.isFinite(payload) && !Object.is(payload, -0))) return payload;
    return invalid();
  }
  if (!Array.isArray(payload)) return invalid();
  if (tag === 'array') return payload.map(decodeCausalBackup);
  if (tag !== 'object') return invalid();
  const result: Record<string, unknown> = {};
  for (const entry of payload) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || Object.hasOwn(result, entry[0])) return invalid();
    Object.defineProperty(result, entry[0], { value: decodeCausalBackup(entry[1]), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
