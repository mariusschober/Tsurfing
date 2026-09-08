import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const clientRoot = path.resolve('dist/client');
const miniRoot = path.resolve('dist/mini');

const requireFile = async (relativePath, minimumBytes = 1) => {
  const target = path.join(clientRoot, relativePath);
  const metadata = await stat(target);
  if (!metadata.isFile() || metadata.size < minimumBytes) {
    throw new Error(`${relativePath} must be a file of at least ${minimumBytes} bytes.`);
  }
  return target;
};

const manifestPath = await requireFile('manifest.webmanifest');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const exactFields = {
  name: 'Tsurfing',
  short_name: 'Tsurfing',
  display: 'standalone',
  start_url: '/',
  scope: '/'
};
for (const [field, expected] of Object.entries(exactFields)) {
  if (manifest[field] !== expected) {
    throw new Error(`manifest.webmanifest ${field} must be ${JSON.stringify(expected)}; received ${JSON.stringify(manifest[field])}.`);
  }
}

if (!Array.isArray(manifest.icons)) throw new Error('manifest.webmanifest icons must be an array.');
for (const [src, sizes] of [['/icons/icon-192.png', '192x192'], ['/icons/icon-512.png', '512x512']]) {
  const declared = manifest.icons.find(icon => icon?.src === src && icon?.sizes === sizes && icon?.type === 'image/png');
  if (!declared) throw new Error(`manifest.webmanifest must declare ${src} as ${sizes} image/png.`);
  await requireFile(src.replace(/^\//, ''), 100);
}

await requireFile('index.html', 100);
await requireFile('sw.js', 100);
const miniIndex = path.join(miniRoot, 'index.html');
const miniIndexMetadata = await stat(miniIndex);
if (!miniIndexMetadata.isFile() || miniIndexMetadata.size < 100) {
  throw new Error('Telegram Mini App index.html must be a built file of at least 100 bytes.');
}
const miniIndexContents = await readFile(miniIndex, 'utf8');
if (!miniIndexContents.includes('https://telegram.org/js/telegram-web-app.js')) {
  throw new Error('Telegram Mini App must load the official Telegram Web App bridge.');
}

const javascriptFiles = [];
const miniJavascriptFiles = [];
const collectJavascript = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectJavascript(target);
    else if (entry.name.endsWith('.js')) {
      javascriptFiles.push(target);
      if (target.startsWith(`${miniRoot}${path.sep}`)) miniJavascriptFiles.push(target);
    }
  }
};
await collectJavascript(clientRoot);
await collectJavascript(miniRoot);

const javascript = (await Promise.all(javascriptFiles.map(file => readFile(file, 'utf8')))).join('\n');
// Reject semantic test-access artifacts. A bare numeric OTP is not a safe
// marker: Supabase's production client contains the standard digit alphabet
// `0123456789`, which necessarily includes common six-digit substrings.
for (const forbidden of ['__storageService', '__STORES', 'goalflow-test-access', 'Tsurfing Test']) {
  if (javascript.includes(forbidden)) {
    throw new Error(`Production client bundle contains forbidden test-only marker ${forbidden}.`);
  }
}

const miniJavascript = (await Promise.all(miniJavascriptFiles.map(file => readFile(file, 'utf8')))).join('\n');
for (const forbidden of [
  'goalflow.telegram-mini.session',
  'Bearer ',
  'tokenType',
  'initData=',
  '/session?'
]) {
  if (miniJavascript.includes(forbidden)) {
    throw new Error(`Telegram Mini App bundle contains retired credential transport ${forbidden}.`);
  }
}
for (const required of ['/events', 'text/event-stream', 'same-origin']) {
  if (!miniJavascript.includes(required)) {
    throw new Error(`Telegram Mini App bundle is missing secure wake transport marker ${required}.`);
  }
}

console.log(JSON.stringify({
  status: 'PASS',
  manifest: exactFields,
  requiredIcons: 2,
  telegramMiniApp: 'secure-cookie-and-wake-relay',
  javascriptFiles: javascriptFiles.length,
  testBackdoors: 'absent'
}));
