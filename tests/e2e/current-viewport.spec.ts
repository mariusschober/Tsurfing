import { test, expect, type Page } from '@playwright/test';

const sizes = [[1920,1080],[1558,915],[1440,900],[1366,768],[1280,720],[1024,768],[870,700],[768,1024],[430,932],[390,844],[375,667],[320,568],[844,390],[667,375],[568,320],[320,320]];
async function unlock(page:Page) {
  await page.goto('/');
  await expect(page.locator('#test-code').or(page.locator('header'))).toBeVisible();
  if(await page.locator('#test-code').isVisible()) { await page.locator('#test-code').fill('123456'); await page.getByRole('button',{name:'Enter test app'}).click(); }
  await expect(page.locator('header')).toBeVisible();
}
async function openPlan(page:Page) {
  if(await page.locator('header').getByRole('button',{name:'Plan',exact:true}).isVisible()) await page.locator('header').getByRole('button',{name:'Plan',exact:true}).click();
  else { await page.getByRole('button',{name:'Open menu',exact:true}).click(); await page.getByRole('dialog',{name:'Menu',exact:true}).getByRole('button',{name:'Plan',exact:true}).click(); }
}
async function startTask(page:Page,title='A clear next action') {
  await page.getByTitle('Add new task (a)').click();
  const form=page.getByRole('dialog',{name:'New Task'});
  await form.getByPlaceholder('What is the next action?').fill(title);
  await form.locator('[aria-label="Task schedule"]').getByRole('button',{name:'Today',exact:true}).click();
  await form.getByRole('button',{name:'Create Task',exact:true}).click();
  await openPlan(page);
  await page.getByRole('button',{name:'Start focus',exact:true}).click();
  await expect(page.locator('.focus-card')).toBeVisible();
}
async function fits(page:Page) {
  await expect.poll(()=>page.evaluate(()=>Math.max(document.documentElement.scrollWidth-innerWidth,document.documentElement.scrollHeight-innerHeight))).toBeLessThanOrEqual(1);
}
async function controlsFit(page:Page) {
  const failures=await page.locator('.focus-actions button, .focus-toolbar button, .focus-breakdown, .app-add-task').evaluateAll(els=>els.flatMap(el=>{
    const r=el.getBoundingClientRect();
    return r.width<43.9||r.height<43.9||r.left<0||r.right>innerWidth+1||r.top<0||r.bottom>innerHeight+1?[{name:el.getAttribute('title')||el.textContent,rect:{left:r.left,top:r.top,width:r.width,height:r.height},viewport:[innerWidth,innerHeight]}]:[];
  }));
  expect(failures).toEqual([]);
}
for(const theme of ['light','dark'] as const) test(`Current ${theme}: viewport fit keeps timer and actions available across portrait and short screens`,async({page},info)=>{
  await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
  await unlock(page); await startTask(page);
  await page.getByTitle('Start Focus (Space)').click();
  await expect(page.getByTitle('Pause Timer (Space)')).toBeVisible();
  const session=()=>page.evaluate(async()=>{ const s=(window as any).__navigationStorage; await s.flushPendingLocalChanges('test@goalflow.local'); return (await s.get('tracking','test@goalflow.local')).focusSession; });
  const initial=await session(); expect(initial).toBeTruthy();
  for(const [width,height] of sizes) await test.step(`${width}x${height}`,async()=>{
    await page.setViewportSize({width,height}); await fits(page); await controlsFit(page);
    await expect(page.getByTitle('Pause Timer (Space)')).toBeVisible(); expect(await session()).toEqual(initial);
    if([1558,1366,390,568,320].includes(width)) await page.screenshot({animations:'disabled',path:info.outputPath(`${theme}-${width}x${height}.png`)});
  });
});
test('Current notes stay usable in their own panel and Plan keeps normal page scrolling',async({page},info)=>{
  await unlock(page); await startTask(page,'A longer task title that stays readable while the viewport changes and the notes panel is open');
  await page.setViewportSize({width:390,height:667});
  await page.getByTitle('Toggle Notes (N)').click();
  const notes=page.getByPlaceholder('Add session notes...');
  await expect(notes).toBeFocused();
  await notes.fill(Array.from({length:40},(_,i)=>`Note ${i+1}: a useful detail`).join('\n'));
  await fits(page);
  await page.screenshot({animations:'disabled',path:info.outputPath('notes-mobile.png')});
  await page.getByTitle('Toggle Notes (N)').click();
  await fits(page); await controlsFit(page);
  await page.screenshot({animations:'disabled',path:info.outputPath('long-title-mobile.png')});
  await openPlan(page);
  await expect(page.locator('.app-shell--current')).toHaveCount(0);
  const pageStyle=await page.locator('main').evaluate(el=>getComputedStyle(el).overflowY);
  expect(pageStyle).not.toMatch(/hidden|clip/);
});
test('Current empty and break states fit the viewport',async({page},info)=>{
  await unlock(page);
  await openPlan(page);
  await page.getByRole('button',{name:'Start focus',exact:true}).click();
  await expect(page.locator('.current-empty')).toBeVisible();
  for(const [width,height] of [[390,667],[568,320],[1280,720]]) { await page.setViewportSize({width,height}); await fits(page); }
  await page.setViewportSize({width:1280,height:720});
  await openPlan(page); await page.getByRole('button',{name:'Insert Break',exact:true}).click();
  await page.getByRole('button',{name:'Schedule Break',exact:true}).click();
  await page.getByRole('button',{name:'Start focus',exact:true}).click();
  await expect(page.locator('.current-break')).toBeVisible();
  for(const [width,height] of [[390,667],[568,320],[1280,720]]) { await page.setViewportSize({width,height}); await fits(page); const r=await page.getByRole('button',{name:'Finish Break',exact:true}).boundingBox(); expect(r!.y+r!.height).toBeLessThanOrEqual(height); }
  await page.screenshot({animations:'disabled',path:info.outputPath('break.png')});
});
