#!/usr/bin/env python3
"""Immutable staged history and exact reconciliation, using real PostgreSQL."""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid


def literal(value):
    return "'" + json.dumps(value, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def query(statement, error=None):
    result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=statement+';\n',
        capture_output=True, text=True, timeout=20)
    if error:
        assert result.returncode and error in result.stderr, result.stderr[:1000]
        return None
    assert result.returncode == 0, result.stderr[:1000]
    return json.loads(result.stdout) if result.stdout.strip() else None


def upload_parts(body):
    raw = body.encode('utf8')
    parts = [raw[i:i+65536] for i in range(0,len(raw),65536)]
    manifest = dict(schemaVersion=1,sha256=hashlib.sha256(raw).hexdigest(),totalBytes=len(raw),chunkCount=len(parts),
        chunkHashes=[hashlib.sha256(part).hexdigest() for part in parts])
    return manifest,[dict(manifest=manifest,chunkIndex=i,chunkSha256=manifest['chunkHashes'][i],
        data=base64.b64encode(part).decode('ascii')) for i,part in enumerate(parts)]


def main():
    if not os.environ.get('PGDATABASE','').startswith(('goalflow_empty_','goalflow_upgrade_','s2_')):
        raise SystemExit('Disposable fixture database required')
    owner, other = str(uuid.uuid4()),str(uuid.uuid4())
    query(f"insert into auth.users(id) values('{owner}'),('{other}')")
    fixture = json.loads((Path(__file__).resolve().parent.parent/'tests/fixtures/s2/reconciliation-staging-v1.json').read_text())
    body = fixture['bodyPrefix']+fixture['bodyUnit']*fixture['repetitions']+fixture['bodySuffix']
    manifest,chunks=upload_parts(body)
    assert manifest==fixture['manifest']

    def stage(chunk,error=None):
        reply=query(f"set role service_role; select public.goalflow_stage_reconciliation_chunk_v1('{owner}',{literal(chunk)})",error)
        if reply: assert reply==dict(staged=True,manifest=chunk['manifest'],chunkIndex=chunk['chunkIndex'],chunkSha256=chunk['chunkSha256'])
        return reply

    def read(value=manifest,user=owner,error=None):
        return query(f"set role service_role; select public.goalflow_read_staged_reconciliation_v1('{user}',{literal(value)})",error)

    stage(chunks[2])
    read(error='incomplete')
    stage(chunks[0])
    stage(chunks[0])
    read(error='incomplete')
    for i,chunk in enumerate(chunks):
        if i not in (0,2): stage(chunk)
    assert read()==json.loads(body)
    read(user=other,error='another account')
    wrong=copy.deepcopy(chunks[0]);wrong['chunkSha256']='0'*64
    stage(wrong,error='manifest')

    # An inconsistent manifest cannot poison the valid content-addressed upload.
    broken=copy.deepcopy(manifest)
    changed=b'z'+base64.b64decode(chunks[0]['data'])[1:]
    broken['chunkHashes'][0]=hashlib.sha256(changed).hexdigest()
    for i,chunk in enumerate(chunks):
        altered={**chunk,'manifest':broken}
        if i==0: altered.update(data=base64.b64encode(changed).decode('ascii'),chunkSha256=broken['chunkHashes'][0])
        stage(altered)
    read(broken,error='complete hash differs')
    assert read()==json.loads(body)

    candidate=dict(conflictId='local:staged-fixture',sourceMutationId=None,entityType='settings',entityId='staged-fixture',
        localHistory=[dict(mutationId=str(uuid.uuid4()),version=i+1,payload={'notes':'🐸 '+str(i)},
            updatedAt='2026-09-07T12:00:00.123456789Z',deletedAt=None) for i in range(1001)])
    large_manifest,large_chunks=upload_parts(json.dumps(candidate,ensure_ascii=False,separators=(',',':')))
    for chunk in large_chunks: stage(chunk)
    restored=read(large_manifest)
    assert restored==candidate and len(restored['localHistory'])==1001
    statement=f"set role service_role; select public.reconcile_goalflow_sync_change('{owner}',{literal(restored)})"
    accepted=query(statement)
    assert accepted['reconciled'] is True and accepted['candidate']==candidate
    assert query(statement)==accepted
    assert accepted['record']['payload']['notes']=='🐸 1000'
    print(json.dumps({'status':'PASS','engine':'PostgreSQL','sharedManifest':'EXACT','missingChunk':'BLOCKED',
        'chunkReplay':'EXACT','poisonedManifest':'ISOLATED','crossAccount':'DENIED','historyEntries':1001,
        'reconciliationReceipt':'EXACT','fullHistoryRetained':True}))


if __name__=='__main__': main()
