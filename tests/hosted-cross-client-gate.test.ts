import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const browserConfig = readFileSync(new URL('../playwright.cross-client.config.ts', import.meta.url), 'utf8');
const browserJourney = readFileSync(new URL('./e2e/hosted-cross-client.spec.ts', import.meta.url), 'utf8');
const hostedAuth = readFileSync(new URL('./e2e/hosted-auth.ts', import.meta.url), 'utf8');
const androidTest = readFileSync(new URL(
  '../android-native/app/src/test/java/com/mariusschober/goalflow/nativeapp/sync/NativeSyncEngineTest.kt',
  import.meta.url
), 'utf8');
const macosTest = readFileSync(new URL('../macos-native/GoalflowMacTests/SyncTests.swift', import.meta.url), 'utf8');

describe('hosted cross-client release gate', () => {
  it('fails closed for release candidates and partial staging configuration', () => {
    expect(workflow).toContain('hosted-cross-client:');
    expect(workflow).toContain('main|develop|integration/*)');
    expect(workflow).toContain('Cross-client staging configuration is partial');
    expect(workflow).toContain('Hosted cross-client proof is mandatory for $CANDIDATE_REF.');
    expect(workflow).toContain('needs: [hosted-staging, native-android, macos]');
    expect(workflow).toContain('hosted-cross-client=${{ needs.hosted-cross-client.result }}');
    expect(workflow).toContain('hosted-cross-client failed: ${{ needs.hosted-cross-client.result }}');
  });

  it('hands one durable browser record through Android, macOS, and browser verification', () => {
    const seed = workflow.indexOf('Seed one durable task through the hosted browser');
    const android = workflow.indexOf('Pull and edit the browser task through production Android sync');
    const verifyAndroid = workflow.indexOf('Verify the Android edit through the hosted browser');
    const macos = workflow.indexOf('Pull and edit the Android task through production macOS sync');
    const verifyMacos = workflow.indexOf('Verify the macOS edit through the hosted browser');
    expect(seed).toBeGreaterThan(0);
    expect(android).toBeGreaterThan(seed);
    expect(verifyAndroid).toBeGreaterThan(android);
    expect(macos).toBeGreaterThan(verifyAndroid);
    expect(verifyMacos).toBeGreaterThan(macos);
    expect(androidTest).toContain('NativeSyncEngine(');
    expect(androidTest).toContain('hostedBrowserRecordConvergesThroughProductionTransport');
    expect(macosTest).toContain('URLSessionSyncTransport(');
    expect(macosTest).toContain('testProductionTransportEditsAndroidRecord');
    expect(macosTest).toContain('XCTAssertGreaterThan(afterServerVersion, beforeServerVersion)');
    expect(macosTest).toContain('GOALFLOW_CROSS_CLIENT_MACOS_PROOF_FILE');
    expect(macosTest).toContain('/tmp/tsurfing-hosted-cross-client-macos.json');
    expect(workflow).toContain('/tmp/tsurfing-hosted-cross-client-macos.json');
    expect(workflow).toContain('{ encoding: "utf8", mode: 0o600, flag: "wx" }');
    expect(workflow).toContain('trap \'rm -f "$GOALFLOW_CROSS_CLIENT_MACOS_CONFIG_FILE"\' EXIT');
    expect(workflow).toContain('test -s "$GOALFLOW_CROSS_CLIENT_MACOS_PROOF_FILE"');
    expect(workflow).toContain('proof.afterServerVersion > proof.beforeServerVersion');
    expect(browserJourney).toContain("phase === 'verify-android'");
    expect(browserJourney).toContain("phase === 'verify-macos'");
  });

  it('isolates credentials and always attempts exact fixture cleanup', () => {
    expect(browserConfig).toContain("trace: 'off'");
    expect(browserConfig).toContain("screenshot: 'off'");
    expect(browserConfig).toContain("video: 'off'");
    expect(browserConfig).toContain("reporter: 'list'");
    expect(browserJourney).toContain(".replace(/Bearer\\s+\\S+/gi, 'Bearer <redacted>')");
    expect(browserJourney).toContain('installHostedTestSession');
    expect(browserJourney).not.toContain("getByLabel('Password')");
    expect(hostedAuth).toContain('persistSession: false');
    expect(hostedAuth).toContain('window.localStorage.setItem(key, value)');
    expect(browserJourney).toContain("getByRole('dialog', { name: 'Decision Fatigue Warning', exact: true })");
    expect(browserJourney).toContain("getByRole('button', { name: 'Close dialog', exact: true })");
    expect(browserJourney).toContain('writeState(seeded)');
    expect(browserJourney).toContain('cardById(userB.page, seeded.taskId)');
    expect(workflow).toContain("if: always() && steps.preflight.outputs.run == 'true' && steps.seed.outcome != 'skipped'");
    expect(workflow).toContain('GOALFLOW_CROSS_CLIENT_PHASE: cleanup');
    expect(browserJourney).toContain("getByTitle('Delete')");
    expect(browserJourney).toContain('unlinkSync(stateFile)');
    expect(workflow).not.toContain('GOALFLOW_STAGING_SUPABASE_SECRET_KEY');
  });
});
