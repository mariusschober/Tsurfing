import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const schemaDir = 'android-native/app/schemas/com.mariusschober.goalflow.nativeapp.data.GoalflowDatabase';
const manifestPath = path.join(schemaDir, 'ROOM_SCHEMA_SHA256_MANIFEST.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

let ok = true;
// A hash-only loop can report PASS while a newly added schema is unpinned.
const schemaFiles = readdirSync(schemaDir).filter(file => file.endsWith('.json') && file !== 'ROOM_SCHEMA_SHA256_MANIFEST.json').sort();
const declaredFiles = Object.keys(manifest).sort();
if (JSON.stringify(schemaFiles) !== JSON.stringify(declaredFiles)) {
  console.error(`ROOM_SCHEMA_MANIFEST_MISMATCH: declared ${JSON.stringify(declaredFiles)}, present ${JSON.stringify(schemaFiles)}`);
  ok = false;
}
for (const [file, expected] of Object.entries(manifest)) {
  const content = readFileSync(path.join(schemaDir, file));
  const hash = createHash('sha256').update(content).digest('hex');
  if (hash !== expected) {
    console.error(`ROOM_SCHEMA_HASH_MISMATCH ${file}: expected ${expected} got ${hash}`);
    ok = false;
  } else {
    console.log(`ROOM_SCHEMA_HASH_OK ${file} ${hash}`);
  }
  // Also check identityHash inside JSON matches known value (freeze modification/removal)
  const json = JSON.parse(content.toString('utf8'));
  const identity = json.database?.identityHash;
  if (!identity) {
    console.error(`ROOM_SCHEMA_MISSING_IDENTITY ${file}`);
    ok = false;
  }
}
if (!ok) {
  console.error('Room schema hash verification FAILED — do not modify or remove schema JSON files. Use forward migrations.');
  process.exit(1);
}
console.log(JSON.stringify({ status: 'PASS', checked: Object.keys(manifest).length }));
