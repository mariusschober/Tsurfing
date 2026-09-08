import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccountRouter } from './account';
import { createAdminInviteRouter } from './adminInvites';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

const serveAsBeta = async (): Promise<string> => {
  const app = express();
  app.use('/api/v1', (request, _response, next) => {
    request.user = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'beta@example.invalid',
      role: 'beta',
      status: 'active',
      aal: 'aal1'
    };
    next();
  }, createAdminInviteRouter(), createAccountRouter());
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe('admin router ownership boundary', () => {
  it('denies beta users on admin paths without intercepting ordinary account paths', async () => {
    const origin = await serveAsBeta();
    const adminResponse = await fetch(`${origin}/api/v1/admin/invites`);
    expect(adminResponse.status).toBe(403);
    await expect(adminResponse.json()).resolves.toMatchObject({ error: { code: 'owner_required' } });

    const accountResponse = await fetch(`${origin}/api/v1/account/export`);
    expect(accountResponse.status).toBe(503);
    await expect(accountResponse.json()).resolves.toMatchObject({ error: { code: 'not_configured' } });
  });
});
