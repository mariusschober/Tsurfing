import { describe, expect, it } from 'vitest';
import { applyAutomaticReconciliation, buildStagedLocalTransaction, emptySyncMeta, reconciliationCandidate, type LocalConflict } from './syncProtocol';
const conflict: LocalConflict = {
  id:'pull:tasks:one:2',kind:'remote-vs-local',entityType:'tasks',entityId:'one',
  localPayload:{id:'one',title:'offline'},localDeletedAt:null,
  localHistory:[{mutationId:'11111111-1111-4111-8111-111111111111',version:2,payload:{id:'one',title:'offline'},updatedAt:'2026-09-05T10:00:00Z',deletedAt:null}],
  serverPayload:{id:'one',title:'cloud'},serverMissing:false,serverDeletedAt:null,serverVersion:3,createdAt:'2026-09-07T10:00:00Z',status:'unresolved'
};
const state=()=>({...emptySyncMeta(),versions:{'tasks:one':{local:2,server:3}},conflicts:[structuredClone(conflict)]});
const candidate=()=>reconciliationCandidate(conflict);
const reply=()=>({reconciled:true,receiptId:'22222222-2222-4222-8222-222222222222',candidate:candidate(),serverMissing:false,
  record:{entity_type:'tasks',entity_id:'one',device_id:'cloud',version:3,server_version:4,payload:{id:'one',title:'newest'},updated_at:'2026-09-07T10:00:00Z',deleted_at:null}});

describe('automatic reconciliation acknowledgment boundary',()=>{
  it('applies the canonical item and removes only the acknowledged conflict',()=>{
    const result=applyAutomaticReconciliation(state(),[conflict.localPayload],candidate(),reply());
    expect(result.value).toEqual([{id:'one',title:'newest'}]);expect(result.meta.conflicts).toEqual([]);
    expect(result.meta.versions['tasks:one'].server).toBe(4);
  });
  it('retains edits queued while the reconciliation request was in flight',()=>{
    const meta=state();meta.outbox.push({mutationId:'33333333-3333-4333-8333-333333333333',entityType:'tasks',entityId:'one',deviceId:'device',version:3,baseServerVersion:3,payload:{id:'one',title:'just typed'},updatedAt:'2026-09-07T10:01:00Z',deletedAt:null});
    const value=[meta.outbox[0].payload];const result=applyAutomaticReconciliation(meta,value,candidate(),reply());
    expect(result.value).toEqual(value);expect(result.meta.outbox).toEqual(meta.outbox);expect(result.meta.conflicts).toHaveLength(0);
  });
  it('retains a conflict whose local history changed during the request',()=>{
    const meta=state();meta.conflicts[0].localHistory.push({...meta.conflicts[0].localHistory[0],version:3,mutationId:'33333333-3333-4333-8333-333333333333',payload:{id:'one',title:'new edit'}});
    expect(applyAutomaticReconciliation(meta,[conflict.localPayload],candidate(),reply()).meta.conflicts).toEqual(meta.conflicts);
  });
  it('rejects wrong candidate, wrong item, or an obsolete cloud revision',()=>{
    const wrong=reply();wrong.candidate.entityId='other';
    expect(()=>applyAutomaticReconciliation(state(),[],candidate(),wrong)).toThrow(/exact saved change/);
    const wrongRecord=reply();wrongRecord.record.entity_id='other';
    expect(()=>applyAutomaticReconciliation(state(),[],candidate(),wrongRecord)).toThrow(/invalid cloud record/);
    const stale=reply();stale.record.server_version=2;
    expect(()=>applyAutomaticReconciliation(state(),[],candidate(),stale)).toThrow(/older cloud revision/);
  });
  it('applies a cloud tombstone without deleting unrelated local tasks',()=>{
    const deleted=reply();deleted.record.deleted_at='2026-09-07T10:00:00Z' as any;
    expect(applyAutomaticReconciliation(state(),[conflict.localPayload,{id:'two',title:'retain'}],candidate(),deleted).value).toEqual([{id:'two',title:'retain'}]);
  });
  it('does not manufacture recent timestamps when seeding an old cache',()=>{
    const now='2026-09-07T10:00:00Z';
    const changes=buildStagedLocalTransaction('tasks','user',undefined,[{id:'one',updatedAt:1000},{id:'two'}],1,now,()=>crypto.randomUUID(),true)!.changes;
    expect(changes.map(item=>item.updatedAt)).toEqual(['1970-01-01T00:00:01.000Z','1970-01-01T00:00:00.000Z']);
    expect(buildStagedLocalTransaction('circadian','user',undefined,{bioLog:[]},1,now,()=>crypto.randomUUID(),true)!.changes[0].updatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(buildStagedLocalTransaction('tasks','user',[],[{id:'one'}],1,now,()=>crypto.randomUUID())!.changes[0].updatedAt).toBe(now);
  });
});
