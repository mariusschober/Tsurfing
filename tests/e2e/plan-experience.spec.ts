import { test, expect, type Page } from '@playwright/test';

const account = 'test@goalflow.local';
async function unlock(page: Page) {
  await page.goto('/');
  await expect(page.locator('#test-code').or(page.locator('header'))).toBeVisible();
  if (await page.locator('#test-code').isVisible()) {
    await page.locator('#test-code').fill('123456');
    await page.getByRole('button', { name: 'Enter test app' }).click();
  }
  await expect(page.locator('header')).toBeVisible();
}
async function navigate(page: Page, name: string) {
  const button = page.locator('header').getByRole('button', { name, exact: true });
  if (await button.isVisible()) await button.click();
  else {
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('button', { name, exact: true }).click();
  }
}
async function seed(page: Page, count = 4, longTitle = false) {
  await unlock(page);
  await page.evaluate(async ({ account, count, longTitle }) => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const tasks = [50,25,25,45].slice(0,count).map((duration,i) => ({
      id: `plan-example-${i}`, title: i === 0 && longTitle ? 'A longer planning task whose complete title must remain readable while rearranging the day on a small screen' : `Planning example ${i+1}`,
      duration, dateAssigned: today, scheduledFor: today, schedulePrecision: 'day',
      completed: false, wontDo: false, isFrog: false, hashtags: [], createdAt: i+1, plannedOrder: i,
    }));
    await (window as any).__navigationStorage.set('tasks', account, tasks, 'cloud');
    (window as any).__navigationRenderAccount(account);
  }, { account, count, longTitle });
  await expect(page.locator('header')).toBeVisible();
  await navigate(page,'Plan');
  await expect(page.getByRole('button',{name:'Manual',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.planning-task')).toHaveCount(count);
}
async function savedTasks(page: Page) {
  return page.evaluate(async account => {
    const storage=(window as any).__navigationStorage;
    await storage.flushPendingLocalChanges(account);
    return (await storage.get('tasks', account)).sort((a:any,b:any)=>a.id.localeCompare(b.id));
  }, account);
}
const mode = (page: Page, name: string) => page.getByRole('group',{name:'Planning mode',exact:true}).getByRole('button',{name,exact:true});
const density = (page: Page, name: string) => page.getByRole('group',{name:'Task layout',exact:true}).getByRole('button',{name,exact:true});
async function documentFits(page: Page) {
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
}

for (const theme of ['light','dark'] as const) test(`Plan ${theme}: compact and proportional fit and preserve task data`, async ({page},info)=>{
  await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
  await page.setViewportSize({width:1750,height:958});
  await seed(page);
  const initial=await savedTasks(page);
  await expect(page.getByRole('button',{name:'Add Task',exact:true})).toHaveCount(0);
  await expect(page.getByTitle('Add new task (a)')).toHaveCount(1);
  const fourth=await page.locator('.planning-task').nth(3).boundingBox();
  const bar=await page.locator('.planning-confirmation').boundingBox();
  expect(fourth!.y+fourth!.height).toBeLessThan(bar!.y);
  expect((await page.locator('.planning-timeline').boundingBox())!.y).toBeLessThan(300);
  for (const layout of ['Compact','Proportional']) {
    await density(page,layout).click();
    const heights=await page.locator('.planning-task').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().height));
    if(layout==='Compact') expect(Math.max(...heights)-Math.min(...heights)).toBeLessThan(2);
    else expect(heights[0]).toBeGreaterThan(heights[1]);
    for(const [width,height] of [[1750,958],[1366,768],[1024,768],[768,1024],[390,844],[320,568],[844,390]]) {
      await page.setViewportSize({width,height}); await documentFits(page);
      const controls=await page.locator('.plan-mode button,.plan-density button').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {w:r.width,h:r.height};}));
      expect(controls.every(r=>r.w>=44 && r.h>=36)).toBe(true);
      if([1750,390,320].includes(width)) await page.screenshot({path:info.outputPath(`${theme}-${layout}-${width}.png`),animations:'disabled'});
    }
    expect(await savedTasks(page)).toEqual(initial);
  }
  await page.reload(); await navigate(page,'Plan');
  await expect(density(page,'Proportional')).toHaveAttribute('aria-pressed','true');
  await page.evaluate(()=> (window as any).__navigationRenderAccount('plan-other@example.test'));
  await navigate(page,'Plan');
  await expect(density(page,'Compact')).toHaveAttribute('aria-pressed','true');
});

