import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

// Exercise the real wrapper and React mounting behavior with deterministic auth.
// This fixture is bundled in memory only, never into the shipped application.
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Wrapper from './AppWrapper'; createRoot(document.getElementById('root')).render(<Wrapper/>);`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'auth-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/(App|components\/(Auth|MfaGate|TestAccessGate)|services\/authService)$/ }, args =>
        args.importer.endsWith('/AppWrapper.tsx') ? { path: args.path, namespace: 'fixture' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: process.cwd(), contents:
        args.path === './App' ? `import React from 'react'; export default function App(){const [view,setView]=React.useState('Current');const [draft,setDraft]=React.useState('');return <><button onClick={()=>setView('Planning')}>Planning</button><h1>{view}</h1><input aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/></>;}` :
        args.path.endsWith('/Auth') ? `export const Auth=()=> <h1>Sign in</h1>; import React from 'react';` :
        args.path.endsWith('/MfaGate') ? `import React from 'react'; export const MfaGate=({onComplete})=><button onClick={onComplete}>Verify MFA</button>;` :
        args.path.endsWith('/TestAccessGate') ? `export const TestAccessGate=()=>null;` : `
          export {isSameAuthSession} from './services/authService';
          const token=(id)=>'fixture.'+btoa(JSON.stringify({sub:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',session_id:id}))+'.fixture';
          let current={user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'fixture@example.test'},access_token:token('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')};
          let listener; let status=200; let assurance='aal2'; let pending;
          window.authFixture={emit(event='SIGNED_IN'){listener(current,event)},status(value){status=value},assurance(value){assurance=value},newLogin(){current={...current,access_token:token('cccccccc-cccc-4ccc-8ccc-cccccccccccc')};listener(current,'SIGNED_IN')},hold(){pending={};pending.promise=new Promise(resolve=>pending.resolve=resolve)},release(){const p=pending;pending=null;p.resolve()}};
          export class SessionValidationError extends Error { constructor(message,status){super(message);this.status=status} }
          export const isTestBuild=()=>false,getLocalDemoUser=()=>null,shouldDisableServiceWorker=()=>false,isEmailOtpActivationInFlight=()=>false;
          export const getSession=async()=>current,onSessionChange=callback=>{listener=callback;return ()=>{}},logout=async()=>listener(null,'SIGNED_OUT');
          export const resumePendingEmailOtpActivation=async()=>{}, activateTelegramSignup=async()=>false,activateOwnerTelegramLink=async()=>{};
          export const validateServerSession=async(session)=>{if(pending)await pending.promise;if(status!==200)throw new SessionValidationError('Validation failed',status);return {id:session.user.id,email:session.user.email,role:'owner',assuranceLevel:assurance}};
          export const hasTestAccess=()=>false,clearTestAccess=()=>{};
        ` }));
    }}]
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({page}) => {
  await page.route('**/auth-focus-fixture', route => route.fulfill({ contentType:'text/html', body:'<div id="root"></div>' }));
  await page.goto('/auth-focus-fixture');
  await page.addScriptTag({content:bundle});
  await page.getByRole('button',{name:'Verify MFA'}).click();
  await page.getByRole('button',{name:'Planning'}).click();
  await page.getByLabel('Draft').fill('Keep this unsaved task or goal');
});

test('repeated sign-in, token refresh and focus retain view and draft, including slow and offline validation', async ({page}) => {
  await page.evaluate(()=>{const a=(window as any).authFixture;a.hold();a.emit();});
  await expect(page.getByLabel('Draft')).toHaveValue('Keep this unsaved task or goal');
  await page.evaluate(()=> (window as any).authFixture.release());
  for(const event of ['SIGNED_IN','TOKEN_REFRESHED','USER_UPDATED']) {
    await page.evaluate(event=>(window as any).authFixture.emit(event),event);
    await expect(page.getByRole('heading',{name:'Planning'})).toBeVisible();
    await expect(page.getByLabel('Draft')).toHaveValue('Keep this unsaved task or goal');
  }
  await page.evaluate(()=>{(window as any).authFixture.status(503);window.dispatchEvent(new Event('focus'));});
  await expect(page.getByRole('alert')).toContainText('Validation failed');
  await expect(page.getByLabel('Draft')).toHaveValue('Keep this unsaved task or goal');
  await page.evaluate(()=>{(window as any).authFixture.status(200);window.dispatchEvent(new Event('online'));});
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Draft')).toHaveValue('Keep this unsaved task or goal');
});

test('revocation removes the app', async ({page}) => {
  await page.evaluate(()=>{(window as any).authFixture.status(403);(window as any).authFixture.emit();});
  await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
  await expect(page.getByLabel('Draft')).toHaveCount(0);
});
test('new login for the same user must pass MFA again', async ({page}) => {
  await page.evaluate(()=> (window as any).authFixture.newLogin());
  await expect(page.getByRole('button',{name:'Verify MFA'})).toBeVisible();
  await expect(page.getByLabel('Draft')).toHaveCount(0);
});
test('MFA downgrade must pass the gate again', async ({page}) => {
  await page.evaluate(()=>{(window as any).authFixture.assurance('aal1');(window as any).authFixture.emit('TOKEN_REFRESHED');});
  await expect(page.getByRole('button',{name:'Verify MFA'})).toBeVisible();
});
test('sign-out invalidates pending validation', async ({page}) => {
  await page.evaluate(()=>{const a=(window as any).authFixture;a.hold();a.emit();});
  await page.evaluate(()=> (window as any).authFixture.emit('SIGNED_OUT'));
  await page.evaluate(()=> (window as any).authFixture.release());
  await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
});
