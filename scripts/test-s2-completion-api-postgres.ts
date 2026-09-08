/** Real transaction and receipt checks in disposable local PostgreSQL only. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { completeCausalFocus } from '../server/causalCompletion';
import { readCausalHistoryChunk } from '../server/causalHistory';
import { assembleCausalHistoryEntry } from '../services/causalHistoryProtocol';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { CAUSAL_STORE, fenceLegacyTracking } from '../services/causalStorage';
import { bindCausalCapability } from '../services/causalEnrollment';
import { admitLocalCompletion, prepareCompletionRequest, syncLocalCompletion } from '../services/causalCompletionCoordinator';
import { emptySyncMeta } from '../services/syncProtocol';

if (!/^(goalflow_empty_|goalflow_upgrade_|s2_)/.test(process.env.PGDATABASE ?? '')) throw new Error('Disposable database required');
const literal = (value: unknown) => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
function query(sql: string): any {
  const result = execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15000 }).trim();
  return result ? JSON.parse(result) : null;
}
function run(sql: string, application: string) {
  const child = spawn('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: { ...process.env, PGAPPNAME: application } });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let out = '', err = '';
  child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
  const done = new Promise<any>((resolve, reject) => {
    child.on('error', reject); child.on('close', code => code ? reject(new Error(`Synthetic PostgreSQL child failed: ${err}`)) : resolve(JSON.parse(out.trim())));
  });
  void done.catch(() => undefined);
  return { child, done };
}
const owner = randomUUID(), other = randomUUID(), epoch = randomUUID(), taskId = randomUUID(), sessionId = randomUUID();
query(`insert into auth.users(id) values ('${owner}'),('${other}')`);
const push = (user: string, type: string, id: string, payload: unknown) => `select public.push_sync_mutation_v2('${user}','${randomUUID()}','fixture','${type}','${id}',null,1,${literal(payload)},'2026-09-08T00:00:00Z',null,null)`;
const task = { id: taskId, title: 'Synthetic complete', description: 'Original', scheduledFor: '2026-09-08', completed: false, lifecycleStatus: 'open' };
const taskOriginal = query(push(owner, 'tasks', taskId, task));
const statsOriginal = query(push(owner, 'stats', 'singleton', { '2026-09-08': { tasksCompleted: 0 } }));
const tracking = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3, focusSession: { schemaVersion: 1, sessionId, taskId, phase: 'active',
  plannedDurationSeconds: 600, startedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } };
const trackingOriginal = query(push(owner, 'tracking', 'singleton', tracking));
query(`set role service_role; select public.goalflow_causal_cutover_v2('${owner}',${literal({ schemaVersion: 2, accountId: owner, cutoverId: epoch, expectedTrackingServerVersion: trackingOriginal.serverVersion, expectedTrackingPayload: tracking })})`);
const finalNotes = '🧭'.repeat(20000);
const operation = { schemaVersion: 2, epoch, type: 'completion', command: { schemaVersion: 1, accountId: owner, actorId: 'fixture', actionId: randomUUID(), kind: 'complete',
  sessionId, taskId, epoch: sessionId, expectedRevision: sessionId, expectedCurrentSessionId: sessionId, capturedAt: '2026-09-08T00:05:00.000Z', durationSeconds: null },
  changes: [
    { mutationId: randomUUID(), deviceId: 'fixture', entityType: 'tasks', entityId: taskId, version: 2, baseServerVersion: taskOriginal.serverVersion,
      payload: { ...task, description: finalNotes, completed: true, lifecycleStatus: 'completed', completedAt: 1788825900000 }, updatedAt: '2026-09-08T00:05:00.000Z', deletedAt: null },
    { mutationId: randomUUID(), deviceId: 'fixture', entityType: 'stats', entityId: 'singleton', version: 2, baseServerVersion: statsOriginal.serverVersion,
      payload: { '2026-09-08': { tasksCompleted: 1 } }, updatedAt: '2026-09-08T00:05:00.000Z', deletedAt: null }
  ] };
const sql = `select public.goalflow_complete_focus_v2('${owner}',${literal(operation)})`;
const marker = `s2-completion-${randomUUID()}`;
const first = run(`begin; set role service_role; ${sql}; do $wait$ begin perform pg_sleep(1.5); end $wait$; commit;`, marker);
let sleeping = false;
for (let i = 0; i < 100; i++) {
  sleeping = query(`select to_json(exists(select 1 from pg_stat_activity where application_name='${marker}' and wait_event='PgSleep'))`);
  if (sleeping) break;
  if (first.child.exitCode !== null) throw new Error('Completion child ended before publication observation');
  await new Promise(resolve => setTimeout(resolve, 20));
}
assert.equal(sleeping, true);
assert.equal(query(`select payload->>'completed' from public.sync_records where user_id='${owner}' and entity_type='tasks' and entity_id='${taskId}'`), false);
assert.equal(query(`select to_json(payload->'focusSession'->>'phase') from public.sync_records where user_id='${owner}' and entity_type='tracking'`), 'active');
const duplicate = run(`set role service_role; ${sql}`, marker + '-retry');
const later = run(push(other, 'settings', 'singleton', { synthetic: true }), marker + '-later');
const [receipt, repeated, laterReceipt] = await Promise.all([first.done, duplicate.done, later.done]);
assert.deepEqual(repeated, receipt);
assert.ok(laterReceipt.serverVersion > receipt.record.server_version);
assert.equal(query(`select to_json(notes) from public.tasks where user_id='${owner}' and id='${taskId}'`), finalNotes);
const database = { rpc: async (name: string, args: any) => {
  assert.equal(args.target_user_id, owner);
  if (name === 'goalflow_complete_focus_v2') return { data: query(`set role service_role; ${sql}`), error: null };
  assert.equal(name, 'goalflow_causal_history_chunk_v2'); assert.equal(args.target_epoch, epoch);
  for (const n of [args.target_revision, args.through_revision, args.target_offset]) assert.ok(Number.isSafeInteger(n));
  return { data: query(`set role service_role; select public.goalflow_causal_history_chunk_v2('${owner}','${epoch}',${args.target_revision},${args.through_revision},${args.target_offset})`), error: null };
} } as unknown as SupabaseClient;
assert.deepEqual(await completeCausalFocus(database, owner, operation), receipt);
const position = { epoch, revision: 1, throughRevision: 1, offset: 0 };
const parts = []; let offset: number | null = 0;
while (offset !== null) { const chunk = await readCausalHistoryChunk(database, owner, { ...position, offset }); parts.push(chunk); offset = chunk.nextOffset; }
const restored = await assembleCausalHistoryEntry(owner, position, parts);
assert.deepEqual(restored.entry.receipt, receipt);

// Run the actual Web admission and receipt pipeline against PostgreSQL, then
// lose the first response after commit. A fresh connection retries the same
// durable bytes and verifies all six effects, including canonical final notes.
const webOwner = randomUUID(), webEpoch = randomUUID(), webTaskId = randomUUID(), webSession = randomUUID(), goalId = randomUUID(), habitId = randomUUID();
query(`insert into auth.users(id) values ('${webOwner}')`);
const webTask = { ...task, id: webTaskId, goalId, habitId, isFrog: true, duration: 10, dateAssigned: '2026-09-08' };
const webTracking = { ...tracking, focusSession: { ...tracking.focusSession, sessionId: webSession, taskId: webTaskId } };
const collections: Record<string, any> = {
  tasks: [webTask], goals: [{ id: goalId, title: 'Synthetic goal', completedTasks: 0 }],
  habits: [{ id: habitId, title: 'Synthetic habit', streak: 0, bestStreak: 0 }],
  stats: { '2026-09-08': { tasksCompleted: 0, frogsEaten: 0, timeFocused: 0, totalBreakMinutes: 0 } },
  progress: { level: 1, xp: 0, xpToNextLevel: 100 }, task_events: [], tracking: webTracking
};
const meta = emptySyncMeta(); let trackingVersion = 0;
for (const [type, value] of Object.entries(collections)) {
  if (type === 'task_events') continue;
  const payload = Array.isArray(value) ? value[0] : value, id = Array.isArray(value) ? payload.id : 'singleton';
  const result = query(push(webOwner, type, id, payload));
  assert.equal(result.accepted, true);
  meta.versions[`${type}:${id}`] = { local: 1, server: result.serverVersion };
  if (type === 'tracking') trackingVersion = result.serverVersion;
}
query(`set role service_role; select public.goalflow_causal_cutover_v2('${webOwner}',${literal({ schemaVersion: 2, accountId: webOwner, cutoverId: webEpoch,
  expectedTrackingServerVersion: trackingVersion, expectedTrackingPayload: webTracking })})`);
const localName = `s2-web-postgres-${randomUUID()}`;
const local = await openDB(localName, 1, { upgrade(db) { for (const store of [...Object.keys(collections), 'sync']) db.createObjectStore(store); } });
for (const [store, value] of Object.entries(collections)) await local.put(store, value, webOwner);
await local.put('sync', meta, webOwner); local.close();
(await fenceLegacyTracking(localName)).close();
await bindCausalCapability(localName, webOwner, { schemaVersion: 2, accountId: webOwner, enrolled: true, epoch: webEpoch, projectionRevision: 0, rolloutReady: false });
const action = randomUUID();
await admitLocalCompletion(localName, { focus: { schemaVersion: 1, accountId: webOwner, actionId: action, actorId: 'web-fixture', kind: 'complete', sessionId: webSession,
  taskId: webTaskId, epoch: webSession, expectedCurrentSessionId: webSession, capturedAt: '2026-09-08T00:05:00.000Z', durationSeconds: null },
  details: { day: '2026-09-08', timeZone: 'UTC', actualDuration: 5, flowState: 'flow', finalDescription: finalNotes }, deviceId: 'web-fixture' });
const saved = await prepareCompletionRequest(localName, webOwner, action);
let interrupted = false;
const webDatabase = { rpc: async (name: string, args: any) => {
  assert.equal(name, 'goalflow_complete_focus_v2'); assert.equal(args.target_user_id, webOwner);
  return { data: query(`set role service_role; select public.goalflow_complete_focus_v2('${webOwner}',${literal(args.operation)})`), error: null };
} } as unknown as SupabaseClient;
const authenticatedFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
  assert.equal(String(url), '/api/v1/sync/complete-focus'); assert.equal(String(init?.body) === saved, true);
  const accepted = await completeCausalFocus(webDatabase, webOwner, JSON.parse(saved));
  if (!interrupted) { interrupted = true; throw new Error('Synthetic response lost after server commit'); }
  return Response.json(accepted);
};
await assert.rejects(syncLocalCompletion(localName, webOwner, action, { authenticatedFetch }), /response lost/);
assert.equal((await syncLocalCompletion(localName, webOwner, action, { authenticatedFetch })).accepted, true);
const reopened = await openDB(localName), webState = await reopened.get(CAUSAL_STORE, webOwner);
assert.equal(webState.completionRequests[action] === saved, true);
assert.equal(webState.completionOutbox[action], undefined);
assert.equal(webState.completionReceipts[action].changes.length, 6);
assert.equal(Object.keys((await reopened.get('sync', webOwner)).localState.completionReservations).length, 0);
for (const member of JSON.parse(saved).changes) {
  const stored = query(`select payload from public.sync_records where user_id='${webOwner}' and entity_type='${member.entityType}' and entity_id='${member.entityId}'`);
  assert.deepEqual(stored, member.payload);
}
assert.equal(query(`select to_json(notes) from public.tasks where user_id='${webOwner}' and id='${webTaskId}'`) === finalNotes, true);
assert.equal(query(`select payload->'2026-09-08'->'tasksCompleted' from public.sync_records where user_id='${webOwner}' and entity_type='stats'`), 1);
assert.equal((await reopened.get('sync', webOwner)).cursor, meta.cursor); reopened.close();
console.log(JSON.stringify({ status: 'PASS', engine: 'PostgreSQL', atomicVisibility: 'PASS', concurrentDuplicate: 'EXACT', publicationOrder: 'PASS', canonicalFinalNotes: 'FULL',
  completionReceipt: 'EXACT', historyChunks: parts.length, webAdmission: 'SIX_ATOMIC_EFFECTS', responseLoss: 'EXACT_RETRY_NO_DOUBLE_AWARD', hostedPostgREST: 'NOT_MEASURED' }));
