#!/usr/bin/env python3
"""Real PostgreSQL action/cutover regression. Disposable databases only."""
import json
import importlib.util
import os
from pathlib import Path
import subprocess
import uuid

spec = importlib.util.spec_from_file_location('s2_lock_test', Path(__file__).with_name('test-sync-lock-order.py'))
locks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(locks)


def literal(value):
    return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"


def query(statement, expected_error=None, service=False):
    result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
        ('set role service_role; ' if service else '') + statement], capture_output=True, text=True, timeout=15)
    if expected_error:
        assert result.returncode and expected_error in result.stderr, result.stderr
        return None
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout) if result.stdout.strip() else None


def push(owner, action, payload, base='null', kind='tracking', entity='singleton'):
    return (f"select public.push_sync_mutation_v2('{owner}','{action}','fixture','{kind}','{entity}',"
            f"{base},1,{literal(payload)},'2026-09-07T00:00:00.123456Z',null,null)")


def main():
    if not os.environ.get('PGDATABASE', '').startswith(('goalflow_empty_', 'goalflow_upgrade_', 's2_')):
        raise SystemExit('Disposable fixture database required')
    owner, epoch, legacy = (str(uuid.uuid4()) for _ in range(3))
    query(f"insert into auth.users(id) values ('{owner}')")
    tracking = dict(date='2026-09-07', planViewCount=27, dailyPostponeCount=3, future={'preserved': '🐸'})
    original_receipt = query(push(owner, legacy, tracking))
    cutover = dict(schemaVersion=2, accountId=owner, cutoverId=epoch,
        expectedTrackingPayload=tracking, expectedTrackingServerVersion=original_receipt['serverVersion'])
    cutover_sql = f"select public.goalflow_causal_cutover_v2('{owner}',{literal(cutover)})"
    first = query(cutover_sql, service=True)
    assert query(cutover_sql, service=True) == first
    assert first['operation'] == cutover and first['baseline']['counts'] == dict(planViewCount=27,dailyPostponeCount=3)
    event = dict(schemaVersion=1, actionId=str(uuid.uuid4()), accountId=owner, actorId='fixture',
        day='2026-09-07', timeZone='Atlantic/Canary', counter='planViewCount', delta=1,
        capturedAt='2026-09-07T12:00:00.123Z', businessActionId=None, correctionOf=None)

    def operation(command, kind='counter'):
        return dict(schemaVersion=2,epoch=epoch,type=kind,command=command)

    def admit(command, kind='counter', error=None):
        submitted = operation(command,kind)
        result = query(f"select public.goalflow_admit_action_v2('{owner}',{literal(submitted)})",error,service=True)
        if result: assert result['operation'] == submitted
        return result

    expected = dict(planViewCount=27,dailyPostponeCount=3)
    for counter in ['planViewCount','dailyPostponeCount'] * 2:
        event = {**event,'actionId':str(uuid.uuid4()),'counter':counter}
        receipt = admit(event)
        expected[counter] += 1
        assert receipt['outcome']['counts'] == expected
        assert receipt['record']['payload']['future'] == tracking['future']
        assert admit(event) == receipt, 'Retry changed immutable receipt'
        admit({**event,'actorId':'different'},error='different request')
    assert expected == dict(planViewCount=29,dailyPostponeCount=5)
    admit({**event,'actionId':legacy},error='historical evidence')
    admit({**event,'actionId':str(uuid.uuid4()),'accountId':str(uuid.uuid4())},error='Invalid causal action')
    admit({**event,'actionId':str(uuid.uuid4()),'timeZone':'Invalid/Zone'},error='IANA zone')
    rejected_id = str(uuid.uuid4())
    rejected = query(push(owner,rejected_id,tracking,receipt['record']['server_version']))
    assert rejected['accepted'] is False
    assert query(push(owner,rejected_id,tracking,receipt['record']['server_version'])) == rejected
    assert query(push(owner,legacy,tracking)) == original_receipt, 'Legacy acceptance was reinterpreted'
    stored = query(f"select payload from public.sync_records where user_id='{owner}' and entity_type='tracking'")
    assert stored['planViewCount']==29 and stored['dailyPostponeCount']==5

    # Equal wall times remain distinct causal actions and extension deltas.
    task_id = 'fixture-task'
    query(push(owner,str(uuid.uuid4()),{'id':task_id,'title':'Synthetic','scheduledFor':'2026-09-07'},kind='tasks',entity=task_id))
    action = str(uuid.uuid4())
    focus = dict(schemaVersion=1, actionId=action, accountId=owner, actorId='fixture',kind='start',
        sessionId=str(uuid.uuid4()), taskId=task_id, epoch=action, expectedRevision=None,
        expectedCurrentSessionId=None,capturedAt='2026-09-07T12:00:00.123Z',durationSeconds=600)
    receipt = admit(focus,'focus')
    assert receipt['accepted'] is True
    for seconds in [300,120]:
        focus={**focus,'actionId':str(uuid.uuid4()),'kind':'extend','expectedRevision':receipt['outcome']['revision'],
            'expectedCurrentSessionId':focus['sessionId'],'durationSeconds':seconds}
        receipt=admit(focus,'focus')
        assert admit(focus,'focus')==receipt
    assert receipt['record']['payload']['focusSession']['plannedDurationSeconds']==1020
    assert receipt['record']['payload']['planViewCount']==29

    # A full transaction rollback leaves neither action receipt nor projection.
    rolled={**event,'actionId':str(uuid.uuid4())}
    before=query(f"select to_jsonb(a) from goalflow_causal.accounts a where user_id='{owner}'")
    query(f"begin; select public.goalflow_admit_action_v2('{owner}',{literal(operation(rolled))}); rollback", service=True)
    assert query(f"select to_jsonb(a) from goalflow_causal.accounts a where user_id='{owner}'")==before
    assert query(f"select to_jsonb(count(*)) from goalflow_causal.actions where action_id='{rolled['actionId']}'")==0
    assert admit(rolled)['outcome']['counts'][rolled['counter']]==6

    # Two concurrent submissions of one action must return the same receipt.
    concurrent = {**event,'actionId':str(uuid.uuid4())}
    statement = f"select public.goalflow_admit_action_v2('{owner}',{literal(operation(concurrent))})"
    a, b = locks.Session('s2-action-a'), locks.Session('s2-action-b')
    try:
        a.query('set role service_role; begin')
        accepted = json.loads(a.query(statement)[0])
        b.query('set role service_role')
        b.send(statement)
        locks.wait_for_advisory('s2-action-b')
        a.query('commit')
        assert json.loads(b.read()[0]) == accepted
    finally:
        a.close()
        b.close()

    # Action publication participates in the existing global commit-order lock.
    other = str(uuid.uuid4())
    query(f"insert into auth.users(id) values ('{other}')")
    concurrent = {**event,'actionId':str(uuid.uuid4())}
    statement = f"select public.goalflow_admit_action_v2('{owner}',{literal(operation(concurrent))})"
    a, b = locks.Session('s2-action-publisher'), locks.Session('s2-legacy-publisher')
    try:
        a.query('set role service_role; begin')
        accepted = json.loads(a.query(statement)[0])
        b.send(push(other,str(uuid.uuid4()),{},kind='settings',entity='cursor-fixture'))
        locks.wait_for_advisory('s2-legacy-publisher')
        # Neither uncommitted action publication nor the waiting legacy row is visible.
        visible = query(f"select to_jsonb(max(server_version)) from public.sync_records where user_id='{owner}'")
        assert visible < accepted['record']['server_version']
        assert query(f"select to_jsonb(count(*)) from public.sync_records where user_id='{other}'") == 0
        a.query('commit')
        later = json.loads(b.read()[0])
        assert later['serverVersion'] > accepted['record']['server_version']
    finally:
        a.close()
        b.close()
    for role in ['anon','authenticated']:
        for signature in ['goalflow_causal_cutover_v2(uuid,jsonb)','goalflow_admit_action_v2(uuid,jsonb)']:
            assert query(f"select to_jsonb(has_function_privilege('{role}','public.{signature}','execute'))") is False
        assert query(f"select to_jsonb(has_schema_privilege('{role}','goalflow_causal','usage'))") is False
    print(json.dumps({'status':'PASS','engine':'PostgreSQL','counters':'29/5 plus rollback retry',
        'focusExtension':420,'receiptReplay':'EXACT','legacyOverwrite':'REJECTED','rollback':'ATOMIC',
        'concurrentDuplicate':'EXACT','committedCursor':'ORDERED','clientAccess':'DENIED'}))


if __name__ == '__main__':
    main()
