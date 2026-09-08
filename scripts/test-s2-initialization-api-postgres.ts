/** Real database initialization receipts through the production API validators. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { initializeCausalAccount, admitCausalOperation } from '../server/causalActions';
import { replayCausalHistory } from '../services/causalProjection';
import { causalHistoryHash } from '../services/causalHistoryProtocol';
import { validateSavedCausalHistory, type SavedCausalHistory } from '../services/causalHistory';

if (!/^(goalflow_empty_|goalflow_upgrade_|s2_)/.test(process.env.PGDATABASE ?? '')) throw new Error('Disposable database required');
const literal = (value: unknown) => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
function query(sql: string): any {
  const output = execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: 15000 }).trim();
  return output ? JSON.parse(output) : null;
}
const database = { rpc: async (name: string, args: any) => {
  assert.ok(['goalflow_causal_initialize_v2', 'goalflow_admit_action_v2'].includes(name));
  return { data: query(`set role service_role; select public.${name}('${args.target_user_id}',${literal(args.operation)})`), error: null };
} } as unknown as SupabaseClient;
for (const legacy of [false, true]) {
  const owner = randomUUID(), initializationId = randomUUID(), session = randomUUID();
  query(`insert into auth.users(id) values ('${owner}')`);
  const initialTracking = { date: '2026-09-08', planViewCount: 0, dailyPostponeCount: 0, unknown: 'initial 🐸' };
  const existing = { ...initialTracking, planViewCount: 27, dailyPostponeCount: 3, unknown: 'server retained',
    focusSession: { schemaVersion: 1, sessionId: session, taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
      startedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } };
  if (legacy) query(`select public.push_sync_mutation_v2('${owner}','${randomUUID()}','fixture','tracking','singleton',null,1,${literal(existing)},'2026-09-08T00:00:00Z',null,null)`);
  const operation = { schemaVersion: 2, accountId: owner, initializationId, initialTracking };
  const receipt = await initializeCausalAccount(database, owner, operation);
  assert.equal(receipt.created, !legacy);
  assert.deepEqual(receipt.cutoverReceipt.record.payload, legacy ? existing : initialTracking);
  assert.deepEqual(await initializeCausalAccount(database, owner, operation), receipt);
  const action = await admitCausalOperation(database, owner, { schemaVersion: 2, epoch: initializationId, type: 'counter', command: {
    schemaVersion: 1, accountId: owner, actionId: randomUUID(), actorId: 'fixture', day: initialTracking.date, timeZone: 'UTC',
    counter: 'planViewCount', delta: 1, capturedAt: '2026-09-08T00:00:01.000Z', businessActionId: null, correctionOf: null } });
  const entries: SavedCausalHistory['entries'] = {};
  for (const [revision, entryReceipt] of [receipt.cutoverReceipt, action].entries()) {
    const body = JSON.stringify({ schemaVersion: 2, accountId: owner, epoch: initializationId, revision, receipt: entryReceipt });
    entries[String(revision)] = { body, sha256: await causalHistoryHash(new TextEncoder().encode(body)) };
  }
  const history: SavedCausalHistory = { schemaVersion: 1, epoch: initializationId, throughRevision: 1, downloadedRevision: 1, entries };
  await validateSavedCausalHistory(owner, history);
  const replayed = replayCausalHistory(owner, history);
  assert.equal(replayed.tracking.planViewCount, legacy ? 28 : 1);
  assert.equal(replayed.tracking.dailyPostponeCount, legacy ? 3 : 0);
  if (legacy) assert.deepEqual(replayed.tracking.focusSession, existing.focusSession);
  assert.deepEqual(await initializeCausalAccount(database, owner, operation), receipt);
}
console.log(JSON.stringify({ status: 'PASS', initializationAPI: 'EXACT', historyReplay: 'CONSERVED',
  cases: 2, legacyFocus: 'UNCHANGED', originalReceiptAfterAction: 'EXACT', hostedPostgREST: 'NOT_MEASURED' }));
