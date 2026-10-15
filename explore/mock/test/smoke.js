// Smoke test for the CodeBoard mock. Run: NODE_PATH=$(npm root -g) node explore/mock/test/smoke.js
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SHOTS || '/tmp/claude-0/-home-user-codeboard/b521005b-c131-5858-8dfb-b33ce650bd19/scratchpad/mockshots';
const URL = 'file://' + path.resolve(__dirname, '..', 'mock.html');
const errors = [];
const log = (...a) => console.log('·', ...a);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const shot = async (n) => { await page.waitForTimeout(450); await page.screenshot({ path: `${OUT}/${n}.png` }); log('shot', n); };
  const card = (title) => page.locator('.card', { has: page.locator(`.chead .ctitle:text-is("${title}")`) }).first();
  const call = async (title, name, nth = 0) => { await card(title).locator(`.src span.call:text-is("${name}")`).nth(nth).click(); await page.waitForTimeout(700); };
  const head = (title) => card(title).locator('.chead .kind');

  await page.goto(URL);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload();
  await page.waitForTimeout(600);
  await shot('01-start');

  // 1. expand calls from step
  await call('LLMEngine.step', 'schedule');
  await call('LLMEngine.step', 'call');
  await call('LLMEngine.step', 'postprocess');
  await page.click('#zFit'); await shot('02-expanded');
  const nums = await page.$$eval('.card .chead .step', els => els.map(e => e.textContent));
  log('numbers', nums.join(' '));

  // 2. sidenote on Scheduler.schedule lines 30-31
  await page.evaluate(() => CB.select(null));
  const sc = card('Scheduler.schedule');
  await sc.locator('.chead .kind').click();
  await page.evaluate(() => { const c = Object.values(CB.S.cards).find(c => c.title === 'Scheduler.schedule'); const r = { x: c.x - 40, y: c.y - 40, w: 700, h: 500 }; const { w, h } = { w: innerWidth, h: innerHeight }; CB.cam.x.set(80 - r.x); CB.cam.y.set(80 - r.y); CB.cam.k.set(1); CB.render(); });
  await page.waitForTimeout(200);
  await sc.locator('.gutter .no[data-l="30"]').click();
  await sc.locator('.gutter .no[data-l="31"]').click({ modifiers: ['Shift'] });
  await shot('03a-lines-selected');
  await page.keyboard.press('s');
  await page.waitForTimeout(200);
  await page.keyboard.type('只要 waiting 里还有请求，这一步就只做 prefill。');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(300);
  await sc.locator('.gutter .mk').first().hover();
  await shot('03-sidenote');
  await page.mouse.move(5, 450);
  await page.waitForTimeout(400);

  // 3. definition peek on self.max_num_batched_tokens (line 32) -> Follow
  await sc.locator('.src .l[data-l="32"] span.pk:text-is("max_num_batched_tokens")').hover();
  await page.waitForTimeout(700);
  await shot('04-peek');
  await page.locator('#peek [data-pk="follow"]').click();
  await shot('05-peek-follow');
  await page.locator('#peek [data-pk="pin"]').click();
  await page.waitForTimeout(300);
  await page.mouse.move(5, 450);

  // 4. Add Function... ModelRunner.run, expand prepare_prefill + prepare_decode (second tree, B)
  await page.keyboard.press('Control+k');
  await page.keyboard.type('ModelRunner.run');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await call('ModelRunner.run', 'prepare_prefill');
  await call('ModelRunner.run', 'prepare_decode');
  await page.click('#zFit'); await page.waitForTimeout(600);
  await shot('06-two-trees');
  // select both and compare
  await page.evaluate(() => { const ids = Object.values(CB.S.cards).filter(c => /prepare_(prefill|decode)$/.test(c.title)).map(c => c.id); CB.select(null); ids.forEach(i => CB.select(i, true)); });
  const pf = card('ModelRunner.prepare_prefill');
  await pf.locator('.chead .cpath').click({ button: 'right' });
  await shot('07-compare-menu');
  await page.locator('#ctx button:has-text("Compare")').click();
  await page.waitForTimeout(500);
  await page.evaluate(() => { const k = Object.values(CB.S.cards).find(c => c.kind === 'compare'); const el = document.querySelector(`.card[data-id="${k.id}"]`); el.scrollIntoView; CB.cam.x.set(60 - k.x * 0.8); CB.cam.y.set(70 - k.y * 0.8); CB.cam.k.set(0.8); CB.render(); });
  await shot('08-compare');
  await page.locator('.cmp .seg2:has-text("Hide Same Lines")').click();
  await shot('08b-compare-hide-same');
  await page.locator('.cmp .seg2:has-text("Hide Same Lines")').click();

  // 5. cross-tree compare: Scheduler.schedule (A) + ModelRunner.run (B) -> disabled
  await page.evaluate(() => { const ids = Object.values(CB.S.cards).filter(c => c.title === 'Scheduler.schedule' || c.title === 'ModelRunner.run').map(c => c.id); CB.select(null); ids.forEach(i => CB.select(i, true)); });
  await page.click('#zFit'); await page.waitForTimeout(600);
  await page.evaluate(() => { const c = Object.values(CB.S.cards).find(c => c.title === "ModelRunner.run"); CB.cam.x.set(100 - c.x); CB.cam.y.set(100 - c.y); CB.cam.k.set(1); CB.render(); });
  await head("ModelRunner.run").click({ button: "right" });
  await shot('09-cross-tree-disabled');
  const dis = await page.locator('#ctx button:has-text("Compare")').getAttribute('disabled');
  const why = await page.locator('#ctx button:has-text("Compare") .why').textContent();
  log('cross-tree compare disabled:', dis !== null, '|', why);
  await page.keyboard.press('Escape');

  // 6. text card on empty canvas
  await page.evaluate(() => CB.select(null));
  const box = await page.evaluate(() => { const r = [...document.querySelectorAll('.card')].map(e => e.getBoundingClientRect()); return { x: Math.max(...r.map(q => q.right)) + 40, y: 200 }; });
  const tx = Math.min(box.x, 1300), ty = 160;
  await page.mouse.dblclick(tx, ty);
  await page.waitForTimeout(200);
  await page.keyboard.type('KV cache 生命周期');
  await page.mouse.click(tx, ty + 400);
  await page.waitForTimeout(200);
  await page.mouse.click(tx + 20, ty + 10);
  await shot('10-text-card');

  // 7. walkthrough of tree A from step
  await page.evaluate(() => { const c = Object.values(CB.S.cards).find(c => c.title === 'LLMEngine.step'); CB.select(c.id); });
  await page.keyboard.press('p');
  await shot('11-walkthrough');
  await page.keyboard.press('ArrowRight');
  await shot('12-walkthrough-next');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 8. undo / redo
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await page.click('#zFit');
  await shot('13-final');
  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'zero console errors');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); console.log(errors.join('\n')); process.exit(2); });
