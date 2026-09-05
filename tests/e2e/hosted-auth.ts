import { createClient, type Session } from '@supabase/supabase-js';
import type { BrowserContext } from '@playwright/test';

const projectReference = (supabaseUrl: string): string => {
  const reference = new URL(supabaseUrl).hostname.split('.')[0] ?? '';
  if (!reference.match(/^[a-z0-9]{20}$/)) {
    throw new Error('Hosted Supabase URL does not contain an expected project reference.');
  }
  return reference;
};

const passwordSession = async (
  supabaseUrl: string,
  publishableKey: string,
  email: string,
  password: string,
  expectedUserId: string
): Promise<Session> => {
  // The password exists only for the synthetic CI identity. It is exchanged
  // from the test runner and is never typed into or exposed by the product UI.
  const database = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const { data, error } = await database.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('Hosted test sign-in returned no session.');
  if (data.session.user.id !== expectedUserId) {
    throw new Error('Hosted test credential resolved to an unexpected immutable identity.');
  }
  return data.session;
};

export const installHostedTestSession = async (
  context: BrowserContext,
  supabaseUrl: string,
  publishableKey: string,
  email: string,
  password: string,
  expectedUserId: string
): Promise<void> => {
  const session = await passwordSession(supabaseUrl, publishableKey, email, password, expectedUserId);
  const storageKey = `sb-${projectReference(supabaseUrl)}-auth-token`;
  const serializedSession = JSON.stringify(session);
  await context.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, value);
  }, { key: storageKey, value: serializedSession });
};
