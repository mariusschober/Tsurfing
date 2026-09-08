#!/usr/bin/env python3
"""Atomic initialization regressions in disposable PostgreSQL databases only."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import uuid

spec = importlib.util.spec_from_file_location('locks', Path(__file__).with_name('test-sync-lock-order.py'))
locks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(locks)

def literal(value):
    return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"

def query(sql, error=None, service=False):
    result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
        ('set role service_role; ' if service else '') + sql], text=True, capture_output=True, timeout=15)
    if error:
        assert result.returncode and error in result.stderr, result.stderr
        return
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout) if result.stdout.strip() else None

def fixture():
    owner = str(uuid.uuid4())
    query(f"insert into auth.users(id) values ('{owner}')")
    operation = dict(schemaVersion=2, accountId=owner, initializationId=str(uuid.uuid4()),
        initialTracking=dict(date='2026-09-08', planViewCount=0, dailyPostponeCount=0, future={'kept': '🐸'}))
    return owner, operation

def initialize(owner, operation):
    return f"select public.goalflow_causal_initialize_v2('{owner}',{literal(operation)})"

def push(owner, payload, mutation=None):
    return (f"select public.push_sync_mutation_v2('{owner}','{mutation or uuid.uuid4()}','fixture','tracking','singleton',"
        f"null,1,{literal(payload)},'2026-09-08T00:00:00.123Z',null,null)")

def main():
    if not os.environ.get('PGDATABASE', '').startswith(('goalflow_empty_', 'goalflow_upgrade_', 's2_')):
        raise SystemExit('Disposable database required')
    owner, operation = fixture()
    first = query(initialize(owner, operation), service=True)
    assert first['operation'] == operation and first['created'] is True
    assert first['cutoverReceipt']['record']['payload'] == operation['initialTracking']
    assert query(initialize(owner, operation), service=True) == first
    query(initialize(owner, {**operation, 'initializationId': str(uuid.uuid4())}), error='immutable causal enrollment', service=True)
    query(initialize(str(uuid.uuid4()), operation), error='Invalid causal initialization', service=True)
    for role in ['anon', 'authenticated']:
        query(f"set role {role}; " + initialize(owner, operation), error='permission denied')

    legacy_owner, legacy_operation = fixture()
    legacy_id = str(uuid.uuid4())
    legacy = {**legacy_operation['initialTracking'], 'planViewCount': 27, 'dailyPostponeCount': 3, 'serverOnly': 'preserved'}
    original = query(push(legacy_owner, legacy, legacy_id))
    joined = query(initialize(legacy_owner, legacy_operation), service=True)
    assert joined['created'] is False and joined['cutoverReceipt']['record']['payload'] == legacy
    assert joined['cutoverReceipt']['record']['server_version'] == original['serverVersion']
    assert query(push(legacy_owner, legacy, legacy_id)) == original

    missing, missing_operation = fixture()
    query(push(missing, legacy))
    query(f"delete from public.sync_records where user_id='{missing}'")
    query(initialize(missing, missing_operation), error='historical evidence', service=True)
    assert query(f"select count(*) from goalflow_causal.accounts where user_id='{missing}'") == 0

    rollback_owner, rollback_operation = fixture()
    query('begin; ' + initialize(rollback_owner, rollback_operation) + '; rollback', service=True)
    assert query(f"select count(*) from public.sync_records where user_id='{rollback_owner}'") == 0
    assert query(f"select count(*) from goalflow_causal.accounts where user_id='{rollback_owner}'") == 0
    for change in [{'planViewCount': 1}, {'focusSession': {}}, {'date': '2026-02-30'}]:
        invalid = {**rollback_operation, 'initialTracking': {**rollback_operation['initialTracking'], **change}}
        result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', initialize(rollback_owner, invalid)], capture_output=True)
        assert result.returncode != 0

    concurrent, concurrent_operation = fixture()
    other, _ = fixture()
    a, b, c = (locks.Session(name) for name in ['s2-init-first', 's2-init-retry', 's2-init-later'])
    try:
        accepted = json.loads(a.query('begin; set local role service_role; ' + initialize(concurrent, concurrent_operation))[0])
        b.send('set role service_role; ' + initialize(concurrent, concurrent_operation))
        locks.wait_for_advisory('s2-init-retry')
        c.send('begin; ' + push(other, legacy))
        locks.wait_for_advisory('s2-init-later')
        assert query(f"select count(*) from public.sync_records where user_id in ('{concurrent}','{other}')") == 0
        a.query('commit')
        assert json.loads(b.read()[0]) == accepted
        later = json.loads(c.read()[0])
        cursor = accepted['cutoverReceipt']['record']['server_version']
        assert later['serverVersion'] > cursor
        assert query(f"select count(*) from public.sync_records where user_id='{other}'") == 0
        c.query('commit')
        assert query(f"select count(*) from public.sync_records where user_id='{other}' and server_version>{cursor}") == 1
    finally:
        a.close(); b.close(); c.close()
    print(json.dumps({'status': 'PASS', 'initialization': 'ATOMIC', 'legacyBaseline': 'PRESERVED',
        'exactRetry': 'PASS', 'rollback': 'PASS', 'committedCursor': 'ORDERED', 'clientRPC': 'DENIED'}))

if __name__ == '__main__':
    main()
