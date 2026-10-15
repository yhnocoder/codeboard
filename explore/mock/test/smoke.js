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
  // KaTeX comes from cdnjs (pinned 0.16.9); the sandbox has no direct network, so serve a local copy of the same files
  const KDIR = process.env.KATEX_DIR || '/tmp/claude-0/-home-user-codeboard/b521005b-c131-5858-8dfb-b33ce650bd19/scratchpad/katex';
  const fs = require('fs');
  const serveKatex = async (pg) => pg.route('https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/**', route => {
    const rel = route.request().url().split('/0.16.9/')[1], file = path.join(KDIR, rel);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const type = rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.css') ? 'text/css' : 'font/woff2';
    route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
  });
  await serveKatex(page);
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

  // 12. misc: hide lines (H), comments toggle, highlight, copy without numbers, note, collapse, tidy, duplicate, picker, link menu
  await page.evaluate(() => CB.resetDemo());
  await page.waitForTimeout(300);
  await focus('LLMEngine.step');
  const stc = card('LLMEngine.step');
  await stc.locator('.gutter .no[data-l="54"]').click();
  await stc.locator('.gutter .no[data-l="55"]').click({ modifiers: ['Shift'] });
  const copied = await page.evaluate(() => getSelection().toString());
  log('selection text (copy) =', JSON.stringify(copied));
  await page.keyboard.press('h'); await page.waitForTimeout(200);
  log('gap bar:', await stc.locator('.gap').first().textContent());
  await stc.locator('.gutter .no[data-l="51"]').click({ button: 'right' });
  await page.locator('#ctx button:has-text("Highlight Lines")').click();
  await stc.locator('.chead [data-act="menu"]').click();
  await page.locator('#ctx button:has-text("Collapse Subtree")').click().catch(() => log('no Collapse Subtree (no children)'));
  const gen = card('LLMEngine.generate');
  await focus('LLMEngine.generate', 0.8);
  await gen.locator('.chead [data-act="menu"]').click();
  await page.locator('#ctx button:has-text("Collapse Subtree")').click();
  log('cards after collapse:', await page.locator('.card.kcode').count(), '| badge', await gen.locator('.subc').textContent());
  await gen.locator('.subc').click();
  await gen.locator('.chead [data-act="menu"]').click();
  await page.locator('#ctx button:has-text("Tidy Layout")').click();
  await page.waitForTimeout(600);
  await gen.locator('.chead .kind').click();
  await page.keyboard.press('Control+d');
  log('after duplicate, numbered cards:', (await page.$$eval('.card .chead .step', els => els.map(e => e.textContent))).join(' '), '| code cards', await page.locator('.card.kcode').count());
  // note: new note via N, show/hide background
  await page.mouse.move(1200, 300); await page.keyboard.press('n'); await page.keyboard.type('prefill 优先：有新请求时这一步只做 prefill。'); await page.mouse.click(1300, 800);
  await page.waitForTimeout(300);
  await shot('20-note-dup-tidy');
  // multiple definitions picker: utils/loader.py load_model -> weight_loader
  await page.keyboard.press('Control+k'); await page.keyboard.type('load_model'); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  await focus('load_model');
  await card('load_model').locator('.src span.call:text-is("weight_loader")').first().click();
  await shot('21-picker');
  await page.keyboard.press('Escape');
  // right-click a call -> Link to Existing Card…
  await focus('LLMEngine.step');
  await card('LLMEngine.step').locator('.src span.call:text-is("schedule")').click({ button: 'right' });
  await page.locator('#ctx button:has-text("Link to Existing Card")').click(); await page.waitForTimeout(200);
  await shot('22-link-existing');
  await page.keyboard.press('Escape');
  // localStorage unavailable: page must still work
  const p2 = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  p2.on('pageerror', e => errors.push('p2 pageerror: ' + e.message));
  await p2.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  await p2.route('https://cdnjs.cloudflare.com/**', r => r.abort()); // CDN down: math shows raw TeX
  await p2.goto(URL); await p2.waitForTimeout(500);
  log('no-storage page cards:', await p2.locator('.card').count(), '| CDN blocked, raw TeX shown:', JSON.stringify(await p2.locator('.card.note .tex').first().textContent()));
  await p2.close();

  // ===== 14. batch 2: compare visibility, merge, drag-merge, snap, align, lock, nested sections, link styles/labels, math =====
  const ids = () => page.evaluate(() => Object.fromEntries(Object.values(CB.S.cards).map(c => [c.title || c.text, c.id])));
  const selectTitles = (ts) => page.evaluate(ts => { CB.select(null); for (const t of ts) { const c = Object.values(CB.S.cards).find(c => c.title === t); CB.select(c.id, true); } }, ts);
  const menuLabels = () => page.$$eval('#ctx button', bs => bs.map(b => b.childNodes[1] ? b.textContent : b.textContent));
  const linkMid = (id) => page.evaluate(id => { const p = document.querySelector(`path.ehit[data-link="${id}"]`); const L = p.getTotalLength(), pt = p.getPointAtLength(L * 0.5), m = p.getScreenCTM(); return { x: pt.x * m.a + m.e, y: pt.y * m.d + m.f }; }, id);
  const bbox = async (loc) => loc.boundingBox();
  await page.evaluate(() => CB.resetDemo()); await page.waitForTimeout(400);
  await page.click('#zFit'); await page.waitForTimeout(500);
  // Compare is hidden on a single card; visible for exactly two code cards
  await selectTitles(['LLMEngine.step']);
  await head('LLMEngine.step').click({ button: 'right' });
  log('single-card menu has Compare:', (await menuLabels()).some(t => t.includes('Compare')));
  await page.keyboard.press('Escape');
  await selectTitles(['LLMEngine.add_request', 'LLMEngine.step']);
  await head('LLMEngine.step').click({ button: 'right' });
  log('two-card menu:', (await menuLabels()).map(t => t.trim()).filter(Boolean).join(' | '));
  await shot('23-multi-menu');
  await page.locator('#ctx button:has-text("Merge into One Card")').click(); await page.waitForTimeout(500);
  let M = await page.evaluate(() => { const c = Object.values(CB.S.cards).find(c => c.segs); return c && { id: c.id, title: c.title, segs: c.segs.length, links: CB.S.links.filter(l => l.a === c.id || l.b === c.id).length }; });
  log('merged:', JSON.stringify(M), '| gap bar:', await page.locator('.card .mgap').first().textContent());
  // expand a call from the merged card, then merge across files
  await focus(M.title, 0.9);
  await card(M.title).locator('.src span.call:text-is("schedule")').click(); await page.waitForTimeout(700);
  await selectTitles([M.title, 'Scheduler.schedule']);
  await head('Scheduler.schedule').click({ button: 'right' });
  await page.locator('#ctx button:has-text("Merge into One Card")').click(); await page.waitForTimeout(500);
  M = await page.evaluate(() => { const c = Object.values(CB.S.cards).find(c => c.segs && c.segs.length > 2); return { id: c.id, title: c.title, segs: c.segs.length, files: new Set(c.segs.map(s => s.f)).size }; });
  log('merged across files:', JSON.stringify(M), '| file bars:', await page.locator('.card .fbar').count(), '| numbers', (await page.$$eval('.card .chead .step', els => els.map(e => e.textContent))).join(' '));
  await focus(M.title, 0.75); await shot('24-merged');
  await head(M.title).click({ button: 'right' });
  await page.locator('#ctx button:has-text("Unmerge")').click(); await page.waitForTimeout(400);
  log('after unmerge:', await page.evaluate(() => Object.values(CB.S.cards).filter(c => c.kind === 'code').map(c => c.title + (c.segs ? '[' + c.segs.length + ']' : '')).join(', ')));
  const t1 = Object.keys(await ids()).find(t => / \+1$/.test(t)); await focus(t1, 0.8); await page.waitForTimeout(200);
  await selectTitles([t1]);
  await head(t1).click({ button: 'right' });
  await page.locator('#ctx button:has-text("Unmerge")').click(); await page.waitForTimeout(400);
  log('after second unmerge: code cards', await page.evaluate(() => Object.values(CB.S.cards).filter(c => c.kind === 'code').map(c => c.title).join(', ')), '| links', await page.evaluate(() => CB.S.links.length), '| numbers', (await page.$$eval('.card .chead .step', els => els.map(e => e.textContent))).join(' '));
  // drag-merge: drag add_request by its header onto step's header and pause
  await page.evaluate(() => CB.resetDemo()); await page.waitForTimeout(400);
  await focus('LLMEngine.add_request', 0.8); await page.waitForTimeout(300);
  const ha = await bbox(head('LLMEngine.add_request')), hs = await bbox(card('LLMEngine.step').locator('.chead'));
  await page.mouse.move(ha.x + 4, ha.y + 4); await page.mouse.down();
  await page.mouse.move(hs.x + 200, hs.y + hs.height / 2, { steps: 12 }); await page.waitForTimeout(650);
  await shot('25-release-to-merge');
  await page.mouse.up(); await page.waitForTimeout(400);
  log('drag-merge result:', await page.evaluate(() => Object.values(CB.S.cards).filter(c => c.segs).map(c => c.title + ' ' + c.segs.map(s => s.f + ':' + s.s + '-' + s.e).join(' ')).join(';')));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  // snap while moving: drag the KV Note so its left edge lands 4px off the generate card's left edge
  await page.click('#zFit'); await page.waitForTimeout(500);
  const note = page.locator('.card.note').first(), nb = await bbox(note.locator('.chead')), gb = await bbox(card('LLMEngine.generate'));
  await page.mouse.move(nb.x + 30, nb.y + 10); await page.mouse.down();
  await page.mouse.move(gb.x + 33, gb.y + gb.height + 40, { steps: 10 }); await page.waitForTimeout(200);
  log('guides while dragging:', await page.locator('#guides .guide').count());
  await shot('26-snap-guides');
  await page.mouse.up();
  log('note x vs generate x:', await page.evaluate(() => { const n = Object.values(CB.S.cards).find(c => c.bg), g = Object.values(CB.S.cards).find(c => c.title === 'LLMEngine.generate'); return [Math.round(n.x * 10) / 10, g.x]; }));
  await page.keyboard.press('Control+z');
  // equal-width snap while resizing add_request towards generate's width
  await focus('LLMEngine.add_request', 0.7); await page.waitForTimeout(300);
  const ac = card('LLMEngine.add_request'), grip = await bbox(ac.locator('.grip'));
  const gw = await page.evaluate(() => document.querySelector('#cardsL .card[data-id="' + Object.values(CB.S.cards).find(c => c.title === 'LLMEngine.generate').id + '"]').offsetWidth);
  const aw = await page.evaluate(() => Object.values(CB.S.cards).find(c => c.title === 'LLMEngine.add_request').w);
  await page.mouse.move(grip.x + 6, grip.y + 6); await page.mouse.down();
  await page.mouse.move(grip.x + 6 + (gw - aw - 3) * 0.7, grip.y + 30, { steps: 8 }); await page.waitForTimeout(150);
  log('size hint:', await page.locator('#guides .ghint').allTextContents());
  await shot('27-same-width');
  await page.mouse.up();
  await page.keyboard.press('Control+z');
  // align toolbar
  await page.click('#zFit'); await page.waitForTimeout(400);
  await selectTitles(['LLMEngine.add_request', 'LLMEngine.step', 'LLMEngine.generate']);
  await page.waitForTimeout(200);
  log('align bar visible:', await page.locator('#alignbar.show').count());
  await shot('28-align-bar');
  await page.locator('#alignbar [data-al="left"]').click(); await page.waitForTimeout(300);
  log('x after Align Left:', await page.evaluate(() => Object.values(CB.S.cards).filter(c => c.kind === 'code').map(c => Math.round(c.x)).join(',')));
  await page.keyboard.press('Control+z');
  // lock
  await selectTitles(['LLMEngine.step']); await page.keyboard.press('Control+Shift+L'); await page.waitForTimeout(200);
  const sb0 = await bbox(head('LLMEngine.step')), y0 = await page.evaluate(() => Object.values(CB.S.cards).find(c => c.title === 'LLMEngine.step').y);
  await page.mouse.move(sb0.x + 40, sb0.y + 4); await page.mouse.down(); await page.mouse.move(sb0.x + 140, sb0.y + 120, { steps: 6 }); await page.mouse.up();
  const y1 = await page.evaluate(() => Object.values(CB.S.cards).find(c => c.title === 'LLMEngine.step').y);
  await page.keyboard.press('Control+a');
  log('locked: glyph', await card('LLMEngine.step').locator('.lockb').count(), '| moved', y0 !== y1, '| in Select All', await page.evaluate(() => [...CB.sel].includes(Object.values(CB.S.cards).find(c => c.title === 'LLMEngine.step').id)));
  await page.keyboard.press('Escape');
  await focus('LLMEngine.step', 0.9);
  await card('LLMEngine.step').locator('.src span.call:text-is("schedule")').click(); await page.waitForTimeout(600);
  log('call in locked card still expands:', await card('Scheduler.schedule').count());
  await focus('LLMEngine.step', 0.9); await shot('29-locked');
  await card('LLMEngine.step').locator('.lockb').click(); await page.waitForTimeout(200);
  log('after clicking the lock:', await card('LLMEngine.step').locator('.lockb').count());
  // nested sections with colours
  await page.evaluate(() => CB.resetDemo()); await page.waitForTimeout(300);
  await page.click('#zFit'); await page.waitForTimeout(400);
  await selectTitles(['LLMEngine.add_request', 'LLMEngine.step']);
  await head('LLMEngine.step').click({ button: 'right' });
  await page.locator('#ctx button:has-text("Move to New Section")').click(); await page.waitForTimeout(150);
  await page.keyboard.type('每一步'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  const inner = page.locator('.slabel', { hasText: '每一步' });
  await selectTitles(['LLMEngine.generate']);
  await inner.click({ modifiers: ['Shift'] });
  await head('LLMEngine.generate').click({ button: 'right' });
  await page.locator('#ctx button:has-text("Move to New Section")').click(); await page.waitForTimeout(150);
  await page.keyboard.type('generate 外层'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  const outer = page.locator('.slabel', { hasText: 'generate 外层' });
  await outer.click({ button: 'right' }); await page.locator('#ctx button:has-text("Light Blue")').click();
  await inner.click({ button: 'right' }); await shot('30-section-color-menu'); await page.locator('#ctx button:has-text("Warm Sand")').click();
  await page.waitForTimeout(200);
  log('sections:', await page.evaluate(() => CB.S.sects.map(s => `${s.name}<${s.parent ? CB.S.sects.find(x => x.id === s.parent).name : '-'}> ${s.color}`).join(' ; ')));
  await page.click('#zFit'); await shot('31-nested-sections');
  // drag the inner section out by its label, then back in
  let ib = await bbox(inner); const ob = await bbox(page.locator(`.sect[data-sect="${await outer.getAttribute('data-sect')}"]`));
  await page.mouse.move(ib.x + 8, ib.y + 8); await page.mouse.down(); await page.mouse.move(ob.x + ob.width + 260, ib.y + 8, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(300);
  log('after drag out:', await page.evaluate(() => CB.S.sects.map(s => `${s.name}<${s.parent ? 'child' : 'top'}>`).join(' ; ')));
  ib = await bbox(inner);
  await page.mouse.move(ib.x + 8, ib.y + 8); await page.mouse.down(); await page.mouse.move(ob.x + 60, ib.y + 8, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(300);
  log('after drag back in:', await page.evaluate(() => CB.S.sects.map(s => `${s.name}<${s.parent ? 'child' : 'top'}>`).join(' ; ')));
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  // plain link styling + labels on plain and call links
  await page.evaluate(() => CB.resetDemo()); await page.waitForTimeout(300);
  await page.click('#zFit'); await page.waitForTimeout(400);
  await page.evaluate(() => { const g = Object.values(CB.S.cards).find(c => c.title === 'LLMEngine.generate'), n = Object.values(CB.S.cards).find(c => c.bg); CB.select(null); CB.select(g.id, true); CB.select(n.id, true); });
  await head('LLMEngine.generate').click({ button: 'right' });
  await page.locator('#ctx button:has-text("Connect with Plain Link")').click(); await page.waitForTimeout(300);
  const pl = await page.evaluate(() => CB.S.links.find(l => l.t === 'plain').id);
  for (const item of ['One-way', 'Solid', 'Orange']) { const m = await linkMid(pl); await page.mouse.click(m.x, m.y, { button: 'right' }); await page.waitForTimeout(150); if (item === 'One-way') await shot('32-link-menu'); await page.locator(`#ctx button:has-text("${item}")`).click(); await page.waitForTimeout(150); }
  let m = await linkMid(pl); await page.mouse.dblclick(m.x, m.y); await page.waitForTimeout(150);
  await page.keyboard.type('公式出处'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  const cl = await page.evaluate(() => { const st = Object.values(CB.S.cards).find(c => c.title === 'LLMEngine.step'); return CB.S.links.find(l => l.b === st.id).id; });
  m = await linkMid(cl); await page.mouse.dblclick(m.x, m.y); await page.waitForTimeout(150);
  await page.keyboard.type('每轮一次'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  log('plain link:', await page.evaluate(id => { const l = CB.S.links.find(x => x.id === id); return [l.arrow, l.style, l.color, l.label].join(' '); }, pl), '| arrowheads', await page.locator('path.ahead.lc-orange').count(), '| call label chip:', await page.locator('.vchips .vlabel').allTextContents());
  await shot('33-link-styles-labels');
  // math in a note: KaTeX rendered
  log('KaTeX rendered in note:', await page.locator('.card.note .katex').count());
  // 13. undo / redo
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await page.click('#zFit');
  await shot('13-final');
  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'zero console errors');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); console.log(errors.join('\n')); process.exit(2); });
