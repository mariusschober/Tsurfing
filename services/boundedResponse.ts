export class ResponseTooLargeError extends Error {
  constructor(message = 'The server response exceeded the safe client limit.') {
    super(message);
    this.name = 'ResponseTooLargeError';
  }
}

const declaredContentLength = (response: Response): number | null => {
  const raw = response.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
};

/**
 * Consume a fetch body without allowing a compromised or misconfigured
 * upstream to allocate unbounded client memory. The caller's request deadline
 * remains active while the stream is read.
 */
export const readResponseBodyWithLimit = async (
  response: Response,
  maximumBytes: number
): Promise<ArrayBuffer | null> => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError('A positive safe response limit is required.');
  }
  const declared = declaredContentLength(response);
  if (declared !== null && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const complete = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    complete.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return complete.buffer;
};
