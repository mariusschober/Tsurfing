#!/usr/bin/env python3
"""Shared protocol fixtures executed by real PostgreSQL, never a SQL simulator."""
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
PSQL = [shutil.which('psql') or 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']


def literal(value):
    return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"


def query(statement, error=None):
    result = subprocess.run(PSQL + ['-c', statement], capture_output=True, text=True, timeout=15, check=False)
    if error:
        assert result.returncode != 0 and error in result.stderr, 'Expected protocol rejection: ' + error
        return None
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


if __name__ == '__main__':
    if not os.environ.get('PGDATABASE', '').startswith(('goalflow_empty_', 'goalflow_upgrade_', 's2_')):
        raise SystemExit('Set PGDATABASE to a disposable migration fixture database')
    counters = json.loads((ROOT / 'tests/fixtures/s2/counters-v1.json').read_text())
    for case in counters['cases']:
        for events in [case['events'], list(reversed(case['events']))]:
            projection = query('select public.goalflow_project_counters_v1(' + literal(counters['baseline']) + ',' + literal(events) + ')', case.get('error'))
            if 'expected' in case:
                assert projection == case['expected'], case['name']
    focus = json.loads((ROOT / 'tests/fixtures/s2/focus-v1.json').read_text())
    for case in focus['cases']:
        state = query("select public.goalflow_initial_focus_journal_v1('" + focus['accountId'] + "')")
        for command, code in zip(case['commands'], case['outcomeCodes'], strict=True):
            reply = query('select public.goalflow_apply_focus_v1(' + literal(state) + ',' + literal(command) + ')')
            assert reply['outcome']['code'] == code, case['name']
            state = reply['journal']
        projection = state['sessions'][state['currentSessionId']]['projection']
        assert all(projection[k] == v for k, v in case['expected'].items()), case['name']
        assert len(state['operations']) == len({command['actionId'] for command in case['commands']})
        if case['name'] == 'completed-F-never-revives-after-G':
            assert state['sessions']['ffffffff-ffff-4fff-8fff-ffffffffffff']['projection']['phase'] == 'completed'
    for signature in ['goalflow_project_counters_v1(jsonb,jsonb)', 'goalflow_initial_focus_journal_v1(text,jsonb)', 'goalflow_apply_focus_v1(jsonb,jsonb)']:
        for role in ['anon', 'authenticated']:
            assert query(f"select to_jsonb(has_function_privilege('{role}','public.{signature}','execute'))") is False
    print(json.dumps({'status': 'PASS', 'engine': 'PostgreSQL', 'counterScenarios': len(counters['cases']),
        'counterOrdersPerScenario': 2, 'focusScenarios': len(focus['cases']), 'directClientExecution': 'DENIED'}))
