import express from 'express';
import { createServer, type Server } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncRouter } from './sync';
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
