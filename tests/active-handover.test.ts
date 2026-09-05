import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('active local Codex handover', () => {
  const agents = read('AGENTS.md');
  const readme = read('README.md');
  const prompt = read('docs/handover/LOCAL_CODEX_START_PROMPT.md');
  const context = read('docs/handover/LOCAL_CODEX_PERSONAL_BETA_CONTEXT.md');

  it('routes contributors to one active prompt and context', () => {
    expect(agents).toContain('docs/handover/LOCAL_CODEX_PERSONAL_BETA_CONTEXT.md');
    expect(agents).toContain('docs/handover/LOCAL_CODEX_START_PROMPT.md');
    expect(readme).toContain('docs/handover/LOCAL_CODEX_START_PROMPT.md');
    expect(readme).toContain('docs/handover/LOCAL_CODEX_PERSONAL_BETA_CONTEXT.md');
  });

  it('anchors the handover to the reviewed candidate without authorizing promotion', () => {
    expect(prompt).toContain('01f864720df7acfa211745e64edec8b5163ab612');
    expect(prompt).toContain('origin/chore/railway-beta-gate');
    expect(prompt).toContain('Do not merge or deploy `main`');
    expect(context).toContain('Beta Gate run 33823362114');
    expect(context).toContain('86 commits behind');
  });

  it('states the real authentication and realtime gaps and full outcome', () => {
    expect(context).toContain('typed email OTP');
    expect(context).toContain('Telegram OIDC');
    expect(context).toContain('60 seconds');
    expect(context).toContain('300 seconds');
    expect(context).toContain('15 minutes');
    expect(context).toContain('five-surface sync');
    expect(context).toContain('Realtime notifications are wake-up hints only');
    expect(prompt).toContain('Do not merely');
  });

  it('keeps historical prompts visibly non-executable', () => {
    expect(read('docs/STARTER_PROMPT.md')).toMatch(/HISTORICAL PROMPT.*DO NOT EXECUTE/i);
    expect(read('docs/STARTER_PROMPT_NEXT.md')).toMatch(/HISTORICAL PROMPT.*DO NOT EXECUTE/i);
  });
});
