import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const roots = [path.resolve('dist/client'), path.resolve('dist/mini')];
const forbiddenNames = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'BACKUP_MASTER_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'TURNSTILE_SECRET_KEY'
];

export const legacySupabaseRole = value => {
  const segments = value.split('.');
  if (segments.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return typeof payload?.role === 'string' ? payload.role : undefined;
  } catch {
    return undefined;
  }
};

export const scanClientContent = (content, file, forbiddenValues = []) => {
  const findings = [];
  for (const name of forbiddenNames) if (content.includes(name)) findings.push(`${file}: ${name}`);
  for (const value of forbiddenValues) if (content.includes(value)) findings.push(`${file}: configured secret value`);
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(content)) findings.push(`${file}: Supabase secret-key-shaped value`);
  const jwtCandidates = content.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g) ?? [];
  if (jwtCandidates.some(candidate => legacySupabaseRole(candidate) === 'service_role')) {
    findings.push(`${file}: legacy Supabase service-role JWT`);
  }
  return findings;
};

const main = async () => {
  const forbiddenValues = forbiddenNames.map(name => process.env[name]).filter(value => value && value.length > 8);
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else files.push(fullPath);
    }
  };

  for (const root of roots) await visit(root);
  const findings = [];
  for (const file of files) {
    findings.push(...scanClientContent(await readFile(file, 'utf8'), file, forbiddenValues));
  }
  if (findings.length) {
    console.error('Forbidden server secret material found in the client bundle:');
    console.error(findings.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Client secret scan passed across ${files.length} built files.`);
  }
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
