import crypto from 'node:crypto';
import { Router } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const hash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const createBody = z.object({
  label: z.string().trim().max(120).default(''),
  expiresInDays: z.number().int().min(1).max(90).default(14),
  maxUses: z.number().int().min(1).max(20).default(1)
});

export const createAdminInviteRouter = (admin?: SupabaseClient) => {
  const router = Router();
  router.use('/admin', (request, response, next) => {
    if (request.user?.role !== 'owner') {
      response.status(403).json({ error: { code: 'owner_required', message: 'Owner access is required.' } });
      return;
    }
    next();
  });

  router.get('/admin/invites', async (request, response) => {
    if (!admin) return response.status(503).json({ error: { code: 'not_configured', message: 'Invitations are not configured.' } });
    const { data, error } = await admin.from('invite_codes')
      .select('id,label,max_uses,use_count,expires_at,disabled_at,created_at')
      .eq('created_by', request.user!.id).order('created_at', { ascending: false });
    if (error) return response.status(500).json({ error: { code: 'invite_list_failed', message: 'Invitations could not be loaded.' } });
    return response.json({ invites: data ?? [] });
  });

  router.post('/admin/invites', async (request, response) => {
    if (!admin) return response.status(503).json({ error: { code: 'not_configured', message: 'Invitations are not configured.' } });
    try {
      const input = createBody.parse(request.body);
      const code = `GF-${crypto.randomBytes(12).toString('base64url').toUpperCase()}`;
      const { data, error } = await admin.from('invite_codes').insert({
        code_hash: hash(code), label: input.label, max_uses: input.maxUses,
        expires_at: new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(), created_by: request.user!.id
      }).select('id,label,max_uses,use_count,expires_at,created_at').single();
      if (error) throw error;
      return response.status(201).json({ invite: data, code });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: { code: 'invalid_request', message: 'Invitation settings are invalid.' } });
      return response.status(500).json({ error: { code: 'invite_create_failed', message: 'The invitation could not be created.' } });
    }
  });

  router.delete('/admin/invites/:inviteId', async (request, response) => {
    if (!admin) return response.status(503).json({ error: { code: 'not_configured', message: 'Invitations are not configured.' } });
    try {
      const inviteId = z.string().uuid().parse(request.params.inviteId);
      const { error } = await admin.from('invite_codes').update({ disabled_at: new Date().toISOString() })
        .eq('id', inviteId).eq('created_by', request.user!.id);
      if (error) throw error;
      return response.status(204).end();
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: { code: 'invalid_request', message: 'Invitation id is invalid.' } });
      return response.status(500).json({ error: { code: 'invite_revoke_failed', message: 'The invitation could not be revoked.' } });
    }
  });

  return router;
};
