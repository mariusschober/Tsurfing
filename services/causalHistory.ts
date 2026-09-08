import { openDB } from 'idb';
import { z } from 'zod';
import { CAUSAL_STORE, readCausalAccount } from './causalStorage';
import type { CausalEnrollmentState } from './causalEnrollment';
import { assertCausalCapability } from './causalCapability';
import { CausalTransportError } from './causalTransport';
import { readResponseBodyWithLimit } from './boundedResponse';
import { stableJson } from './syncProtocol';
import { assembleCausalHistoryEntry, assertCausalHistoryChunk, assertCausalHistoryEntry, causalHistoryHash, causalHistoryPosition, MAX_CAUSAL_HISTORY_ENTRY_BYTES,
  type CausalHistoryChunk, type CausalHistoryPosition } from './causalHistoryProtocol';

export interface SavedCausalHistory {
  schemaVersion: 1;
  epoch: string;
  throughRevision: number;
  downloadedRevision: number;
  entries: Record<string, { body: string; sha256: string }>;
  partial?: { position: CausalHistoryPosition; chunks: CausalHistoryChunk[] };
}
interface State extends CausalEnrollmentState { causalHistory?: SavedCausalHistory }
export interface HistoryRuntime {
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function fetchCausalHistoryChunk(accountId: string, position: CausalHistoryPosition, runtime: HistoryRuntime) {
  z.string().uuid().parse(accountId);
  causalHistoryPosition.parse(position);
  const timeout = runtime.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new RangeError('Invalid request deadline.');
  const controller = new AbortController();
  const abort = () => controller.abort(runtime.signal?.reason);
  runtime.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    if (runtime.signal?.aborted) abort();
    controller.signal.throwIfAborted();
    const query = new URLSearchParams({ epoch: position.epoch, revision: String(position.revision),
      throughRevision: String(position.throughRevision), offset: String(position.offset) });
    const response = await runtime.authenticatedFetch(`/api/v1/sync/causal-history?${query}`, { method: 'GET', cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CausalTransportError(response.status, [408, 425, 429].includes(response.status) || response.status >= 500);
    }
    const bytes = await readResponseBodyWithLimit(response, 72 * 1024);
    controller.signal.throwIfAborted();
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes ?? new ArrayBuffer(0))); }
    catch (_) { throw new Error('The causal history response is invalid.'); }
    return await assertCausalHistoryChunk(accountId, position, decoded);
  } finally { clearTimeout(timer); runtime.signal?.removeEventListener('abort', abort); }
}

/** Revalidate imported/resumed evidence. A saved cursor is never proof by itself. */
export async function validateSavedCausalHistory(accountId: string, history: SavedCausalHistory) {
  const fail = () => { throw new Error('The retained causal history requires recovery. Its evidence remains unchanged.'); };
  if (!history || history.schemaVersion !== 1 || !Number.isSafeInteger(history.throughRevision) || history.throughRevision < 0
    || !Number.isSafeInteger(history.downloadedRevision) || history.downloadedRevision < -1
    || history.downloadedRevision > history.throughRevision || !history.entries || typeof history.entries !== 'object'
    || Array.isArray(history.entries) || Object.keys(history.entries).length !== history.downloadedRevision + 1) return fail();
  for (let revision = 0; revision <= history.downloadedRevision; revision++) {
    const saved = history.entries[String(revision)];
    if (!saved || typeof saved.body !== 'string') return fail();
    const bytes = new TextEncoder().encode(saved.body);
    if (bytes.length > MAX_CAUSAL_HISTORY_ENTRY_BYTES || await causalHistoryHash(bytes) !== saved.sha256) return fail();
    assertCausalHistoryEntry(accountId, history.epoch, revision, JSON.parse(saved.body));
  }
  if (history.partial) {
    const { position, chunks } = history.partial;
    if (position.epoch !== history.epoch || position.revision !== history.downloadedRevision + 1
      || position.throughRevision !== history.throughRevision || position.offset !== 0 || !Array.isArray(chunks) || !chunks.length) return fail();
    let offset = 0;
    for (const raw of chunks) {
      const chunk = await assertCausalHistoryChunk(accountId, { ...position, offset }, raw);
      if (chunk.sha256 !== chunks[0].sha256 || chunk.totalBytes !== chunks[0].totalBytes || chunk.nextOffset === null) return fail();
      offset = chunk.nextOffset;
    }
  }
}