test('Prioritize works without check-in, cancels safely, applies once and yields to manual dragging', async({page},info)=>{
  await page.clock.install();
  await seed(page,2);
  const initial=await savedTasks(page);
  await mode(page,'Prioritize').click();
  const quiz=page.getByRole('dialog',{name:'Prioritize tasks'});
  await expect(quiz).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mode(page,'Prioritize')).toBeFocused();
  await expect(mode(page,'Manual')).toHaveAttribute('aria-pressed','true');
  expect(await savedTasks(page)).toEqual(initial);
  await mode(page,'Prioritize').click();
  const grid=quiz.getByRole('group',{name:/Task rating grid/});
  await grid.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await grid.focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
  await expect(quiz).toBeHidden();
  await expect(mode(page,'Prioritize')).toHaveAttribute('aria-pressed','true');
  await expect(mode(page,'Prioritize')).toBeFocused();
  await expect(page.locator('.planning-task__title').first()).toHaveText('Planning example 2');
  const ranked=await savedTasks(page);
  await navigate(page,'Habits'); await navigate(page,'Plan');
  await expect(mode(page,'Prioritize')).toHaveAttribute('aria-pressed','true');
  expect(await savedTasks(page)).toEqual(ranked);
  await mode(page,'Prioritize').click(); await page.keyboard.press('Escape');
  const draggable=page.locator('[data-rfd-draggable-id]').first();
  await draggable.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
  await expect(mode(page,'Manual')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.planning-task__title').first()).toHaveText('Planning example 1');
  await page.screenshot({path:info.outputPath('manual-after-ranking.png'),animations:'disabled'});
  await mode(page,'Prioritize').click();
  await grid.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await expect(mode(page,'Prioritize')).toHaveAttribute('aria-pressed','true');
  // Let the existing 300ms persistence debounce finish before comparing midnight state.
  await page.clock.runFor(500);
  const beforeNewDay=await savedTasks(page);
  await mode(page,'Prioritize').click();
  await page.clock.fastForward(24*60*60*1000+61000);
  await expect(mode(page,'Manual')).toHaveAttribute('aria-pressed','true');
  await expect(quiz).toBeHidden();
  expect(await savedTasks(page)).toEqual(beforeNewDay);
});

test('Circadian quiz preserves order and check-in survives switching Plan to Manual', async({page})=>{
  await seed(page,2);
  const initial=await savedTasks(page);
  await mode(page,'Circadian').click();
  const quiz=page.getByRole('dialog',{name:'Circadian check-in'});
  await expect(quiz).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mode(page,'Circadian')).toBeFocused();
  await expect(mode(page,'Manual')).toHaveAttribute('aria-pressed','true');
  await mode(page,'Circadian').click();
  await quiz.getByRole('button',{name:'Next',exact:true}).click();
  await quiz.getByRole('button',{name:/Yes/}).click();
  await quiz.getByRole('button',{name:'Next',exact:true}).click();
  await quiz.getByRole('button',{name:'Calibrate',exact:true}).click();
  await quiz.getByRole('button',{name:'Enter Timeline',exact:true}).click();
  await expect(mode(page,'Circadian')).toHaveAttribute('aria-pressed','true');
  await expect(mode(page,'Circadian')).toBeFocused();
  await expect(page.getByText(/Circadian score:/)).toBeVisible();
  expect(await savedTasks(page)).toEqual(initial);
  const checkIn=()=>page.evaluate(async account=>(window as any).__navigationStorage.get('circadian',account),account);
  const checked=await checkIn();
  await mode(page,'Manual').click();
  expect(await checkIn()).toEqual(checked);
  await expect(page.getByText(/Circadian score:/)).toBeHidden();
  await navigate(page,'Current');
  await expect(page.getByRole('button',{name:'Mode: Bio-Adaptive'})).toBeVisible();
  await navigate(page,'Plan');
  await expect(mode(page,'Manual')).toHaveAttribute('aria-pressed','true');
});

test('Empty state offers contextual Add; long titles expand and footer does not hide final row',async({page},info)=>{
  await seed(page,0);
  await expect(mode(page,'Prioritize')).toBeDisabled();
  await expect(page.getByText('Add a task to use Prioritize.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Add Task',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Insert Break',exact:true}).click();
  await page.getByRole('button',{name:'Schedule Break',exact:true}).click();
  await expect(page.locator('.planning-task')).toHaveCount(1);
  await expect(mode(page,'Prioritize')).toBeDisabled();
  const breaks=await savedTasks(page);
  await density(page,'Proportional').click(); await density(page,'Compact').click();
  expect(await savedTasks(page)).toEqual(breaks);
  await seed(page,4,true);
  await page.setViewportSize({width:390,height:844});
  await documentFits(page);
  const title=page.locator('.planning-task__title').first();
  expect(await title.evaluate(el=>el.scrollHeight<=el.clientHeight+1)).toBe(true);
  await page.locator('.planning-task').last().evaluate(el=>el.scrollIntoView({block:'center'}));
  const row=await page.locator('.planning-task').last().boundingBox();
  const bar=await page.locator('.planning-confirmation').boundingBox();
  expect(row!.y+row!.height).toBeLessThan(bar!.y);
  await page.screenshot({path:info.outputPath('long-title-mobile.png'),animations:'disabled'});
});
