import express from 'express';
import { createServer, type Server } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncRouter } from './sync';
import { prepareStagedBody } from '../../services/reconciliationStaging';
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