async function readState(name: string, accountId: string) {
  const db = await openDB(name);
  try {
    if (!db.objectStoreNames.contains(CAUSAL_STORE)) throw new Error('Explicit causal admission is required before history download.');
    const tx = db.transaction([CAUSAL_STORE], 'readonly');
    const state = await readCausalAccount(tx, accountId) as State | undefined;
    await tx.done;
    if (!state) throw new Error('The local causal account is missing.');
    const capability = assertCausalCapability(accountId, state.causalCapability);
    if (!capability.enrolled) throw new Error('The causal account epoch is not bound.');
    return { state, capability };
  } finally { db.close(); }
}

/** Only the history field changes. A concurrent local admission cannot be lost.
 * Crypto/network work finishes before this transaction starts. */
async function saveHistory(name: string, accountId: string, prior: SavedCausalHistory | undefined, next: SavedCausalHistory) {
  const db = await openDB(name);
  try {
    const tx = db.transaction([CAUSAL_STORE], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, accountId) as State | undefined;
      if (!state) throw new Error('The local causal account is missing.');
      const capability = assertCausalCapability(accountId, state.causalCapability);
      if (!capability.enrolled || capability.epoch !== next.epoch || capability.projectionRevision < next.throughRevision
        || stableJson(state.causalHistory) !== stableJson(prior)) throw new Error('Causal history changed concurrently. Resume from retained progress.');
      state.causalHistory = next;
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch (_) {}
      try { await tx.done; } catch (_) {}
      throw error;
    }
  } finally { db.close(); }
}

/** Bounded work per call, unlimited retained revision count. Resumption keeps
 * the saved horizon/offset; finishing an entry archives its exact verified body
 * in the same commit as download progress. No projection or sync cursor moves. */
export async function pullCausalHistory(name: string, accountId: string, runtime: HistoryRuntime, maxChunks = 32) {
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 1024) throw new RangeError('Invalid history work limit.');
  runtime.signal?.throwIfAborted();
  const { state, capability } = await readState(name, accountId);
  let saved = state.causalHistory;
  if (saved) {
    await validateSavedCausalHistory(accountId, saved);
    if (saved.epoch !== capability.epoch || saved.throughRevision > capability.projectionRevision) throw new Error('The retained history differs from the bound account epoch.');
  }
  let history: SavedCausalHistory = saved ? structuredClone(saved) : {
    schemaVersion: 1, epoch: capability.epoch, throughRevision: capability.projectionRevision, downloadedRevision: -1, entries: {}
  };
  if (!history.partial && history.downloadedRevision === history.throughRevision) history.throughRevision = capability.projectionRevision;
  let fetched = 0;
  while (history.downloadedRevision < history.throughRevision && fetched < maxChunks) {
    runtime.signal?.throwIfAborted();
    const partial = history.partial;
    const position = partial?.position ?? { epoch: history.epoch, revision: history.downloadedRevision + 1, throughRevision: history.throughRevision, offset: 0 };
    const offset = partial ? partial.chunks[partial.chunks.length - 1].nextOffset! : 0;
    const chunk = await fetchCausalHistoryChunk(accountId, { ...position, offset }, runtime);
    runtime.signal?.throwIfAborted();
    const chunks = [...(partial?.chunks ?? []), chunk];
    if (chunk.sha256 !== chunks[0].sha256 || chunk.totalBytes !== chunks[0].totalBytes) throw new Error('The causal history manifest changed. Retained progress is unchanged.');
    if (chunk.nextOffset === null) {
      const complete = await assembleCausalHistoryEntry(accountId, position, chunks);
      history.entries[String(position.revision)] = { body: complete.body, sha256: complete.sha256 };
      history.downloadedRevision = position.revision;
      delete history.partial;
    } else history.partial = { position, chunks };
    await saveHistory(name, accountId, saved, history);
    saved = structuredClone(history);
    history = structuredClone(history);
    fetched++;
  }
  return { complete: history.downloadedRevision === capability.projectionRevision, downloadedRevision: history.downloadedRevision,
    throughRevision: history.throughRevision, fetched };
}
