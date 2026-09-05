import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

type JsonRecord = Record<string, unknown>;

const requiredEnvironment = [
  'GOALFLOW_STAGING_APP_ORIGIN',
  'GOALFLOW_STAGING_SUPABASE_URL',
  'GOALFLOW_STAGING_SUPABASE_PUBLISHABLE_KEY',
  'GOALFLOW_STAGING_USER_A_EMAIL',
  'GOALFLOW_STAGING_USER_A_PASSWORD',
  'GOALFLOW_STAGING_USER_A_ID',
  'GOALFLOW_STAGING_USER_B_EMAIL',
  'GOALFLOW_STAGING_USER_B_PASSWORD',
  'GOALFLOW_STAGING_USER_B_ID',
  'GOALFLOW_EXPECTED_RELEASE_SHA'
] as const;

const getEnvironment = (name: typeof requiredEnvironment[number]): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required hosted staging setting: ${name}`);
  return value;
};

if (process.env.GOALFLOW_HOSTED_TEST_CONFIRM !== 'staging') {
  throw new Error('Hosted tests require GOALFLOW_HOSTED_TEST_CONFIRM=staging.');
}

const environment = Object.fromEntries(requiredEnvironment.map(name => [name, getEnvironment(name)])) as
  Record<typeof requiredEnvironment[number], string>;
const appOrigin = environment.GOALFLOW_STAGING_APP_ORIGIN.replace(/\/$/, '');
const supabaseUrl = environment.GOALFLOW_STAGING_SUPABASE_URL.replace(/\/$/, '');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const releaseShaPattern = /^[0-9a-f]{40}$/i;
const expectedReleaseSha = environment.GOALFLOW_EXPECTED_RELEASE_SHA.toLowerCase();

for (const [label, raw] of [['application', appOrigin], ['Supabase', supabaseUrl]] as const) {
  const url = new URL(raw);
  assert.equal(url.protocol, 'https:', `${label} staging origin must use HTTPS`);
  assert.notEqual(url.hostname, 'localhost', `${label} staging origin must not be local`);
}
assert.notEqual(appOrigin, supabaseUrl, 'Application and Supabase origins must be distinct');
assert.match(environment.GOALFLOW_STAGING_USER_A_ID, uuidPattern, 'User A expected ID is invalid');
assert.match(environment.GOALFLOW_STAGING_USER_B_ID, uuidPattern, 'User B expected ID is invalid');
assert.notEqual(environment.GOALFLOW_STAGING_USER_A_ID, environment.GOALFLOW_STAGING_USER_B_ID,
  'Hosted identities must be distinct');
assert.match(expectedReleaseSha, releaseShaPattern, 'Expected hosted release SHA is invalid');

const asRecord = (value: unknown, message: string): JsonRecord => {
  assert(value && typeof value === 'object' && !Array.isArray(value), message);
  return value as JsonRecord;
};

const requestDurations: number[] = [];
interface HostedResponse {
  status: number;
  body: unknown;
  requestId: string | null;
  releaseSha: string | null;
}

const request = async (
  path: string,
  accessToken?: string,
  init: RequestInit = {}
): Promise<HostedResponse> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const startedAt = performance.now();
  try {
    const response = await fetch(`${appOrigin}${path}`, { ...init, headers, signal: controller.signal });
    requestDurations.push(performance.now() - startedAt);
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch { throw new Error(`Hosted endpoint returned non-JSON content at ${path}`); }
    }
    return {
      status: response.status,
      body,
      requestId: response.headers.get('x-request-id'),
      releaseSha: response.headers.get('x-tsurfing-revision')?.toLowerCase() ?? null
    };
  } finally {
    clearTimeout(timeout);
  }
};

const expectStatus = <T extends number>(
  response: HostedResponse,
  status: T,
  label: string
) => {
  assert.equal(response.status, status, `${label} returned HTTP ${response.status}`);
  return response;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const waitForExactDeployment = async (): Promise<void> => {
  const deadline = Date.now() + 8 * 60_000;
  let lastObservation = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await request('/api/v1/health/ready');
      lastObservation = `HTTP ${response.status}, revision ${response.releaseSha ?? 'missing'}`;
      if (response.status === 200 && response.releaseSha === expectedReleaseSha) return;
    } catch (error) {
      lastObservation = error instanceof Error ? error.name : 'request failure';
    }
    await delay(5_000);
  }
  throw new Error(
    `Staging did not serve exact release ${expectedReleaseSha} within eight minutes; last observation: ${lastObservation}`
  );
};

const client = (): SupabaseClient => createClient(
  supabaseUrl,
  environment.GOALFLOW_STAGING_SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);

const signIn = async (
  database: SupabaseClient,
  email: string,
  password: string,
  expectedUserId: string
): Promise<Session> => {
  const { data, error } = await database.auth.signInWithPassword({ email, password });
  assert.ifError(error);
  assert(data.session, 'Supabase did not return a session');
  assert.equal(data.session.user.id, expectedUserId, 'Staging credential resolved to an unexpected identity');
  return data.session;
};

const verifyServerSession = async (token: string, expectedUserId: string) => {
  const response = expectStatus(await request('/api/v1/session', token), 200, 'Session validation');
  const body = asRecord(response.body, 'Session response is not an object');
  const user = asRecord(body.user, 'Session response has no user');
  assert.equal(user.id, expectedUserId, 'Server session crossed an account boundary');
  assert.equal(user.role, 'beta', 'Hosted test identities must use the beta role');
  assert.equal(user.status, 'active', 'Hosted test identity is not active');
};

interface Mutation {
  mutationId: string;
  deviceId: string;
  entityType: 'tasks';
  entityId: string;
  baseServerVersion: number | null;
  version: number;
  payload: JsonRecord;
  updatedAt: string;
  deletedAt: string | null;
}

const push = async (token: string, mutation: Mutation): Promise<JsonRecord> => {
  const response = expectStatus(await request('/api/v1/sync/push', token, {
    method: 'POST', body: JSON.stringify({ mutations: [mutation] })
  }), 200, 'Synchronization push');
  const body = asRecord(response.body, 'Push response is not an object');
  assert(Array.isArray(body.results) && body.results.length === 1, 'Push response has no exact receipt');
  return asRecord(body.results[0], 'Push receipt is not an object');
};

const pull = async (token: string, cursor: number): Promise<{ records: JsonRecord[]; nextCursor: number }> => {
  const response = expectStatus(await request(`/api/v1/sync/pull?cursor=${cursor}&limit=200`, token), 200,
    'Synchronization pull');
  const body = asRecord(response.body, 'Pull response is not an object');
  assert(Array.isArray(body.records), 'Pull response has no records');
  assert(Number.isSafeInteger(body.nextCursor), 'Pull response has no safe cursor');
  return { records: body.records.map(value => asRecord(value, 'Pull record is invalid')), nextCursor: Number(body.nextCursor) };
};

const currentCursor = async (token: string, expectedUserId: string): Promise<number> => {
  const response = expectStatus(await request('/api/v1/sync/status', token), 200, 'Synchronization status');
  const body = asRecord(response.body, 'Synchronization status is not an object');
  assert.equal(body.userId, expectedUserId, 'Synchronization status crossed an account boundary');
  assert(Number.isSafeInteger(body.serverVersion), 'Synchronization status has no safe cursor');
  return Number(body.serverVersion);
};

const serverVersion = (receipt: JsonRecord): number => {
  assert.equal(receipt.accepted, true, 'Mutation was not durably accepted');
  assert(Number.isSafeInteger(receipt.serverVersion), 'Receipt has no safe server version');
  return Number(receipt.serverVersion);
};

const taskPayload = (id: string, title: string, allegedOwnerId: string): JsonRecord => ({
  id,
  title,
  description: 'Hosted staging isolation fixture',
  hashtags: ['hosted-beta-gate'],
  schedulePrecision: 'day',
  scheduledFor: '2099-01-06',
  dateAssigned: '2099-01-06',
  plannedOrder: 0,
  completed: false,
  lifecycleStatus: 'open',
  isFrog: false,
  beforeFrog: false,
  source: 'manual',
  duration: 15,
  userId: allegedOwnerId
});

const findRecord = (records: JsonRecord[], entityId: string): JsonRecord | undefined =>
  records.find(record => record.entityId === entityId);

const expectSafeFailure = (
  response: HostedResponse,
  label: string
) => {
  assert(response.status >= 400, `${label} unexpectedly succeeded`);
  const body = asRecord(response.body, `${label} did not return a public error object`);
  const error = asRecord(body.error, `${label} did not return a public error`);
  assert.equal(typeof error.code, 'string', `${label} has no public error code`);
  assert.equal(typeof error.message, 'string', `${label} has no public error message`);
  assert.equal(typeof error.requestId, 'string', `${label} has no request ID`);
  assert.equal(error.requestId, response.requestId, `${label} request ID is inconsistent`);
};

const run = async () => {
  await waitForExactDeployment();
  const live = expectStatus(await request('/api/v1/health/live'), 200, 'Liveness');
  const ready = expectStatus(await request('/api/v1/health/ready'), 200, 'Readiness');
  assert.equal(live.releaseSha, expectedReleaseSha, 'Liveness came from a different release');
  assert.equal(ready.releaseSha, expectedReleaseSha, 'Readiness came from a different release');

  const databaseA = client();
  const databaseASecond = client();
  const databaseB = client();
  let sessionA = await signIn(
    databaseA,
    environment.GOALFLOW_STAGING_USER_A_EMAIL,
    environment.GOALFLOW_STAGING_USER_A_PASSWORD,
    environment.GOALFLOW_STAGING_USER_A_ID
  );
  let sessionB = await signIn(
    databaseB,
    environment.GOALFLOW_STAGING_USER_B_EMAIL,
    environment.GOALFLOW_STAGING_USER_B_PASSWORD,
    environment.GOALFLOW_STAGING_USER_B_ID
  );

  await verifyServerSession(sessionA.access_token, sessionA.user.id);
  await verifyServerSession(sessionB.access_token, sessionB.user.id);

  const refreshed = await databaseA.auth.refreshSession();
  assert.ifError(refreshed.error);
  assert(refreshed.data.session, 'User A refresh did not return a session');
  assert.equal(refreshed.data.session.user.id, sessionA.user.id, 'Refresh changed the durable account identity');
  sessionA = refreshed.data.session;
  const sessionASecond = await signIn(
    databaseASecond,
    environment.GOALFLOW_STAGING_USER_A_EMAIL,
    environment.GOALFLOW_STAGING_USER_A_PASSWORD,
    environment.GOALFLOW_STAGING_USER_A_ID
  );
  await verifyServerSession(sessionASecond.access_token, sessionASecond.user.id);

  const accountExport = expectStatus(await request('/api/v1/account/export', sessionA.access_token), 200,
    'Account export');
  const exportBody = asRecord(accountExport.body, 'Account export is not an object');
  assert.equal(exportBody.schemaVersion, 3, 'Account export schema version is unexpected');
  const collections = asRecord(exportBody.collections, 'Account export has no collections');
  for (const [collection, rows] of Object.entries(collections)) {
    assert(Array.isArray(rows), `Account export collection ${collection} is not an array`);
    for (const value of rows) {
      const row = asRecord(value, `Account export collection ${collection} contains a non-object row`);
      for (const ownerColumn of ['user_id', 'auth_user_id', 'created_by'] as const) {
        if (typeof row[ownerColumn] === 'string') {
          assert.equal(row[ownerColumn], sessionA.user.id,
            `Account export collection ${collection} crossed an account boundary`);
        }
      }
    }
  }
  const deletion = await request('/api/v1/account', sessionA.access_token, { method: 'DELETE' });
  assert.equal(deletion.status, 409, 'Transactional account deletion unexpectedly became active');
  expectSafeFailure(deletion, 'Disabled account deletion');
  assert.equal(asRecord(asRecord(deletion.body, 'Deletion response is invalid').error,
    'Deletion response has no error').code, 'account_deletion_disabled');

  const ownDataRead = await databaseA.from('sync_records').select('entity_id').limit(1);
  assert(ownDataRead.error, 'Direct client Data API access bypassed the Tsurfing protocol');
  const directRpc = await databaseB.rpc('push_sync_mutation_v2', {
    target_user_id: sessionA.user.id,
    target_mutation_id: randomUUID(),
    target_device_id: 'hosted-direct-attack',
    target_entity_type: 'tasks',
    target_entity_id: randomUUID(),
    target_base_server_version: null,
    target_version: 1,
    target_payload: {},
    target_updated_at: new Date().toISOString(),
    target_deleted_at: null,
    target_resolves_conflict_id: null
  });
  assert(directRpc.error, 'Authenticated client invoked a service-only synchronization RPC');

  const initialCursorA = await currentCursor(sessionA.access_token, sessionA.user.id);
  const initialCursorB = await currentCursor(sessionB.access_token, sessionB.user.id);
  const taskA = randomUUID();
  const taskB = randomUUID();
  const now = new Date().toISOString();
  const createA: Mutation = {
    mutationId: randomUUID(),
    deviceId: 'hosted-browser-a',
    entityType: 'tasks',
    entityId: taskA,
    baseServerVersion: null,
    version: 1,
    payload: taskPayload(taskA, 'Hosted user A task', sessionB.user.id),
    updatedAt: now,
    deletedAt: null
  };

  // Treat the first response as lost at the client boundary, then replay the
  // exact operation ID and require the same durable receipt.
  const firstA = await push(sessionA.access_token, createA);
  const retriedA = await push(sessionA.access_token, createA);
  assert.deepEqual(retriedA, firstA, 'Retry after an unconsumed acknowledgment changed the receipt');
  const createAServerVersion = serverVersion(firstA);

  const afterCreateA = await pull(sessionA.access_token, initialCursorA);
  const aRecord = findRecord(afterCreateA.records, taskA);
  assert(aRecord, 'User A could not read its accepted mutation');
  assert.equal(asRecord(aRecord.payload, 'User A task payload is invalid').userId, sessionB.user.id,
    'Hosted fixture did not exercise a forged payload owner field');
  const bAfterA = await pull(sessionB.access_token, initialCursorB);
  assert.equal(findRecord(bAfterA.records, taskA), undefined, 'User B read user A data');

  const crossAccountAttack: Mutation = {
    ...createA,
    mutationId: randomUUID(),
    deviceId: 'hosted-browser-b-attack',
    payload: taskPayload(taskA, 'Cross-account overwrite', sessionB.user.id)
  };
  const attackResponse = await request('/api/v1/sync/push', sessionB.access_token, {
    method: 'POST', body: JSON.stringify({ mutations: [crossAccountAttack] })
  });
  expectSafeFailure(attackResponse, 'Cross-account durable-ID attack');
  const aAfterAttack = await pull(sessionA.access_token, createAServerVersion - 1);
  assert.equal(asRecord(findRecord(aAfterAttack.records, taskA)?.payload, 'User A record vanished after attack').title,
    'Hosted user A task', 'Cross-account attack changed user A data');

  const createB: Mutation = {
    mutationId: randomUUID(),
    deviceId: 'hosted-browser-b',
    entityType: 'tasks',
    entityId: taskB,
    baseServerVersion: null,
    version: 1,
    payload: taskPayload(taskB, 'Hosted user B task', sessionB.user.id),
    updatedAt: new Date().toISOString(),
    deletedAt: null
  };
  const createBReceipt = await push(sessionB.access_token, createB);
  const createBServerVersion = serverVersion(createBReceipt);
  const bOwnRecords = await pull(sessionB.access_token, initialCursorB);
  assert(findRecord(bOwnRecords.records, taskB), 'User B could not read its accepted mutation');
  const aCannotReadB = await pull(sessionA.access_token, initialCursorA);
  assert.equal(findRecord(aCannotReadB.records, taskB), undefined, 'User A read user B data');

  const editA: Mutation = {
    ...createA,
    mutationId: randomUUID(),
    deviceId: 'hosted-browser-a-second-client',
    baseServerVersion: createAServerVersion,
    version: 2,
    payload: taskPayload(taskA, 'Hosted user A converged edit', sessionA.user.id),
    updatedAt: new Date().toISOString()
  };
  const editAReceipt = await push(sessionASecond.access_token, editA);
  const editAServerVersion = serverVersion(editAReceipt);
  const converged = await pull(sessionA.access_token, createAServerVersion);
  assert.equal(asRecord(findRecord(converged.records, taskA)?.payload, 'Edited task did not converge').title,
    'Hosted user A converged edit');

  const staleA: Mutation = {
    ...editA,
    mutationId: randomUUID(),
    deviceId: 'hosted-browser-a-stale-client',
    baseServerVersion: createAServerVersion,
    version: 3,
    payload: taskPayload(taskA, 'Preserved stale side', sessionA.user.id),
    updatedAt: new Date().toISOString()
  };
  const conflictReceipt = await push(sessionA.access_token, staleA);
  assert.equal(conflictReceipt.accepted, false, 'Stale mutation silently overwrote newer state');
  assert.match(String(conflictReceipt.conflictId), uuidPattern, 'Stale mutation produced no durable conflict');
  const conflictId = String(conflictReceipt.conflictId);
  const conflictsResponse = expectStatus(await request('/api/v1/sync/conflicts', sessionA.access_token), 200,
    'Conflict listing');
  const conflicts = asRecord(conflictsResponse.body, 'Conflict list is invalid').conflicts;
  assert(Array.isArray(conflicts) && conflicts.some(value => asRecord(value, 'Conflict row is invalid').id === conflictId),
    'Durable conflict is not visible to its owner');
  const resolution = expectStatus(await request('/api/v1/sync/conflicts/resolve', sessionA.access_token, {
    method: 'POST',
    body: JSON.stringify({ conflictId, mutationId: staleA.mutationId, choice: 'cloud' })
  }), 200, 'Cloud conflict resolution');
  assert.deepEqual(resolution.body, { resolved: true, conflictId, mutationId: staleA.mutationId },
    'Conflict resolution did not acknowledge the exact row');

  const deleteA: Mutation = {
    ...editA,
    mutationId: randomUUID(),
    deviceId: 'hosted-browser-a',
    baseServerVersion: editAServerVersion,
    version: 3,
    updatedAt: new Date().toISOString(),
    deletedAt: new Date().toISOString()
  };
  const deleteAReceipt = await push(sessionA.access_token, deleteA);
  const deleteAServerVersion = serverVersion(deleteAReceipt);
  assert.deepEqual(await push(sessionA.access_token, deleteA), deleteAReceipt,
    'Duplicate tombstone delivery changed its receipt');
  const tombstoneA = findRecord((await pull(sessionA.access_token, editAServerVersion)).records, taskA);
  assert.equal(tombstoneA?.serverVersion, deleteAServerVersion, 'Tombstone cursor did not converge');
  assert.equal(tombstoneA?.deletedAt, deleteA.deletedAt, 'Tombstone timestamp did not propagate exactly');

  const deleteB: Mutation = {
    ...createB,
    mutationId: randomUUID(),
    baseServerVersion: createBServerVersion,
    version: 2,
    updatedAt: new Date().toISOString(),
    deletedAt: new Date().toISOString()
  };
  serverVersion(await push(sessionB.access_token, deleteB));

  const malformed = await request('/api/v1/session', 'not-a-valid-session');
  assert.equal(malformed.status, 401, 'Malformed bearer token was accepted');
  expectSafeFailure(malformed, 'Malformed bearer token');

  const revokedToken = sessionB.access_token;
  const signedOut = await databaseB.auth.signOut({ scope: 'global' });
  assert.ifError(signedOut.error);
  const revoked = await request('/api/v1/session', revokedToken);
  assert.equal(revoked.status, 401, 'Remote logout left a cached access token usable');
  expectSafeFailure(revoked, 'Revoked bearer token');
  sessionB = await signIn(
    databaseB,
    environment.GOALFLOW_STAGING_USER_B_EMAIL,
    environment.GOALFLOW_STAGING_USER_B_PASSWORD,
    environment.GOALFLOW_STAGING_USER_B_ID
  );
  await verifyServerSession(sessionB.access_token, sessionB.user.id);

  const cleanupResults = await Promise.all([
    databaseA.auth.signOut({ scope: 'local' }),
    databaseASecond.auth.signOut({ scope: 'local' }),
    databaseB.auth.signOut({ scope: 'local' })
  ]);
  for (const result of cleanupResults) assert.ifError(result.error);

  const maximumRequestMs = Math.ceil(Math.max(...requestDurations));
  assert(maximumRequestMs < 5_000, `Hosted API exceeded the beta latency ceiling (${maximumRequestMs}ms)`);
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    environment: 'staging',
    userA: sessionA.user.id,
    userB: sessionB.user.id,
    isolation: 'PASS',
    directClientBypass: 'DENIED',
    refresh: 'PASS',
    secondAuthenticatedSession: 'PASS',
    accountExportIsolation: 'PASS',
    accountDeletion: 'SAFELY_DISABLED',
    remoteLogout: 'PASS',
    duplicateDelivery: 'IDEMPOTENT',
    conflict: 'PRESERVED_AND_RESOLVED',
    tombstone: 'PROPAGATED',
    maximumRequestMs
  })}\n`);
};

await run();
