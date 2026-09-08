import { expect, it } from 'vitest';
import { parseCausalCompletion, assertCausalCompletionReceipt } from './causalCompletionProtocol';
import { assertCausalHistoryEntry } from './causalHistoryProtocol';
import { sendCausalCompletion } from './causalCompletionTransport';

function fixture() {
  const accountId = crypto.randomUUID(), epoch = crypto.randomUUID(), sessionId = crypto.randomUUID(), actionId = crypto.randomUUID();
  const operation: any = { schemaVersion: 2, epoch, type: 'completion', command: { schemaVersion: 1, actionId, accountId, actorId: 'fixture', kind: 'complete',
    sessionId, taskId: 'task', epoch: sessionId, expectedRevision: sessionId, expectedCurrentSessionId: sessionId, capturedAt: '2026-09-08T00:05:00.000Z', durationSeconds: null },
    changes: [{ mutationId: crypto.randomUUID(), entityType: 'tasks', entityId: 'task', deviceId: 'fixture', baseServerVersion: 7, version: 2,
      payload: { id: 'task', completed: true, lifecycleStatus: 'completed', description: '🧭'.repeat(12000), ...JSON.parse('{"__proto__":{"retained":true}}') },
      updatedAt: '2026-09-08T00:05:00.123456789Z', deletedAt: null }] };
  const member = operation.changes[0];
  const receipt: any = { schemaVersion: 2, epoch, operation, projectionRevision: 1, accepted: true, outcome: { accepted: true, code: 'APPLIED', revision: actionId },
    record: { user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', version: 2, server_version: 9, device_id: 'causal-completion-v2', updated_at: '2026-09-08T00:05:00.123456+00:00', deleted_at: null,
      payload: { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3, focusSession: { schemaVersion: 1, sessionId, taskId: 'task', phase: 'completed',
        startedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:05:00.000Z', endedAt: '2026-09-08T00:05:00.000Z', pausedAt: null, elapsedSeconds: 300, plannedDurationSeconds: 600 } } },
    changes: [{ mutationId: member.mutationId, accepted: true, serverVersion: 8, record: { user_id: accountId, entity_type: member.entityType, entity_id: member.entityId,
      version: member.version, server_version: 8, device_id: member.deviceId, updated_at: '2026-09-08T00:05:00.123457+00:00', deleted_at: null, payload: member.payload } }] };
  return { accountId, operation, receipt };
}
it('preserves exact completion and member payloads under the existing timestamp canonicalization', () => {
  const f = fixture(); const parsed = parseCausalCompletion(f.accountId, f.operation);
  expect(parsed).toEqual(f.operation); expect(assertCausalCompletionReceipt(f.accountId, parsed, f.receipt)).toBe(f.receipt);
  expect(assertCausalHistoryEntry(f.accountId, f.operation.epoch, 1, { schemaVersion: 2, accountId: f.accountId, epoch: f.operation.epoch, revision: 1, receipt: f.receipt }).receipt).toBe(f.receipt);
});
it('rejects missing, altered, cross-account or partially accepted member receipts', () => {
  const f = fixture();
  for (const modify of [
    (r: any) => { r.changes = []; }, (r: any) => { r.changes[0].record.payload.description = 'truncated'; },
    (r: any) => { r.changes[0].record.user_id = crypto.randomUUID(); }, (r: any) => { r.changes[0].accepted = false; },
    (r: any) => { r.record.payload.focusSession.phase = 'active'; }, (r: any) => { r.changes[0].mutationId = crypto.randomUUID(); }
  ]) {
    const receipt = structuredClone(f.receipt); modify(receipt);
    expect(() => assertCausalCompletionReceipt(f.accountId, f.operation, receipt)).toThrow();
  }
});
it('rejects invalid target/state and duplicate members before sending', () => {
  const f = fixture();
  for (const modify of [
    (o: any) => { o.command.accountId = crypto.randomUUID(); }, (o: any) => { o.changes.push(o.changes[0]); },
    (o: any) => { o.changes[0].payload.completed = false; }, (o: any) => { o.command.kind = 'stop'; }
  ]) {
    const operation = structuredClone(f.operation); modify(operation); expect(() => parseCausalCompletion(f.accountId, operation)).toThrow();
  }
});
it('accepts audited focus rejection only when no member was applied', () => {
  const f = fixture(); f.receipt.accepted = false; f.receipt.outcome = { accepted: false, code: 'STALE_TARGET', revision: null }; f.receipt.changes = [];
  expect(assertCausalCompletionReceipt(f.accountId, f.operation, f.receipt)).toBe(f.receipt);
  f.receipt.changes = [{}]; expect(() => assertCausalCompletionReceipt(f.accountId, f.operation, f.receipt)).toThrow();
});

it('rejects two distinct completion events within one logical completion', () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const id = crypto.randomUUID();
    f.operation.changes.push({ ...f.operation.changes[0], mutationId: crypto.randomUUID(), entityType: 'task_events', entityId: id,
      payload: { id, taskId: 'task', eventType: 'completed' } });
  }
  expect(() => parseCausalCompletion(f.accountId, f.operation)).toThrow();
});

it('resumes a large saved completion with identical chunks and member identities', async () => {
  const f = fixture(); f.operation.changes[0].payload.description = '🧭'.repeat(70000);
  const bytes = JSON.stringify(f.operation, null, 2); const chunks: string[] = []; let fail = true;
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('/stage')) {
      chunks.push(String(init?.body));
      if (body.chunkIndex === 1 && fail) { fail = false; throw new Error('synthetic interruption'); }
      return Response.json({ staged: true, manifest: body.manifest, chunkIndex: body.chunkIndex, chunkSha256: body.chunkSha256 });
    }
    expect(String(url)).toContain('complete-focus-staged'); return Response.json(f.receipt);
  };
  await expect(sendCausalCompletion(f.accountId, bytes, { authenticatedFetch: fetch })).rejects.toThrow('interruption');
  expect(await sendCausalCompletion(f.accountId, bytes, { authenticatedFetch: fetch })).toEqual(f.receipt);
  expect(chunks[0]).toBe(chunks[2]); expect(chunks[1]).toBe(chunks[3]);
  expect(JSON.stringify(f.operation, null, 2)).toBe(bytes);
});
