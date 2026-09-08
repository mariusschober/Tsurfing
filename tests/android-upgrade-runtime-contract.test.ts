import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const upgrade = readFileSync(
  new URL('../android-native/scripts/test-upgrade-matrix.sh', import.meta.url),
  'utf8'
);
const verifier = readFileSync(
  new URL('../android-native/scripts/verify-instrumentation-target.sh', import.meta.url),
  'utf8'
);
const apkRunner = readFileSync(
  new URL('../android-native/scripts/run-instrumentation-apk.sh', import.meta.url),
  'utf8'
);
const launchVerifier = readFileSync(
  new URL('../android-native/scripts/verify-installed-app-launch.sh', import.meta.url),
  'utf8'
);
const apkDiagnostic = readFileSync(
  new URL('../android-native/scripts/diagnose-apk.sh', import.meta.url),
  'utf8'
);
const emulatorGate = readFileSync(
  new URL('../android-native/scripts/run-emulator-gate.sh', import.meta.url),
  'utf8'
);
const workflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8'
);

describe('installed Android upgrade instrumentation contract', () => {
  it('uses Package Manager runtime metadata instead of optional aapt badging output', () => {
    expect(upgrade).toContain('shell pm list instrumentation "$old_package"');
    expect(upgrade).toContain('verify-instrumentation-target.sh');
    expect(upgrade).not.toContain("targetPackage='");
    expect(verifier).toContain('listing" != "$expected');
  });

  it('executes the fail-closed target regression before emulator work', () => {
    expect(workflow).toContain('Run installed instrumentation target regression test');
    expect(workflow).toContain('sh android-native/scripts/test-instrumentation-target.sh');
  });

  it('runs the compiled instrumentation APK directly with an exact test count', () => {
    expect(apkRunner).toContain('shell am instrument -w');
    expect(apkRunner).toContain('OK ($expected_count tests)');
    expect(apkRunner).toContain('verify-instrumentation-target.sh');
    expect(emulatorGate).toContain(
      'run-instrumentation-apk.sh" "$current_apk" "$current_test_apk" 7'
    );
    expect(emulatorGate).not.toContain('connectedProductionDebugAndroidTest');
    expect(workflow).toContain('Run instrumentation APK runner regression test');
  });

  it('models process death between the preserved seed and cold-launch upgrade', () => {
    const uninstallSeed = upgrade.indexOf('uninstall "$test_package"');
    const launchPreserved = upgrade.indexOf('"$old_package" com.mariusschober.goalflow.nativeapp.MainActivity UPGRADE_PRESERVED_LAUNCH', uninstallSeed);
    const stopBeforeUpgrade = upgrade.indexOf('shell am force-stop "$old_package"', launchPreserved);
    const installUpgrade = upgrade.indexOf('install -r "$new_apk"', stopBeforeUpgrade);
    const launchCurrent = upgrade.indexOf('"$new_package" com.mariusschober.goalflow.nativeapp.MainActivity UPGRADE_CURRENT_LAUNCH', installUpgrade);

    expect(uninstallSeed).toBeGreaterThan(-1);
    expect(launchPreserved).toBeGreaterThan(uninstallSeed);
    expect(stopBeforeUpgrade).toBeGreaterThan(launchPreserved);
    expect(installUpgrade).toBeGreaterThan(stopBeforeUpgrade);
    expect(launchCurrent).toBeGreaterThan(installUpgrade);
  });

  it('repackages only the historical schema fixture under the undistributed Tsurfing package', () => {
    expect(workflow).toContain('Build preserved v2 schema upgrade fixture under Tsurfing package (TEST-ONLY)');
    expect(workflow).toContain('applicationId "com.mariusschober.tsurfing"');
    expect(upgrade).toContain('no Goalflow package was distributed');
  });

  it('requires a live resumed process and visible Tsurfing semantics for every APK launch', () => {
    expect(launchVerifier).toContain('shell am force-stop "$package_name"');
    expect(launchVerifier).toContain('shell pidof "$package_name"');
    expect(launchVerifier).toContain('shell dumpsys activity activities');
    expect(launchVerifier).toContain('shell uiautomator dump "$remote_ui"');
    expect(launchVerifier).toContain('package=\\"$package_name\\"');
    expect(launchVerifier).toContain("text=\"Current\"");
    expect(launchVerifier).toContain('${result_label}_UI=PASS');
    expect(upgrade).toContain('verify-installed-app-launch.sh');
    expect(apkDiagnostic).toContain('verify-installed-app-launch.sh');
    expect(workflow).toContain('Run installed app launch regression test');
    expect(workflow).toContain('Upload native launch diagnostics on failure');
  });
});
