#!/usr/bin/env python3
"""Real concurrent PostgreSQL regressions; use only a disposable fixture database.

PGDATABASE/PGHOST/PGPORT select the database prepared by the migration matrix.
No database is dropped here. Synthetic account-scoped receipts remain for audit.
"""
import json
import os
import shutil
import subprocess
import time
import uuid

PSQL = [shutil.which('psql') or 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']


def sql(query):
    result = subprocess.run(PSQL + ['-c', query], text=True, capture_output=True, timeout=15, check=False)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


class Session:
    def __init__(self, name):
        self.process = subprocess.Popen(PSQL, env={**os.environ, 'PGAPPNAME': name},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.query("set statement_timeout='10s'; set deadlock_timeout='250ms'")

    def send(self, query):
        self.process.stdin.write(query + "; select 'S2_END';\n")
        self.process.stdin.flush()

    def read(self):
        rows = []
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise AssertionError(self.process.stderr.read())
            if line.strip() == 'S2_END':
                return rows
            if line.strip():
                rows.append(line.strip())

    def query(self, query):
        self.send(query)
        return self.read()

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(timeout=15)


def wait_for_advisory(name):
    deadline = time.monotonic() + 8
    while sql(f"select count(*) from pg_stat_activity where application_name='{name}' and wait_event='advisory'") != '1':
        if time.monotonic() > deadline:
            raise AssertionError('Expected transaction did not reach advisory-lock wait')
        time.sleep(.02)


def push(owner, mutation, entity, base='null', version=1, conflict='null'):
    return (f"select public.push_sync_mutation_v2('{owner}','{mutation}','fixture','settings','{entity}',"
            f"{base},{version},'{{}}','2026-09-07T00:00:00.123456Z',null,{conflict})")


def conflict_lock_order():
    owner = str(uuid.uuid4())
    source = str(uuid.uuid4())
    original = str(uuid.uuid4())
    sql(f"insert into auth.users(id) values ('{owner}')")
    base = json.loads(sql(push(owner, original, 'lock-test')))
    conflict = json.loads(sql(push(owner, source, 'lock-test', version=2)))
    candidate = json.dumps(dict(conflictId=conflict['conflictId'], sourceMutationId=source,
        entityType='settings', entityId='lock-test', localHistory=[]))
    a = Session('s2-reconcile')
    b = Session('s2-explicit')
    try:
        a.query(f"begin; select pg_advisory_xact_lock(hashtextextended('{owner}:settings:lock-test',0))")
        b.send(push(owner, str(uuid.uuid4()), 'lock-test', base=base['serverVersion'], version=3,
            conflict="'" + conflict['conflictId'] + "'"))
        wait_for_advisory('s2-explicit')
        a.query(f"select public.reconcile_goalflow_sync_change('{owner}','{candidate}'::jsonb); commit")
        # Reconciliation won. The racing explicit request must be rejected as
        # stale, with no deadlock, replacement receipt or implicit acceptance.
        try:
            b.read()
            raise AssertionError('Already-resolved conflict was accepted')
        except AssertionError as error:
            assert '22023' in str(error) and '40P01' not in str(error), str(error)
        retained = json.loads(sql(f"select result from public.sync_mutations where user_id='{owner}' and mutation_id='{original}'"))
        assert retained == base, 'Original accepted receipt changed'
    finally:
        a.close()
        b.close()


def committed_cursor_order():
    owner = str(uuid.uuid4())
    sql(f"insert into auth.users(id) values ('{owner}')")
    a = Session('s2-cursor-first')
    b = Session('s2-cursor-second')
    try:
        first_id, second_id = str(uuid.uuid4()), str(uuid.uuid4())
        first = json.loads(a.query('begin; ' + push(owner, first_id, 'first'))[0])
        b.send('begin; ' + push(owner, second_id, 'second'))
        wait_for_advisory('s2-cursor-second')
        assert sql(f"select count(*) from public.sync_records where user_id='{owner}'") == '0'
        a.query('commit')
        second = json.loads(b.read()[0])
        assert second['serverVersion'] > first['serverVersion']
        cursor = int(sql(f"select max(server_version) from public.sync_records where user_id='{owner}'"))
        assert cursor == first['serverVersion'], 'Uncommitted change escaped to pull'
        b.query('commit')
        assert sql(f"select entity_id from public.sync_records where user_id='{owner}' and server_version>{cursor}") == 'second', 'Pull skipped later commit'
        # A sequence gap on rollback is allowed; neither a record nor receipt
        # may be visible, and the authoritative pull cursor must not advance.
        rollback_id = str(uuid.uuid4())
        a.query('begin; ' + push(owner, rollback_id, 'rolled-back'))
        a.query('rollback')
        assert int(sql(f"select max(server_version) from public.sync_records where user_id='{owner}'")) == second['serverVersion']
        assert sql(f"select count(*) from public.sync_mutations where user_id='{owner}' and mutation_id='{rollback_id}'") == '0'
    finally:
        a.close()
        b.close()


if __name__ == '__main__':
    if not os.environ.get('PGDATABASE', '').startswith(('goalflow_empty_', 'goalflow_upgrade_', 's2_')):
        raise SystemExit('Set PGDATABASE to a disposable migration fixture database')
    conflict_lock_order()
    committed_cursor_order()
    print(json.dumps({'status': 'PASS', 'engine': 'PostgreSQL', 'conflictLockOrder': 'PASS',
        'originalReceipt': 'UNCHANGED', 'committedCursorOrder': 'PASS', 'rollbackCursor': 'UNCHANGED'}))
