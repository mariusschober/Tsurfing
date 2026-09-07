#!/usr/bin/env python3
"""Counter-day admission against real, disposable PostgreSQL databases."""
import importlib.util
import json
import os
from pathlib import Path
import uuid

spec = importlib.util.spec_from_file_location('s2_ledger', Path(__file__).with_name('test-s2-action-ledger.py'))
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)
query, literal, push, locks = ledger.query, ledger.literal, ledger.push, ledger.locks


def main():
    if not os.environ.get('PGDATABASE', '').startswith(('goalflow_empty_', 'goalflow_upgrade_', 's2_')):
        raise SystemExit('Disposable fixture database required')
    owner, epoch = str(uuid.uuid4()), str(uuid.uuid4())
    query(f"insert into auth.users(id) values ('{owner}')")
    old = query(push(owner, str(uuid.uuid4()), dict(date='2026-09-10', planViewCount=8, dailyPostponeCount=2)))
    tracking = dict(date='2026-09-07', planViewCount=27, dailyPostponeCount=3, future='retained')
    initial = query(f"select public.push_sync_mutation_v2('{owner}','{uuid.uuid4()}','fixture','tracking','singleton',"
        f"{old['serverVersion']},2,{literal(tracking)},'2026-09-07T00:00:01.123456Z',null,null)")
    assert initial['accepted'] is True, 'Synthetic current-day baseline must be accepted before cutover'
    cutover = dict(schemaVersion=2, accountId=owner, cutoverId=epoch,
        expectedTrackingPayload=tracking, expectedTrackingServerVersion=initial['serverVersion'])
    query(f"select public.goalflow_causal_cutover_v2('{owner}',{literal(cutover)})", service=True)
    task_id = 'counter-day-focus'
    query(push(owner, str(uuid.uuid4()), dict(id=task_id, title='Synthetic focus', scheduledFor='2026-09-07'), kind='tasks', entity=task_id))
    action = str(uuid.uuid4())
    focus = dict(schemaVersion=1, actionId=action, accountId=owner, actorId='fixture', kind='start',
        sessionId=str(uuid.uuid4()), taskId=task_id, epoch=action, expectedRevision=None,
        expectedCurrentSessionId=None, capturedAt='2026-09-07T12:00:00.123Z', durationSeconds=600)

    def admit(command, kind='counter', error=None):
        operation = dict(schemaVersion=2, epoch=epoch, type=kind, command=command)
        return query(f"select public.goalflow_admit_action_v2('{owner}',{literal(operation)})", error, service=True)

    first_focus = admit(focus, 'focus')['record']['payload']['focusSession']

    def day_operation(day, kind='select', zone='Atlantic/Canary'):
        return dict(schemaVersion=2, epoch=epoch, type='counterDay', command=dict(schemaVersion=1,
            actionId=str(uuid.uuid4()), accountId=owner, actorId='fixture', kind=kind,
            day=day, timeZone=zone, capturedAt='2026-09-08T00:00:00.123Z'))

    def day(operation, error=None):
        result = query(f"select public.goalflow_counter_day_v2('{owner}',{literal(operation)})", error, service=True)
        if result:
            assert result['operation'] == operation
            assert result['record']['payload']['focusSession'] == first_focus
            assert result['record']['payload']['future'] == 'retained'
        return result

    def event(attributed_day, counter='planViewCount', action_id=None):
        return dict(schemaVersion=1, actionId=action_id or str(uuid.uuid4()), accountId=owner,
            actorId='fixture', day=attributed_day, timeZone='Atlantic/Canary', counter=counter, delta=1,
            capturedAt='2026-09-08T00:00:00.123Z', businessActionId=None, correctionOf=None)

    establish = day_operation('2026-09-08', 'establish')
    established = day(establish)
    assert day(establish) == established
    assert established['record']['payload']['date'] == '2026-09-07'
    assert established['counts'] == dict(planViewCount=0, dailyPostponeCount=0)
    again = day(day_operation('2026-09-08', 'establish', 'Pacific/Auckland'))
    assert again['baseline'] == established['baseline']
    selected = day(day_operation('2026-09-08'))
    assert selected['record']['payload']['planViewCount'] == 0
    assert admit(event('2026-09-08'))['record']['payload']['planViewCount'] == 1
    delayed = admit(event('2026-09-07', 'dailyPostponeCount'))
    assert delayed['outcome']['counts'] == dict(planViewCount=27, dailyPostponeCount=4)
    assert delayed['record']['payload']['date'] == '2026-09-08'
    assert delayed['record']['payload']['planViewCount'] == 1
    assert delayed['record']['payload']['dailyPostponeCount'] == 0
    revisited = day(day_operation('2026-09-07'))
    assert revisited['counts'] == dict(planViewCount=27, dailyPostponeCount=4)
    zone_changed = day(day_operation('2026-09-07', zone='America/New_York'))
    assert zone_changed['counts'] == revisited['counts']
    assert zone_changed['record']['server_version'] == revisited['record']['server_version']
    admit(event('2026-09-07', action_id=established['baseline']['baselineId']), error='historical evidence')
    mismatch = json.loads(json.dumps(establish))
    mismatch['command']['kind'] = 'select'
    day(mismatch, 'different request')
    for historical_day in ['2026-09-06', '2026-09-10']:
        day(day_operation(historical_day), 'explicit baseline review')
    rejected = query(push(owner, str(uuid.uuid4()), dict(date='2026-09-11', planViewCount=99, dailyPostponeCount=1)))
    assert rejected['accepted'] is False
    day(day_operation('2026-09-11'), 'explicit baseline review')
    forged = day_operation('2026-09-08')
    forged['command']['accountId'] = str(uuid.uuid4())
    day(forged, 'Invalid counter day')

    # Failure after baseline insertion cannot publish a new cursor or day.
    failed = day_operation('2026-09-09')
    snapshot_sql = f"""select jsonb_build_object(
        'state',(select to_jsonb(a) from goalflow_causal.accounts a where user_id='{owner}'),
        'days',(select count(*) from goalflow_causal.counter_days where user_id='{owner}'),
        'actions',(select count(*) from goalflow_causal.actions where user_id='{owner}'),
        'cursor',(select max(server_version) from public.sync_records))"""
    before = query(snapshot_sql)
    query("""create function public.s2_counter_day_fail() returns trigger language plpgsql as $$
      begin if new.payload->>'date'='2026-09-09' then raise exception 'synthetic day failure'; end if; return new; end $$;
      create trigger s2_counter_day_fail before update on public.sync_records for each row execute function public.s2_counter_day_fail()""")
    day(failed, 'synthetic day failure')
    assert query(snapshot_sql) == before
    query('drop trigger s2_counter_day_fail on public.sync_records; drop function public.s2_counter_day_fail()')
    retried = day(failed)
    assert retried['counts'] == dict(planViewCount=0, dailyPostponeCount=0)
    assert day(failed) == retried

    # Independent actors establish one immutable baseline under the same lock.
    first, second = day_operation('2026-09-12', 'establish'), day_operation('2026-09-12', 'establish')
    a, b = locks.Session('s2-day-a'), locks.Session('s2-day-b')
    try:
        a.query('set role service_role; begin')
        first_result = json.loads(a.query(f"select public.goalflow_counter_day_v2('{owner}',{literal(first)})")[0])
        b.query('set role service_role')
        b.send(f"select public.goalflow_counter_day_v2('{owner}',{literal(second)})")
        locks.wait_for_advisory('s2-day-b')
        a.query('commit')
        assert json.loads(b.read()[0])['baseline'] == first_result['baseline']
    finally:
        a.close()
        b.close()
    query(f"insert into public.sync_mutations(user_id,mutation_id,accepted) values ('{owner}','{uuid.uuid4()}',true)")
    day(day_operation('2026-09-13'), 'explicit baseline review')
    for role in ['anon', 'authenticated']:
        assert query(f"select to_jsonb(has_function_privilege('{role}','public.goalflow_counter_day_v2(uuid,jsonb)','execute'))") is False
    print(json.dumps(dict(status='PASS', engine='PostgreSQL', daySelection='FOCUS_PRESERVED',
        delayedEvents='ORIGINAL_DAY', timezoneChange='NO_RESET', historicalBaseline='REVIEW_REQUIRED',
        failedCommit='NO_CURSOR_ADVANCE', concurrentBaseline='ONE_IDENTITY', receiptReplay='EXACT')))


if __name__ == '__main__':
    main()
