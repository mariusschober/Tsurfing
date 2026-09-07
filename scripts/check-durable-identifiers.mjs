import { readFileSync, readdirSync } from 'node:fs';

const frozen = JSON.parse(readFileSync('config/durable-identifiers.json', 'utf8'));

const stripComments = source => {
  let output = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') { lineComment = false; output += character; }
      else output += ' ';
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; output += '  '; index += 1; }
      else output += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      output += character;
      if (character === '\\') {
        output += next ?? '';
        index += 1;
      } else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      output += character;
    } else if (character === '/' && next === '/') {
      lineComment = true;
      output += '  ';
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      output += '  ';
      index += 1;
    } else output += character;
  }
  return output;
};

const sources = new Map();
const source = file => {
  if (!sources.has(file)) sources.set(file, stripComments(readFileSync(file, 'utf8')));
  return sources.get(file);
};

const failures = [];
let checked = 0;

const assertExtracted = (label, file, pattern, expected) => {
  checked += 1;
  const actual = source(file).match(pattern)?.[1];
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)} in ${file}`);
  else console.log(`IDENTIFIER_OK ${label}`);
};

const assertAllExtracted = (label, file, pattern, expected) => {
  checked += 1;
  const actual = [...source(file).matchAll(pattern)].map(match => match[1]);
  if (!actual.length || actual.some(value => value !== expected)) {
    failures.push(`${label}: every declaration must equal ${JSON.stringify(expected)}, received ${JSON.stringify(actual)} in ${file}`);
  } else console.log(`IDENTIFIER_OK ${label}`);
};

assertExtracted('Capacitor application ID', 'capacitor.config.ts', /\bappId\s*:\s*'([^']+)'/, frozen.android.capacitorApplicationId);
assertExtracted('Legacy Android namespace', 'android/app/build.gradle', /^\s*namespace\s+"([^"]+)"/m, frozen.android.legacyNamespace);
assertExtracted('Legacy Android application ID', 'android/app/build.gradle', /^\s*applicationId\s+"([^"]+)"/m, frozen.android.capacitorApplicationId);
assertExtracted('Native Android namespace', 'android-native/app/build.gradle', /^\s*namespace\s+"([^"]+)"/m, frozen.android.nativeNamespace);
assertExtracted('Native Android application ID', 'android-native/app/build.gradle', /^\s*applicationId\s+"([^"]+)"/m, frozen.android.nativeApplicationId);

assertExtracted('Web causal authority store', 'services/causalStorage.ts', /^export const CAUSAL_STORE = '([^']+)';/m, frozen.web.causalStore);
assertExtracted('Web tracking key path', 'services/causalStorage.ts', /^export const TRACKING_KEY_PATH = '([^']+)';/m, frozen.web.trackingKeyPath);
assertExtracted('Web database name', 'services/storage.ts', /^const BASE_DB_NAME = '([^']+)';/m, frozen.web.databaseName);
assertExtracted('Active web database key', 'services/storage.ts', /^const ACTIVE_DB_KEY = '([^']+)';/m, frozen.web.activeDatabaseKey);
assertExtracted('Web WAL prefix', 'services/storage.ts', /^const WAL_PREFIX = '([^']+)';/m, frozen.web.walPrefix);
assertExtracted('Web device ID key', 'services/storage.ts', /^\s*const key = '([^']+)';\s*$/m, frozen.web.deviceIdKey);

const databaseFile = 'android-native/app/src/main/java/com/mariusschober/goalflow/nativeapp/data/GoalflowDatabase.kt';
assertExtracted('Native database name', databaseFile, /GoalflowDatabase::class\.java,\s*"([^"]+)"/, frozen.android.nativeDatabaseName);
assertExtracted('Native URL scheme', 'android-native/app/src/main/AndroidManifest.xml', /android:scheme="([^"]+)"/, frozen.android.urlScheme);
assertExtracted('Native auth redirect URI', 'android-native/app/src/main/java/com/mariusschober/goalflow/nativeapp/sync/NativeConfig.kt', /const val authRedirectUri:\s*String\s*=\s*"([^"]+)"/, frozen.android.authRedirectUri);

const secureSessionFile = 'android-native/app/src/main/java/com/mariusschober/goalflow/nativeapp/sync/SecureSessionStore.kt';
assertExtracted('Secure-session preferences name', secureSessionFile, /getSharedPreferences\("([^"]+)"/, frozen.android.securePreferences);
assertExtracted('Android Keystore alias', secureSessionFile, /const val KEY_ALIAS\s*=\s*"([^"]+)"/, frozen.android.keystoreAlias);

assertExtracted('Encrypted backup legacy magic', 'server/backups.ts', /LEGACY_MAGIC\s*=\s*Buffer\.from\('([^']+)'\)/, frozen.backup.magic);
assertExtracted('Encrypted backup current magic', 'server/backups.ts', /DERIVED_KEY_MAGIC\s*=\s*Buffer\.from\('([^']+)'\)/, frozen.backup.currentMagic);
assertAllExtracted('Backup storage bucket', 'server/backups.ts', /\.storage\.from\('([^']+)'\)/g, frozen.backup.storageBucket);
assertExtracted('Encrypted backup suffix', 'server/backups.ts', /const objectPath\s*=\s*`[^`]*(\.[a-z-]+\.enc)`/, frozen.backup.encryptedSuffix);

const assertFileSet = (label, directory, extension, expected) => {
  checked += 1;
  const actual = readdirSync(directory).filter(name => expected.includes(name) || (name.endsWith(extension) && !name.endsWith('_MANIFEST.json'))).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    failures.push(`${label}: expected ${JSON.stringify(wanted)}, received ${JSON.stringify(actual)}`);
  } else console.log(`IDENTIFIER_OK ${label}`);
};

assertFileSet('Postgres migration filenames', 'supabase/migrations', '.sql', frozen.postgresMigrationFiles);
assertFileSet(
  'Room schema filenames',
  'android-native/app/schemas/com.mariusschober.goalflow.nativeapp.data.GoalflowDatabase',
  '.json',
  frozen.roomSchemaFiles
);

if (failures.length) {
  for (const failure of failures) console.error(`IDENTIFIER_MISMATCH ${failure}`);
  console.error('Durable identifier check FAILED. Do not change identifiers or historical migration/schema filenames during canonicalization or rename preparation.');
  process.exit(1);
}

console.log(JSON.stringify({ status: 'PASS', manifestVersion: frozen.version, checked }));
