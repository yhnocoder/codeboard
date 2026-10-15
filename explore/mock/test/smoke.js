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
  const focus = (title, k = 1) => page.evaluate(([t, k]) => { const c = Object.values(CB.S.cards).find(c => c.title === t || c.text === t); const x = c.cmp ? CB.S.cards[c.cmp] : c; CB.camSet(90 - x.x * k, 80 - x.y * k, k); }, [title, k]);

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
  await focus('Scheduler.schedule');
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
  await focus('ModelRunner.run');
  await call('ModelRunner.run', 'prepare_prefill');
  await focus('ModelRunner.run');
  await call('ModelRunner.run', 'prepare_decode');
  await page.click('#zFit'); await page.waitForTimeout(600);
  await shot('06-two-trees');
  // select both and compare
  await page.evaluate(() => { const ids = Object.values(CB.S.cards).filter(c => /prepare_(prefill|decode)$/.test(c.title)).map(c => c.id); CB.select(null); ids.forEach(i => CB.select(i, true)); });
  await focus('ModelRunner.prepare_prefill', 0.8);
  const pf = card('ModelRunner.prepare_prefill');
  await pf.locator('.chead .cpath').click({ button: 'right' });
  await shot('07-compare-menu');
  await page.locator('#ctx button:has-text("Compare")').click();
  await page.waitForTimeout(500);
  await page.evaluate(() => { const k = Object.values(CB.S.cards).find(c => c.kind === 'compare'); CB.camSet(60 - k.x * 0.9, 70 - k.y * 0.9, 0.9); });
  await shot('08-compare');
  await page.locator('.cmp .seg2:has-text("Hide Same Lines")').click();
  await shot('08b-compare-hide-same');
  await page.locator('.cmp .seg2:has-text("Hide Same Lines")').click();

  // 5. cross-tree compare: Scheduler.schedule (A) + ModelRunner.run (B) -> disabled
  await page.evaluate(() => { const ids = Object.values(CB.S.cards).filter(c => c.title === 'Scheduler.schedule' || c.title === 'ModelRunner.run').map(c => c.id); CB.select(null); ids.forEach(i => CB.select(i, true)); });
  await page.click('#zFit'); await page.waitForTimeout(600);
  await focus('ModelRunner.run', 0.8);
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

  // 8. variables on a Call link (step:50 -> schedule): open checklist via the link menu, tick the return target
  await focus('LLMEngine.step', 0.9);
  const lid = await page.evaluate(() => { const st = Object.values(CB.S.cards).find(c => c.title === 'LLMEngine.step'); return CB.S.links.find(l => l.a === st.id && l.l === 50).id; });
  const mid = await page.evaluate(id => { const p = document.querySelector(`path.ehit[data-link="${id}"]`); const L = p.getTotalLength(), pt = p.getPointAtLength(L * 0.5), m = p.getScreenCTM(); return { x: pt.x * m.a + m.e, y: pt.y * m.d + m.f }; }, lid);
  await page.mouse.move(mid.x, mid.y); await page.waitForTimeout(200);
  await shot('13b-link-hover-plus');
  await page.mouse.click(mid.x, mid.y, { button: 'right' });
  await page.waitForTimeout(250);
  await page.locator('#ctx button:has-text("Add Variables")').click();
  await page.waitForTimeout(250);
  const boxes = page.locator('#pop input[type=checkbox]');
  log('variable candidates:', await boxes.count());
  await boxes.nth(0).check(); await page.waitForTimeout(150);
  await page.locator('#pop input[type=checkbox]').nth(1).check(); await page.waitForTimeout(150);
  await shot('14-variables');
  await page.keyboard.press('Escape');
  await page.locator('.vchips .vchip[data-k]').first().hover();
  await shot('15-variable-hover');
  await page.mouse.move(5, 450);

  // 9. drag a call onto an existing card that is already in a flow -> refused; drag onto canvas -> new card there
  const sched = card('Scheduler.schedule');
  await focus('LLMEngine.step', 0.7);
  const src = page.locator('.card', { has: page.locator('.chead .ctitle:text-is("LLMEngine.step")') }).first().locator('.src span.call:text-is("schedule")');
  const sb = await src.boundingBox(), tb = await sched.locator('.chead').boundingBox();
  await page.mouse.move(sb.x + 5, sb.y + 5); await page.mouse.down();
  await page.mouse.move(sb.x + 60, sb.y + 80, { steps: 5 }); await page.mouse.move(tb.x + 100, tb.y + 10, { steps: 8 });
  await shot('16-call-drag');
  await page.mouse.up(); await page.waitForTimeout(200);
  log('toast:', await page.locator('#toast').textContent());
  await page.mouse.move(sb.x + 5, sb.y + 5); await page.mouse.down();
  await page.mouse.move(sb.x + 500, sb.y + 40, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(800);
  await shot('17-call-drop-canvas');
  log('numbers now', (await page.$$eval('.card .chead .step', els => els.map(e => e.textContent))).join(' '));

  // 10. section + plain link
  await page.evaluate(() => { const ids = Object.values(CB.S.cards).filter(c => c.kind === 'text').map(c => c.id).slice(0, 2); CB.select(null); ids.forEach(i => CB.select(i, true)); });
  await page.click('#zFit'); await page.waitForTimeout(500);
  const t0 = page.locator('.card.text').first();
  await t0.click({ button: 'right', position: { x: 10, y: 8 } });
  await page.locator('#ctx button:has-text("Move to New Section")').click();
  await page.waitForTimeout(150);
  await page.keyboard.type('说明'); await page.keyboard.press('Enter');
  const add = card('LLMEngine.add_request');
  await add.locator('.chead .kind').click({ button: 'right' });
  await page.locator('#ctx button:has-text("Connect")').first().click();
  await card('ModelRunner.run').locator('.chead .kind').click();
  await page.waitForTimeout(300);
  await shot('18-section-plain-link');

  // 11. dark mode
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await focus('LLMEngine.step', 0.9);
  await shot('19-dark');
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  // 12. undo / redo
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await page.click('#zFit');
  await shot('13-final');
  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'zero console errors');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); console.log(errors.join('\n')); process.exit(2); });
