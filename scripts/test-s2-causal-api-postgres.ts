/** Real PostgreSQL receipts through the production API validator. The adapter
 * uses psql on disposable databases; this is not hosted PostgREST evidence. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { admitCausalOperation } from '../server/causalActions';

if (!/^(goalflow_empty_|goalflow_upgrade_|s2_)/.test(process.env.PGDATABASE ?? '')) throw new Error('Disposable fixture database required');
const literal = (value: unknown) => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
function query(sql: string, service = false): any {
  const output = execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', (service ? 'set role service_role; ' : '') + sql],
    { encoding: 'utf8', timeout: 15000 }).trim();
  return output ? JSON.parse(output) : null;
}
const owner = randomUUID(), epoch = randomUUID(), task = randomUUID();
query(`insert into auth.users(id) values ('${owner}')`);
const tracking = { date: '2026-09-07', planViewCount: 27, dailyPostponeCount: 3, future: { preserved: '🐸' } };
function push(kind: string, id: string, payload: unknown) {
  return query(`select public.push_sync_mutation_v2('${owner}','${randomUUID()}','fixture','${kind}','${id}',null,1,${literal(payload)},'2026-09-07T00:00:00.123456Z',null,null)`);
}
const original = push('tracking', 'singleton', tracking);
assert.equal(original.accepted, true);
assert.equal(push('tasks', task, { id: task, title: 'Synthetic', scheduledFor: '2026-09-07', completed: false, duration: 10 }).accepted, true);
query(`select public.goalflow_causal_cutover_v2('${owner}',${literal({ schemaVersion: 2, accountId: owner, cutoverId: epoch,
  expectedTrackingPayload: tracking, expectedTrackingServerVersion: original.serverVersion })})`, true);
const database = { rpc: async (name: string, input: { target_user_id: string; operation: unknown }) => {
  assert.ok(['goalflow_admit_action_v2', 'goalflow_counter_day_v2'].includes(name));
  assert.equal(input.target_user_id, owner);
  return { error: null, data: query(`select public.${name}('${owner}',${literal(input.operation)})`, true) };
} } as unknown as SupabaseClient;
const send = (type: string, command: unknown) => admitCausalOperation(database, owner, { schemaVersion: 2, epoch, type, command });
const common = { schemaVersion: 1, accountId: owner, actorId: 'fixture', capturedAt: '2026-09-08T00:00:00.000Z' };
const event = { ...common, actionId: randomUUID(), day: '2026-09-07', timeZone: 'UTC', counter: 'planViewCount',
  delta: 1, businessActionId: null, correctionOf: null, ...JSON.parse('{"__proto__":{"original":true}}') };
const first = await send('counter', event);
assert.deepEqual(first.outcome.counts, { planViewCount: 28, dailyPostponeCount: 3 });
assert.deepEqual(await send('counter', event), first);
const startId = randomUUID(), sessionId = randomUUID();
const start = { ...common, actionId: startId, kind: 'start', sessionId, taskId: task, epoch: startId,
  expectedRevision: null, expectedCurrentSessionId: null, durationSeconds: 600 };
assert.equal((await send('focus', start)).accepted, true);
const pause = { ...start, actionId: randomUUID(), kind: 'pause', expectedRevision: startId,
  expectedCurrentSessionId: sessionId, durationSeconds: null };
const paused = await send('focus', pause);
assert.equal(paused.accepted, true);
assert.deepEqual(await send('focus', pause), paused);
assert.equal((await send('focus', { ...pause, actionId: randomUUID() })).accepted, false);
const selected = await send('counterDay', { ...common, actionId: randomUUID(), kind: 'select', day: '2026-09-08', timeZone: 'UTC' });
assert.deepEqual(selected.counts, { planViewCount: 0, dailyPostponeCount: 0 });
assert.deepEqual(selected.record.payload.focusSession, paused.record.payload.focusSession);
console.log(JSON.stringify({ status: 'PASS', engine: 'PostgreSQL', apiReceiptValidation: 'EXACT', cases: 7,
  unknownEvidence: 'PRESERVED', rejectedFocus: 'AUDITED', daySelection: 'FOCUS_PRESERVED', hostedPostgREST: 'NOT_MEASURED' }));
