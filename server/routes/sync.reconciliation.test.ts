import express from 'express';
import { createServer, type Server } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncRouter } from './sync';
import { prepareStagedBody } from '../../services/reconciliationStaging';
import { causalHistoryHash } from '../../services/causalHistoryProtocol';
const owner='11111111-1111-4111-8111-111111111111';
let server:Server|undefined;
afterEach(async()=>{ if(server) await new Promise<void>(resolve=>server!.close(()=>resolve())); server=undefined; });
const candidate=()=>({conflictId:'pull:settings:singleton:4',sourceMutationId:null,entityType:'settings',entityId:'singleton',localHistory:[{
  mutationId:'22222222-2222-4222-8222-222222222222',version:2,payload:{theme:'local'},updatedAt:'2026-09-07T10:00:00+00:00',deletedAt:null
}]});
async function endpoint(rpc:any) {
  const app=express();app.use(express.json());app.use((request,_response,next)=>{request.user={id:owner} as any;next()});app.use(createSyncRouter({rpc} as unknown as SupabaseClient));
  server=createServer(app);await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  return `http://127.0.0.1:${(server.address() as any).port}/sync/conflicts/reconcile`;
}
describe('automatic sync API boundary',()=>{
  it('binds staged completion to the authenticated owner and validates every member receipt', async () => {
    const epoch = '33333333-3333-4333-8333-333333333333', sessionId = '44444444-4444-4444-8444-444444444444';
    const actionId = '55555555-5555-4555-8555-555555555555';
    const member = { mutationId: '66666666-6666-4666-8666-666666666666', deviceId: 'fixture', entityType: 'tasks', entityId: 'task', baseServerVersion: 7, version: 2,
      payload: { id: 'task', completed: true, lifecycleStatus: 'completed', description: '🧭'.repeat(70000) }, updatedAt: '2026-09-08T00:05:00.000Z', deletedAt: null };
    const operation = { schemaVersion: 2, epoch, type: 'completion', command: { schemaVersion: 1, accountId: owner, actorId: 'fixture', actionId,
      kind: 'complete', sessionId, taskId: 'task', epoch: sessionId, expectedRevision: sessionId, expectedCurrentSessionId: sessionId,
      capturedAt: '2026-09-08T00:05:00.000Z', durationSeconds: null }, changes: [member] };
    const receipt = { schemaVersion: 2, operation, epoch, accepted: true, projectionRevision: 1, outcome: { accepted: true, code: 'APPLIED', revision: actionId },
      record: { user_id: owner, entity_type: 'tracking', entity_id: 'singleton', version: 2, server_version: 9, device_id: 'fixture', updated_at: member.updatedAt, deleted_at: null,
        payload: { focusSession: { schemaVersion: 1, sessionId, taskId: 'task', phase: 'completed', plannedDurationSeconds: 600, elapsedSeconds: 300,
          startedAt: member.updatedAt, updatedAt: member.updatedAt, endedAt: member.updatedAt, pausedAt: null } } },
      changes: [{ mutationId: member.mutationId, accepted: true, serverVersion: 8, record: { user_id: owner, entity_type: 'tasks', entity_id: 'task', device_id: member.deviceId,
        version: member.version, server_version: 8, updated_at: member.updatedAt, deleted_at: null, payload: structuredClone(member.payload) } }] };
    const upload = await prepareStagedBody(JSON.stringify(operation)); expect(upload.manifest).not.toBeNull();
    const rpc = vi.fn(async (name: string) => ({ data: name === 'goalflow_read_staged_reconciliation_v1' ? operation : receipt, error: null }));
    const url = (await endpoint(rpc)).replace('/conflicts/reconcile', '/complete-focus-staged');
    const send = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(upload.manifest) });
    const response = await send(); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(receipt);
    expect(rpc).toHaveBeenCalledWith('goalflow_complete_focus_v2', { target_user_id: owner, operation });
    receipt.changes[0].record.payload.description = 'truncated';
    expect((await send()).status).toBe(503);
    operation.command.accountId = epoch;
    expect((await send()).status).toBe(400);
  });
  it('scopes history chunks to the authenticated owner and rejects invalid positions and corrupt bytes', async () => {
    const epoch = '33333333-3333-4333-8333-333333333333';
    const bytes = new TextEncoder().encode('synthetic transport');
    const sha256 = await causalHistoryHash(bytes);
    const chunk = { schemaVersion: 2, accountId: owner, epoch, revision: 0, throughRevision: 1,
      offset: 0, totalBytes: bytes.length, sha256, chunkSha256: sha256,
      data: Buffer.from(bytes).toString('base64'), nextOffset: null };
    const rpc = vi.fn().mockResolvedValue({ data: chunk, error: null });
    const url = (await endpoint(rpc)).replace('/conflicts/reconcile', '/causal-history');
    const query = `?epoch=${epoch}&revision=0&throughRevision=1&offset=0`;
    const response = await fetch(url + query);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(chunk);
    expect(rpc).toHaveBeenCalledWith('goalflow_causal_history_chunk_v2', {
      target_user_id: owner, target_epoch: epoch, target_revision: 0, through_revision: 1, target_offset: 0
    });
    for (const invalid of [query + '&accountId=other', query.replace('offset=0', 'offset=1'),
      query.replace('revision=0', 'revision=2'), query.replace('offset=0', 'offset=NaN')]) {
      expect((await fetch(url + invalid)).status).toBe(400);
    }
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValue({ data: { ...chunk, data: 'AAAA' }, error: null });
    expect((await fetch(url + query)).status).toBe(503);
    rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'private synthetic diagnostic' } });
    const conflict = await fetch(url + query);
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain('private synthetic');
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'private synthetic diagnostic' } });
    const failure = await fetch(url + query);
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('private synthetic');
  });
  it('discovers only the authenticated account epoch and never caches or enrolls it', async () => {
    const result = { schemaVersion: 2, accountId: owner, enrolled: true, epoch: '33333333-3333-4333-8333-333333333333', projectionRevision: 3, rolloutReady: false };
    const rpc = vi.fn().mockResolvedValue({ data: result, error: null });
    const url = (await endpoint(rpc)).replace('/conflicts/reconcile', '/causal-capability');
    const response = await fetch(url + '?accountId=other');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(result);
    expect(rpc).toHaveBeenCalledWith('goalflow_causal_capability_v2', { target_user_id: owner });
    result.accountId = '22222222-2222-4222-8222-222222222222';
    expect((await fetch(url)).status).toBe(503);
    rpc.mockResolvedValue({ data: null, error: { message: 'private synthetic diagnostic' } });
    const unavailable = await fetch(url);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('private synthetic');
  });
  it('routes causal actions by authenticated owner and rejects mismatched receipts', async () => {
    const actionId = '22222222-2222-4222-8222-222222222222';
    const epoch = '33333333-3333-4333-8333-333333333333';
    const body = { schemaVersion: 2, epoch, type: 'counter', command: {
      schemaVersion: 1, actionId, accountId: owner, actorId: 'synthetic', day: '2026-09-08', timeZone: 'UTC',
      counter: 'planViewCount', delta: 1, capturedAt: '2026-09-08T00:00:00.000Z', businessActionId: null, correctionOf: null
    } };
    const result = { schemaVersion: 2, operation: body, epoch, accepted: true, projectionRevision: 1,
      outcome: { accepted: true, code: 'APPLIED', day: '2026-09-08', counts: { planViewCount: 28, dailyPostponeCount: 3 } },
      record: { user_id: owner, entity_type: 'tracking', entity_id: 'singleton', version: 2, server_version: 5,
        device_id: 'causal-action-v2', updated_at: '2026-09-08T00:00:00.123456+00:00', deleted_at: null,
        payload: { date: '2026-09-08', planViewCount: 28, dailyPostponeCount: 3 } } };
    const rpc = vi.fn().mockResolvedValue({ data: result, error: null });
    const url = (await endpoint(rpc)).replace('/conflicts/reconcile', '/actions');
    const send = (input: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    expect((await send(body)).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('goalflow_admit_action_v2', { target_user_id: owner, operation: body });
    expect((await send({ ...body, command: { ...body.command, accountId: epoch } })).status).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(1);
    result.record.user_id = epoch;
    expect((await send(body)).status).toBe(500);
    rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'private synthetic database details' } });
    const conflict = await send(body);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: 'causal_review_required',
      message: 'This saved action needs recovery review. Keep its original identity and contents.' } });
    rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
    expect((await send(body)).status).toBe(503);
  });
  it('replays a staged oversized mutation through the exact legacy receipt boundary', async () => {
    const mutation = { mutationId: '22222222-2222-4222-8222-222222222222', deviceId: 'original-device',
      entityType: 'settings', entityId: 'singleton', baseServerVersion: null, version: 1,
      payload: { notes: '🧭'.repeat(70000) }, updatedAt: '2026-09-07T10:00:00.123456789Z', deletedAt: null };
    const upload = await prepareStagedBody(JSON.stringify({ mutations: [mutation] }));
    let alteredReceipt = false;
    let stagedInput: unknown = JSON.parse(upload.body);
    const rpc = vi.fn(async (name: string) => {
      if (name === 'goalflow_sync_protocol_version') return { data: 3, error: null };
      if (name === 'goalflow_read_staged_reconciliation_v1') return { data: stagedInput, error: null };
      if (name === 'push_sync_mutation_v2') return { data: { accepted: true, serverVersion: 7, record: {
        entity_type: mutation.entityType, entity_id: mutation.entityId, device_id: mutation.deviceId,
        version: 1, server_version: 7, payload: alteredReceipt ? {} : mutation.payload,
        updated_at: mutation.updatedAt, deleted_at: null
      } }, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    const url = (await endpoint(rpc)).replace('/conflicts/reconcile', '/push-staged');
    const send = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(upload.manifest) });
    for (let retry = 0; retry < 2; retry++) {
      const response = await send();
      expect(response.status).toBe(200);
      expect((await response.json()).results[0].mutationId).toBe(mutation.mutationId);
    }
    expect(rpc).toHaveBeenCalledWith('goalflow_read_staged_reconciliation_v1', { target_user_id: owner, target_manifest: upload.manifest });
    expect(rpc).toHaveBeenCalledWith('push_sync_mutation_v2', expect.objectContaining({
      target_user_id: owner, target_mutation_id: mutation.mutationId, target_payload: mutation.payload,
      target_updated_at: mutation.updatedAt, target_device_id: mutation.deviceId
    }));
    alteredReceipt = true;
    expect((await send()).status).toBe(500);
    stagedInput = { mutations: [mutation, mutation] };
    expect((await send()).status).toBe(400);
  });
  it('uses authenticated owner identity and accepts original UTC offset timestamps',async()=>{
    const body=candidate();const rpc=vi.fn().mockResolvedValue({data:{reconciled:true,receiptId:'33333333-3333-4333-8333-333333333333',candidate:body,serverMissing:true,record:null},error:null});
    const result=await fetch(await endpoint(rpc),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    expect(result.status).toBe(200);expect(rpc).toHaveBeenCalledWith('reconcile_goalflow_sync_change',{target_user_id:owner,target_candidate:body});
  });
  it('rejects a client-supplied owner override and duplicate mutation identities',async()=>{
    const rpc=vi.fn();const url=await endpoint(rpc);const body=candidate();
    for(const invalid of [{...body,userId:'other'},{...body,localHistory:[...body.localHistory,...body.localHistory]}]){
      expect((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(invalid)})).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it('does not acknowledge a different candidate returned by the database',async()=>{
    const body=candidate();const rpc=vi.fn().mockResolvedValue({data:{reconciled:true,receiptId:'33333333-3333-4333-8333-333333333333',candidate:{...body,entityId:'other'},serverMissing:true},error:null});
    expect((await fetch(await endpoint(rpc),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status).toBe(500);
  });
});
