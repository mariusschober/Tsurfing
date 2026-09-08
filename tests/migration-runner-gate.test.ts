import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('PostgreSQL migration runner gate', () => {
  it('uses a digest-pinned PostgreSQL 17 service and checks the server version', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toMatch(/image: postgres:17@sha256:[0-9a-f]{64}/);
    expect(workflow).toContain("server_major=\"$(psql --tuples-only --no-align --command='show server_version_num'");
    expect(workflow).toContain('[ "$server_major" = "17" ]');
    expect(workflow).not.toContain('sudo systemctl start postgresql.service');
    expect(workflow).toContain('pg_isready --host="$PGHOST"');
  });
});
