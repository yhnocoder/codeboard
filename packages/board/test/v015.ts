// v0.1.5 外壳、卡片、箭头、贴纸的场景（node run-harness.mjs v15board v15menus v15fresh …）
import { open, shot, symCard, findSym, put, type Host } from "./harness";
import { emptyBoard, type Board, type CodeCard } from "@codeboard/core";

const light = process.argv.includes("--light");
const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + s.text.findIndex((t) => re.test(t)); };
const close = (h: Host) => h.page.context().browser()!.close();

/** step → schedule（子卡在右）、→ postprocess（子卡在下），带变量、旁注、各种贴纸 */
function richBoard(): Board {
  const b = emptyBoard("b1", "v0.1.5");
  const step = card("LLMEngine.step"), sch = card("Scheduler.schedule"), post = card("Scheduler.postprocess");
  put(b, step, 80, 80, 600); put(b, sch, 780, 60, 560); put(b, post, 140, 420, 560);
  const s0 = step.segments[0];
  const l1 = lineOf(step, /scheduler\.schedule\(/), l2 = lineOf(step, /scheduler\.postprocess\(/);
  b.links.push({ id: "L1", kind: "call", from: { card: step.id, seg: s0.id, line: l1 }, to: { card: sch.id }, call: { name: "schedule", col: 37 }, vars: [{ a: "seqs", ret: true }, { a: "is_prefill", ret: true }] });
  b.links.push({ id: "L2", kind: "call", from: { card: step.id, seg: s0.id, line: l2 }, to: { card: post.id }, call: { name: "postprocess", col: 23 }, vars: [{ a: "seqs" }, { a: "token_ids" }, { a: "is_prefill" }] });
  b.sidenotes.push({ id: "n1", kind: "text", md: "Prefill first, then decode.", at: { card: step.id, seg: s0.id, lines: [l1, l1] } });
  b.stickers.push({ id: "k1", icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: step.id, seg: s0.id, line: l1 } });
  b.stickers.push({ id: "k2", icon: { pack: "builtin", name: "question" }, at: { kind: "line", card: step.id, seg: s0.id, line: l1 + 2 } });
  b.stickers.push({ id: "k3", icon: { pack: "builtin", name: "bug" }, at: { kind: "card", card: sch.id } });
  b.stickers.push({ id: "k4", icon: { pack: "builtin", name: "todo-text" }, at: { kind: "canvas", x: 900, y: 600, size: 32 } });
  b.stickers.push({ id: "k5", icon: { pack: "emoji", name: "🔥" }, at: { kind: "canvas", x: 980, y: 600, size: 40 } });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

export const V015: Record<string, () => Promise<void>> = {
  async v15zoom() {
    const b = richBoard();
    b.sections.push({ id: "g1", title: "Scheduling", x: 740, y: 20, w: 640, h: 560, color: "blue" });
    b.place[b.cards[1].id].section = "g1";
    for (const [z, n] of [[0.45, "v15-12-overview"], [0.18, "v15-13-map"]] as const) {
      b.cam = { x: 60, y: 60, z };
      const h = await open({ board: structuredClone(b), light, w: 1400, h: 900 });
      await shot(h, n);
      await close(h);
    }
    const h = await open({ board: structuredClone({ ...b, cam: { x: 0, y: 0, z: 0.8 } }), light, w: 1400, h: 900 });
    await h.page.locator('.slabel[data-sect="g1"] button[aria-label="Collapse Section"]').click(); await h.page.waitForTimeout(120);
    await shot(h, "v15-14-folding");
    await h.page.waitForTimeout(900);
    await shot(h, "v15-15-folded");
    await close(h);
  },
  async v15board() {
    const h = await open({ board: richBoard(), light, w: 1500, h: 950 });
    await shot(h, "v15-01-board");
    await h.page.locator('path.lhit[data-link="L2"]').hover({ force: true }); await h.page.waitForTimeout(150);
    await h.page.mouse.move(10, 10); await h.page.waitForTimeout(120);
    const plusSoon = await h.page.locator(".vplus").count();
    await h.page.waitForTimeout(400);
    const plusLater = await h.page.locator(".vplus").count();
    console.log(plusSoon >= 1 && plusLater === 0 ? "PASS" : "FAIL", "vplus-delay", JSON.stringify({ plusSoon, plusLater }));
    await h.page.locator(".card .src .l").nth(3).hover(); await h.page.waitForTimeout(250);
    await shot(h, "v15-02-ports");
    await close(h);
  },
  async v15menus() {
    const h = await open({ board: richBoard(), light, w: 1500, h: 950 });
    await h.page.locator(".card.ccard .chead").first().click({ button: "right", position: { x: 300, y: 12 } }); await h.page.waitForTimeout(250);
    await shot(h, "v15-03-cardmenu");
    await h.page.locator(".ctx button", { hasText: /^View$/ }).hover(); await h.page.waitForTimeout(250);
    await shot(h, "v15-04-view");
    await h.page.keyboard.press("Escape");
    await h.page.locator('.bbar button[aria-label="Code"]').click(); await h.page.waitForTimeout(250);
    await shot(h, "v15-05-codemenu");
    await h.page.keyboard.press("Escape");
    await h.page.locator('.bbar button[aria-label="More"]').click(); await h.page.waitForTimeout(250);
    await shot(h, "v15-06-more");
    await h.page.keyboard.press("Escape");
    // 菜单碰到底边：往上翻，最后一项看得到
    await h.page.locator(".card.ccard").nth(2).locator(".chead").click({ button: "right", position: { x: 200, y: 12 } }); await h.page.waitForTimeout(250);
    const vis = await h.page.evaluate(() => { const m = document.querySelector(".ctx")!; const r = m.getBoundingClientRect(); const last = [...m.querySelectorAll("button")].pop()!.getBoundingClientRect(); return r.top >= 0 && last.bottom <= innerHeight; });
    console.log(vis ? "PASS" : "FAIL", "menu-fits");
    await close(h);
  },
  async v15sticker() {
    const h = await open({ board: richBoard(), light, w: 1500, h: 950 });
    await h.page.locator('.bbar button[aria-label="Sticker"]').click(); await h.page.waitForTimeout(300);
    await shot(h, "v15-07-picker");
    await h.page.locator(".stkpick .scell").nth(3).click();
    // 点行号栏 → 贴在那一行（点代码正文 → 绑在卡上，v15bind 测）
    await h.page.locator(".card").first().locator(".gutter .no").nth(5).click(); await h.page.waitForTimeout(200);
    await h.page.mouse.click(1200, 800); await h.page.waitForTimeout(200);
    await h.page.locator('.bbar button[aria-label="Sticker"]').click(); await h.page.waitForTimeout(200);
    await h.page.locator(".stkpick .scell").nth(0).click();
    await h.page.mouse.click(1250, 760); await h.page.waitForTimeout(1400);
    const st = h.board().stickers;
    const ok = st.length === 7 && st[5].at.kind === "line" && st[6].at.kind === "canvas";
    console.log(ok ? "PASS" : "FAIL", "sticker-place", JSON.stringify(st.slice(5).map((s) => s.at)));
    await shot(h, "v15-08-placed");
    await h.page.keyboard.press("Delete"); await h.page.waitForTimeout(1400);
    console.log(h.board().stickers.length === 6 ? "PASS" : "FAIL", "sticker-delete");
    await close(h);
  },
  async v15fresh() {
    const b = emptyBoard("b1", "fresh");
    const h = await open({ board: b, light });
    await h.page.locator('.bbar button[aria-label="Note"]').click(); await h.page.waitForTimeout(300);
    await h.page.mouse.click(1000, 700); await h.page.waitForTimeout(300);
    await h.page.locator('.bbar button[aria-label="Code"]').click(); await h.page.waitForTimeout(200);
    await h.page.locator(".ctx button", { hasText: /^New Code$/ }).click(); await h.page.waitForTimeout(300);
    await shot(h, "v15-09-newcode");
    await h.page.mouse.click(1000, 700); await h.page.waitForTimeout(1400);
    const n = h.board().cards.length;
    await h.page.locator('.bbar button[aria-label="More"]').click(); await h.page.waitForTimeout(200);
    const undo = await h.page.locator(".ctx button", { hasText: /^Undo/ }).isDisabled();
    console.log(n === 0 && undo ? "PASS" : "FAIL", "fresh-discard", JSON.stringify({ n, undoDisabled: undo, kinds: h.board().cards.map((c: any) => c.kind + ":" + (c.md ?? c.segments?.[0]?.text)) }));
    await close(h);
  },
  async v15fit() {
    const b = emptyBoard("b1", "fit");
    const one = card("Scheduler.is_finished");
    put(b, one, 80, 80, 700);
    const h = await open({ board: b, light });
    const grip = h.page.locator(".card .grip").first();
    const g = (await grip.boundingBox())!;
    await h.page.mouse.move(g.x + 7, g.y + 7); await h.page.mouse.down(); await h.page.mouse.move(g.x + 7, g.y + 200, { steps: 6 }); await h.page.mouse.up(); await h.page.waitForTimeout(1400);
    const tall = h.board().place[one.id].h;
    const g2 = (await grip.boundingBox())!;
    await h.page.mouse.move(g2.x + 7, g2.y + 7); await h.page.mouse.down(); await h.page.mouse.move(g2.x + 7, g2.y - 400, { steps: 8 }); await h.page.mouse.up();
    const short = (await h.page.locator(".card").first().boundingBox())!.height;
    await shot(h, "v15-10-short");
    await grip.dblclick(); await h.page.waitForTimeout(1400);
    const p = h.board().place[one.id];
    console.log(tall && short < 100 && p.w < 700 ? "PASS" : "FAIL", "resize-fit", JSON.stringify({ tall, short, fit: p }));
    await shot(h, "v15-11-fit");
    await close(h);
  },
  // 回归：空白处右键菜单在四个角都整个留在窗口里
  async v15ctx() {
    const b = emptyBoard("b1", "ctx");
    put(b, card("Scheduler.schedule"), 80, 80, 560);
    const h = await open({ board: b, light });
    const vw = h.page.viewportSize()!;
    const out: any[] = [];
    for (const [x, y] of [[vw.width - 8, 8], [8, vw.height - 70], [vw.width - 8, vw.height - 70], [vw.width - 30, vw.height / 2]]) {
      await h.page.mouse.click(x, y, { button: "right" }); await h.page.waitForTimeout(350);
      const r = await h.page.locator(".ctx").first().evaluate((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, sh: e.scrollHeight, ch: e.clientHeight }; }).catch(() => null);
      out.push(r && { at: [x, y], ...r, ok: r.l >= 0 && r.t >= 0 && r.r <= vw.width && r.b <= vw.height });
      await shot(h, `v15-ctx-${out.length}`);
      await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(200);
    }
    console.log(out.every((o) => o?.ok) ? "PASS" : "FAIL", "ctx-in-viewport", JSON.stringify(out));
    await close(h);
  },
  /** 贴纸绑在卡 / 箭头上：拖卡时跟着走；被别的卡盖住时一起被盖住；选中时画虚线 */
  async v15bind() {
    const b = richBoard();
    const post = b.cards[2].id;
    b.stickers.push({ id: "k6", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 420, y: 70, size: 32, on: { card: post } } });
    b.stickers.push({ id: "k7", icon: { pack: "builtin", name: "todo-text" }, at: { kind: "canvas", x: 10, y: -40, size: 28, on: { link: "L2", t: 0.5 } } });
    b.cards.push({ id: "nb", kind: "note", md: "Covers the star", bg: true });
    b.place.nb = { x: 520, y: 470, w: 260 };
    const h = await open({ board: b, light, w: 1400, h: 900 });
    const pos = () => h.page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-sticker]")].map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.sticker, [Math.round(r.left), Math.round(r.top)]]; })));
    const p0 = await pos();
    // 被盖住：卡 nb 在 post 上面，k6 在 nb 下面
    const covered = await h.page.evaluate(() => { const e = document.querySelector<HTMLElement>('[data-sticker="k6"]')!; const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement; return !!top.closest('.card[data-id="nb"]'); });
    await shot(h, "v15-bind-1");
    // 拖 post 的标题栏往下 60
    const hd = h.page.locator(`.card[data-id="${post}"] .chead`).first();
    const r = (await hd.boundingBox())!;
    await h.page.mouse.move(r.x + 200, r.y + 15); await h.page.mouse.down(); await h.page.mouse.move(r.x + 200, r.y + 75, { steps: 6 }); await h.page.mouse.up();
    await h.page.waitForTimeout(200);
    const p1 = await pos();
    const follows = p1.k6[1] - p0.k6[1] === 60 && p1.k6[0] === p0.k6[0];
    const linkMoved = p1.k7[1] !== p0.k7[1] || p1.k7[0] !== p0.k7[0];
    await h.page.locator('[data-sticker="k7"]').click();
    await h.page.waitForTimeout(150);
    await shot(h, "v15-bind-2");
    const tether = await h.page.locator(".tether line").count();
    // 把 k5（画布上的）拖到 schedule 卡上 → 绑上去
    const k5 = (await h.page.locator('[data-sticker="k5"]').boundingBox())!;
    const sch = (await h.page.locator(`.card[data-id="${b.cards[1].id}"]`).boundingBox())!;
    await h.page.mouse.move(k5.x + 10, k5.y + 10); await h.page.mouse.down(); await h.page.mouse.move(sch.x + 200, sch.y + 200, { steps: 8 });
    const hot = await h.page.locator(".card.bind-hot").count();
    await h.page.mouse.up(); await h.page.waitForTimeout(150);
    const bound = await h.page.evaluate(() => !!document.querySelector('.card [data-sticker="k5"]'));
    await shot(h, "v15-bind-3");
    console.log(covered && follows && linkMoved && tether === 1 && hot === 1 && bound ? "PASS" : "FAIL", "sticker-bind", JSON.stringify({ covered, follows, linkMoved, tether, hot, bound, p0: p0.k6, p1: p1.k6 }));
    await close(h);
  },

  /** 子卡在右下、跟父卡横向重叠：起点自动在右端，从上边进子卡；用户改到左端后要更远才翻回 */
  async v15side() {
    const b = emptyBoard("b1", "side");
    const par = card("ModelRunner.__init__"), kid = card("load_model");
    put(b, par, 20, 20, 1100); put(b, kid, 850, 560, 600);
    const s0 = par.segments[0], ln = lineOf(par, /load_model\(/);
    b.links.push({ id: "L1", kind: "call", from: { card: par.id, seg: s0.id, line: ln }, to: { card: kid.id }, call: { name: "load_model", col: 8 } });
    b.cam = { x: 0, y: 0, z: 0.7 };
    const h = await open({ board: structuredClone(b), light, w: 1400, h: 900 });
    const port = (hh: Host) => hh.page.locator("path.port").first().evaluate((e) => +e.getAttribute("data-x")!);
    const auto = await port(h);
    await shot(h, "v15-side-1");
    await close(h);
    (b.links[0] as any).side = "left";
    const h2 = await open({ board: structuredClone(b), light, w: 1400, h: 900 });
    const user = await port(h2);
    await shot(h2, "v15-side-2");
    await close(h2);
    console.log(auto > 1000 && user < 100 ? "PASS" : "FAIL", "call-side", JSON.stringify({ auto, user }));
  },

  /** Note 切 Show / Hide Background：字的位置、大小、宽度不变 */
  async v15notebg() {
    const b = emptyBoard("b1", "notebg");
    b.cards.push({ id: "n1", kind: "note", md: "Hello\n$a$\n\n$$aaa$$", bg: true });
    b.place.n1 = { x: 120, y: 120, w: 300 };
    const h = await open({ board: b, light, w: 900, h: 600 });
    const first = () => h.page.evaluate(() => { const c = document.querySelector('.card[data-id="n1"]')!; const t = c.querySelector(".nbody, .tx")!; const r = document.createRange(); r.selectNodeContents(t); const q = r.getClientRects()[0]; const f = getComputedStyle(t).fontSize; const cs = getComputedStyle(t); return { x: Math.round(q.left), y: Math.round(q.top), f, w: Math.round(t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) }; });
    const a = await first();
    await shot(h, "v15-notebg-1");
    const box = (await h.page.locator('.card[data-id="n1"]').boundingBox())!;
    await h.page.mouse.click(box.x + 100, box.y + 60, { button: "right" }); await h.page.waitForTimeout(300);
    await h.page.locator(".ctx button", { hasText: "Hide Background" }).click(); await h.page.waitForTimeout(300);
    await h.page.mouse.click(10, 500); await h.page.waitForTimeout(200);
    const c = await first();
    await shot(h, "v15-notebg-2");
    const ok = Math.abs(a.x - c.x) <= 1 && Math.abs(a.y - c.y) <= 1 && a.f === c.f && Math.abs(a.w - c.w) <= 1;
    console.log(ok ? "PASS" : "FAIL", "note-bg-same-layout", JSON.stringify({ a, c }));
    await close(h);
  },

  /** 屏幕右边打开卡片菜单的二级菜单：翻到左边，不盖住一级菜单 */
  async v15submenu() {
    const b = emptyBoard("b1", "sub");
    put(b, card("Scheduler.schedule"), 700, 80, 560);
    const h = await open({ board: b, light, w: 1300, h: 800 });
    const vw = h.page.viewportSize()!;
    await h.page.mouse.click(vw.width - 30, 200, { button: "right" }); await h.page.waitForTimeout(400);
    await h.page.locator(".ctx button", { hasText: "View" }).hover(); await h.page.waitForTimeout(500);
    const rs = await h.page.locator(".ctx").evaluateAll((es) => es.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }));
    await shot(h, "v15-submenu");
    const [m, s] = rs;
    const ok = rs.length === 2 && (s.l >= m.r - 6 || s.r <= m.l + 6) && s.r <= vw.width && s.l >= 0;
    console.log(ok ? "PASS" : "FAIL", "submenu-no-cover", JSON.stringify(rs));
    await close(h);
  },
  /** 代码卡菜单：Edit ▸ Add Description 进入编辑、打字、⌘↵ 保存；标题栏有 Copy Code 图标 */
  async v15desc() {
    const b = emptyBoard("b1", "desc");
    put(b, card("Scheduler.schedule"), 80, 80, 560);
    const h = await open({ board: b, light, w: 1200, h: 800 });
    const hd = h.page.locator(".card .chead").first();
    await hd.click({ button: "right", position: { x: 200, y: 12 } }); await h.page.waitForTimeout(350);
    await shot(h, "v15-cardmenu");
    await h.page.locator('.ctx button:has(.lb:text-is("Edit"))').hover(); await h.page.waitForTimeout(400);
    await shot(h, "v15-cardmenu-edit");
    await h.page.locator(".ctx button", { hasText: "Add Description" }).click(); await h.page.waitForTimeout(300);
    const editing = await h.page.locator(".cdesc.editing").count();
    const focused = await h.page.evaluate(() => document.activeElement?.classList.contains("cdesc") ?? false);
    await h.page.keyboard.type("Picks prefill first."); await h.page.keyboard.press("Meta+Enter"); await h.page.keyboard.press("Control+Enter"); await h.page.waitForTimeout(1400);
    const desc = (h.board().cards[0] as any).desc;
    await hd.hover(); await h.page.waitForTimeout(200);
    const cpy = await h.page.locator(".chead .ib.cpy").first().evaluate((e) => getComputedStyle(e).opacity);
    await shot(h, "v15-desc");
    console.log(editing === 1 && focused && desc === "Picks prefill first." && cpy === "1" ? "PASS" : "FAIL", "add-description", JSON.stringify({ editing, focused, desc, cpy }));
    await close(h);
  },
  /** 线上的标签框：↺ + 变量、自己写的标签 + 变量、只有 ↺、只有标签 */
  async v15vlabel() {
    const b = richBoard();
    const L1 = b.links[0] as any, L2 = b.links[1] as any;
    L1.loop = true; L2.label = "my own label"; L2.loop = true;
    const step = b.cards[0], tail = card("Scheduler.preempt");
    put(b, tail, 780, 640, 420);
    b.links.push({ id: "L3", kind: "plain", from: { card: b.cards[2].id }, to: { card: tail.id }, label: "only a label", arrow: "end" } as any);
    void step;
    const h = await open({ board: b, light, w: 1400, h: 950 });
    await shot(h, "v15-vlabel");
    const n = await h.page.locator(".vcard").count();
    console.log(n === 3 ? "PASS" : "FAIL", "vlabel-boxes", n);
    await close(h);
  },
  /** 双击空白处新建 Text：编辑时跟显示时同字体、同位置，没有套白框 */
  async v15dbl() {
    const h = await open({ board: emptyBoard("b1", "dbl"), light, w: 900, h: 600 });
    await h.page.mouse.dblclick(300, 200); await h.page.waitForTimeout(300);
    await shot(h, "v15-dbl-1");
    await h.page.keyboard.type("Hello board");
    await shot(h, "v15-dbl-2");
    const r = await h.page.evaluate(() => { const t = document.querySelector<HTMLElement>(".tx.editing")!; const cs = getComputedStyle(t); const c = t.closest(".card")!.getBoundingClientRect(), tr = t.getBoundingClientRect(); return { font: cs.fontFamily.slice(0, 20), bg: cs.backgroundColor, sh: cs.boxShadow, inset: Math.round(tr.left - c.left), w: Math.round(c.width - tr.width) }; });
    console.log(r.sh === "none" && r.inset < 10 && r.w < 20 ? "PASS" : "FAIL", "dblclick-text", JSON.stringify(r));
    await close(h);
  },
  /** 空的 New Code：点它自己的语言下拉、选一项，卡还在；之后点空白处才消失 */
  async v15freelang() {
    const h = await open({ board: emptyBoard("b1", "free"), light, w: 1000, h: 700 });
    await h.page.mouse.click(300, 200, { button: "right" }); await h.page.waitForTimeout(300);
    await h.page.locator(".ctx button", { hasText: "New Code" }).click(); await h.page.waitForTimeout(400);
    await h.page.locator(".card .rev.lang").first().click(); await h.page.waitForTimeout(400);
    const afterOpen = await h.page.locator(".card").count();
    await h.page.locator(".ctx button").nth(2).click(); await h.page.waitForTimeout(400);
    const afterPick = await h.page.locator(".card").count();
    const focused = await h.page.evaluate(() => document.activeElement?.classList.contains("freeedit") ?? false);
    await h.page.mouse.click(800, 500); await h.page.waitForTimeout(600);
    const afterAway = await h.page.locator(".card:not(.ghost-out)").count();
    console.log(afterOpen === 1 && afterPick === 1 && focused && afterAway === 0 ? "PASS" : "FAIL", "free-lang-keeps-card", JSON.stringify({ afterOpen, afterPick, focused, afterAway }));
    await close(h);
  },
  /** 选几行 → 右键 New Card from Lines：新卡只有这几行；行号栏没有 + 按钮 */
  async v15fromlines() {
    const b = emptyBoard("b1", "lines");
    put(b, card("Scheduler.schedule"), 80, 80, 560);
    const h = await open({ board: b, light, w: 1400, h: 800 });
    const no = h.page.locator(".card .gutter .no");
    await no.nth(5).click(); await no.nth(8).click({ modifiers: ["Shift"] }); await h.page.waitForTimeout(200);
    const plus = await h.page.locator(".addn").count();
    const lb = (await h.page.locator(".card .src .l").nth(6).boundingBox())!; // 用坐标点：locator.click 会把很宽的行横向滚进视野
    await h.page.mouse.click(lb.x + 60, lb.y + 8, { button: "right" }); await h.page.waitForTimeout(300);
    await h.page.locator(".ctx button", { hasText: "New Card from Lines" }).click(); await h.page.waitForTimeout(1500);
    const cs = h.board().cards as any[];
    const nc = cs[1]?.segments?.[0];
    await shot(h, "v15-fromlines");
    console.log(cs.length === 2 && nc?.text.length === 4 && plus === 0 ? "PASS" : "FAIL", "card-from-lines", JSON.stringify({ n: cs.length, lines: nc?.text.length, start: nc?.start, plus }));
    await close(h);
  },
  /** codeboard.debug.enabled 打开时设置页有 Debug 一节；拖滑块改 Peek 延时 */
  async v15debug() {
    const h = await open({ board: emptyBoard("b1", "dbg"), light, w: 1200, h: 900, settings: { debug: true } });
    await h.page.keyboard.press("Meta+,"); await h.page.waitForTimeout(400);
    await h.page.locator('[data-sec="debug"]').scrollIntoViewIfNeeded();
    await shot(h, "v15-debug");
    const n = await h.page.locator('[data-sec="debug"] .st-tr').count();
    console.log(n >= 6 ? "PASS" : "FAIL", "debug-tune", n);
    await close(h);
  },
  /** 拖得快：不吸附；慢慢拖、停一下：对齐吸附（左边对齐另一张卡） */
  async v15snap() {
    const b = emptyBoard("b1", "snap");
    b.cards.push({ id: "a", kind: "note", md: "A", bg: true }, { id: "m", kind: "note", md: "moving", bg: true });
    b.place.a = { x: 100, y: 100, w: 260 }; b.place.m = { x: 500, y: 400, w: 260 };
    const h = await open({ board: b, light, w: 1200, h: 800 });
    const hd = h.page.locator('.card[data-id="m"] .chead');
    const drag = async (to: number, slow: boolean) => {
      const r = (await hd.boundingBox())!;
      await h.page.mouse.move(r.x + 40, r.y + 10); await h.page.mouse.down();
      const x0 = r.x + 40, tx = x0 + to;
      if (slow) { for (let i = 1; i <= 30; i++) { await h.page.mouse.move(x0 + (to * i) / 30, r.y + 10); await h.page.waitForTimeout(25); } await h.page.waitForTimeout(250); }
      else { for (let i = 1; i <= 4; i++) { await h.page.mouse.move(x0 + (to * i) / 4, r.y + 10); await h.page.waitForTimeout(8); } }
      await h.page.mouse.move(tx, r.y + 10); await h.page.mouse.up(); await h.page.waitForTimeout(1300);
    };
    await drag(-397, false); // 停在 x = 103，离 100 只差 3px
    const fastX = h.board().place.m.x;
    await h.page.keyboard.press("Meta+z"); await h.page.waitForTimeout(1300);
    await drag(-397, true);
    const slowX = h.board().place.m.x;
    console.log(fastX === 103 && slowX === 100 ? "PASS" : "FAIL", "snap-only-when-slow", JSON.stringify({ fastX, slowX }));
    await close(h);
  },
  /** 图片卡没有标题栏，拖图片本身就能移动 */
  async v15img() {
    const b = emptyBoard("b1", "img");
    const svg = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#e8a33d"/><text x="40" y="130" font-size="40">diagram</text></svg>');
    b.cards.push({ id: "i1", kind: "image", src: svg, bg: true } as any);
    b.place.i1 = { x: 120, y: 120, w: 400, h: 240 };
    const h = await open({ board: b, light, w: 1000, h: 700 });
    const heads = await h.page.locator('.card[data-id="i1"] .chead').count();
    const r = (await h.page.locator('.card[data-id="i1"]').boundingBox())!;
    await h.page.mouse.move(r.x + 200, r.y + 120); await h.page.mouse.down(); await h.page.mouse.move(r.x + 260, r.y + 170, { steps: 8 }); await h.page.waitForTimeout(150); await h.page.mouse.up(); await h.page.waitForTimeout(1300);
    const p = h.board().place.i1;
    await shot(h, "v15-img");
    console.log(heads === 0 && p.x === 180 && p.y === 170 ? "PASS" : "FAIL", "image-drag-body", JSON.stringify({ heads, x: p.x, y: p.y }));
    await close(h);
  },
  /** 贴纸拖到卡片外面、离边 20px：也吸附绑定（卡亮一圈） */
  async v15magnet() {
    const b = richBoard();
    const h = await open({ board: b, light, w: 1500, h: 950 });
    const k5 = (await h.page.locator('[data-sticker="k5"]').boundingBox())!;
    const sch = (await h.page.locator(`.card[data-id="${b.cards[1].id}"]`).boundingBox())!;
    await h.page.mouse.move(k5.x + 20, k5.y + 20); await h.page.mouse.down();
    await h.page.mouse.move(sch.x + 30, sch.y - 22, { steps: 10 });
    const hot = await h.page.locator(".card.bind-hot").count();
    await shot(h, "v15-magnet");
    await h.page.mouse.up(); await h.page.waitForTimeout(1300);
    const at = h.board().stickers.find((k) => k.id === "k5")!.at as any;
    console.log(hot === 1 && at.on?.card === b.cards[1].id ? "PASS" : "FAIL", "sticker-magnet", JSON.stringify({ hot, at }));
    await close(h);
  },
  /** 父卡下面被别的卡堵满：展开的子卡放在视野里，不跑到屏幕外 */
  async v15placeview() {
    const b = emptyBoard("b1", "v0.1.5");
    const step = card("LLMEngine.step");
    put(b, step, 80, 80, 600);
    for (let i = 0; i < 3; i++) { const id = `wall${i}`; b.cards.push({ id, kind: "note", md: `wall ${i}`, bg: true } as any); b.place[id] = { x: -200 + i * 900, y: 640, w: 860, h: 3000 }; }
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light, w: 1500, h: 950 });
    await h.page.locator(`.card[data-id="${step.id}"] .src .call`, { hasText: /^schedule$/ }).first().click(); await h.page.waitForTimeout(1600);
    const nb = h.board();
    const nid = nb.cards.find((c) => c.id !== step.id && !c.id.startsWith("wall"))?.id;
    const r = nid && (await h.page.locator(`.card[data-id="${nid}"]`).boundingBox());
    await shot(h, "v15-placeview");
    const ok = !!r && !!nid && nb.place[nid].y < 900 && r.y >= 0 && r.y < 950 - 100 && r.x >= 0 && r.x < 1500 - 100;
    console.log(ok ? "PASS" : "FAIL", "place-in-view", JSON.stringify({ p: nid && nb.place[nid], r }));
    await close(h);
  },
  /** 删掉一条旁注：弹窗留在标记旁边，不跳到左上角 */
  async v15notedel() {
    const b = richBoard();
    const n1 = b.sidenotes[0];
    b.sidenotes.push({ ...n1, id: "n2", md: "Second note." } as any);
    const h = await open({ board: b, light, w: 1500, h: 950 });
    await h.page.locator(".mk").first().click(); await h.page.waitForTimeout(500);
    const p0 = (await h.page.locator(".pop.k-notes").boundingBox())!;
    await h.page.locator('.pop.k-notes [aria-label="Delete Sidenote"]').click(); await h.page.waitForTimeout(600);
    const p1 = (await h.page.locator(".pop.k-notes").boundingBox())!;
    await shot(h, "v15-notedel");
    const ok = Math.abs(p1.x - p0.x) < 30 && Math.abs(p1.y - p0.y) < 30 && h.board().sidenotes.length === 1;
    console.log(ok ? "PASS" : "FAIL", "note-delete-stays", JSON.stringify({ p0, p1 }));
    await close(h);
  },
  /** Note 里的 # 标题有层级；⌘A 在编辑框里只选中这块字 */
  async v15notehead() {
    const b = emptyBoard("b1", "v0.1.5");
    b.cards.push({ id: "t1", kind: "note", md: "# Head\n\n## Sub\n\nBody text here." } as any); b.place.t1 = { x: 60, y: 60, w: 320 };
    b.cards.push({ id: "t2", kind: "note", md: "# Head\n\nBody text here.", bg: true } as any); b.place.t2 = { x: 460, y: 60, w: 320 };
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light, w: 900, h: 500 });
    const fs = await h.page.evaluate(() => [...document.querySelectorAll(".card h1, .card h2, .card p")].map((e) => [e.tagName, parseFloat(getComputedStyle(e).fontSize)]));
    await shot(h, "v15-notehead");
    await h.page.locator('.card[data-id="t2"] .nbody').dblclick(); await h.page.waitForTimeout(400);
    await h.page.keyboard.press("Control+a"); await h.page.waitForTimeout(200);
    const selTxt = await h.page.evaluate(() => String(window.getSelection()));
    const h1 = fs.find((x) => x[0] === "H1")?.[1] as number, p = fs.find((x) => x[0] === "P")?.[1] as number;
    const ok = h1 >= p * 1.6 && selTxt.includes("# Head") && selTxt.includes("Body text here.");
    console.log(ok ? "PASS" : "FAIL", "note-head", JSON.stringify({ fs, selTxt }));
    await close(h);
  },
  /** 内置贴纸在每个主题里的样子 */
  async v15stkthemes() {
    for (const theme of ["warm-ink", "classic", "graphite", "soft-light", "drafting", "colorful", "newspaper", "poster"]) {
      const b = emptyBoard("b1", "v0.1.5");
      const names = ["star", "question", "exclaim", "check", "flag", "zap", "bug", "todo", "heart", "hourglass", "warning", "todo-text"];
      names.forEach((n, i) => b.stickers.push({ id: `k${i}`, icon: { pack: "builtin", name: n }, at: { kind: "canvas", x: 40 + i * 52, y: 40, size: 36 } }));
      b.cam = { x: 0, y: 0, z: 1 };
      const h = await open({ board: b, light, w: 760, h: 140, settings: { theme } as any });
      const bg = await h.page.locator('[data-sticker="k0"] circle.bg').evaluate((e) => getComputedStyle(e).fill);
      await shot(h, `v15-stk-${theme}`);
      console.log("stk", theme, bg);
      await close(h);
    }
  },
  /** 各主题下代码卡的尺寸指标：字宽、行高、卡头高、代码区上下留白；换主题时卡片要装得下同样的内容 */
  async v15metrics() {
    const rows: any[] = [];
    for (const theme of ["warm-ink", "classic", "graphite", "soft-light", "drafting", "colorful", "newspaper", "poster"]) {
      const b = richBoard();
      const h = await open({ board: b, light, w: 1500, h: 950, settings: { theme } as any });
      await h.page.waitForTimeout(500);
      const m = await h.page.evaluate((id) => {
        const c = document.querySelector(`.card[data-id="${id}"]`)!;
        const code = c.querySelector(".code") as HTMLElement, src = c.querySelector(".src") as HTMLElement;
        const sp = document.createElement("span"); sp.textContent = "x".repeat(100); sp.style.position = "absolute"; src.appendChild(sp);
        const ch = sp.getBoundingClientRect().width / 100; sp.remove();
        const cs = getComputedStyle(code), hd = c.querySelector(".chead") as HTMLElement;
        return { ch: +ch.toFixed(3), fs: cs.fontSize, lh: cs.lineHeight, pad: `${cs.paddingTop}/${cs.paddingBottom}`, head: hd?.getBoundingClientRect().height, srcLeft: src.getBoundingClientRect().left - code.getBoundingClientRect().left, font: cs.fontFamily.split(",")[0], need: Math.round(c.scrollHeight), have: Math.round(c.getBoundingClientRect().height) };
      }, b.cards[0].id);
      rows.push({ theme, ...m });
      await close(h);
    }
    console.table(rows);
  },
  /** 定了高度的代码卡：换主题后看到的代码区高度不变 */
  async v15themefit() {
    const out: Record<string, number> = {};
    for (const theme of ["warm-ink", "classic", "soft-light", "colorful", "newspaper", "poster", "drafting", "graphite"]) {
      const b = richBoard();
      b.place[b.cards[1].id].h = 200;
      const h = await open({ board: b, light, w: 1500, h: 950, settings: { theme } as any });
      await h.page.waitForTimeout(400);
      out[theme] = await h.page.locator(`.card[data-id="${b.cards[1].id}"] .cbody`).evaluate((e) => Math.round(e.getBoundingClientRect().height));
      await close(h);
    }
    const v = Object.values(out);
    console.log(Math.max(...v) - Math.min(...v) <= 6 ? "PASS" : "FAIL", "theme-fit", JSON.stringify(out));
  },
  /** 定义预览：鼠标离开后关掉（e2e 第 5 步的走法） */
  async v15peekleave() {
    const b = emptyBoard("b1", "v0.1.5");
    const sch = card("Scheduler.schedule"); put(b, sch, 200, 80, 560); b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light, w: 1300, h: 900 });
    await h.page.locator(".card .src .call", { hasText: /^can_allocate$/ }).first().hover(); await h.page.waitForTimeout(2500);
    const shown = await h.page.locator(".pop.k-peek").count();
    await h.page.mouse.move(5, 500); await h.page.waitForTimeout(800);
    const after = await h.page.locator(".pop.k-peek").count();
    await shot(h, "v15-peekleave");
    console.log(shown === 1 && after === 0 ? "PASS" : "FAIL", "peek-leave", JSON.stringify({ shown, after }));
    await close(h);
  },
  /** Warm Ink：子卡在右上方、横向很近时箭头的样子（截图看） */
  async v15arrowup() {
    const b = richBoard();
    b.place[b.cards[0].id] = { ...b.place[b.cards[0].id], x: 80, y: 420 };
    b.place[b.cards[1].id] = { ...b.place[b.cards[1].id], x: 760, y: 40 };
    b.place[b.cards[2].id] = { ...b.place[b.cards[2].id], x: 760, y: 900 };
    const h = await open({ board: b, light: true, w: 1500, h: 950 });
    await shot(h, "v15-arrowup");
    await close(h);
  },
  /** 换主题后卡变高：被压住的卡往下推（一步可撤销）；设置成 overlap 时不动 */
  async v15reflow() {
    const base = richBoard();
    let h = await open({ board: base, light, w: 1500, h: 950 });
    const r0 = (await h.page.locator(`.card[data-id="${base.cards[0].id}"]`).boundingBox())!;
    await close(h);
    const y0 = Math.round(r0.y + r0.height + 20); // cam = (0,0,1)：屏幕坐标就是白板坐标
    const res: any = {};
    for (const mode of ["push", "overlap"] as const) {
      const b = richBoard();
      const st = b.cards[0].id, post = b.cards[2].id;
      b.place[post] = { ...b.place[post], x: 80, y: y0 };
      h = await open({ board: b, light, w: 1500, h: 950, settings: { themeReflow: mode } as any });
      await h.page.keyboard.press("Control+,"); await h.page.waitForTimeout(500);
      await h.page.locator(".st-sw", { hasText: "Colorful" }).click(); await h.page.waitForTimeout(400);
      await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(1400);
      const y1 = h.board().place[post].y;
      const a = (await h.page.locator(`.card[data-id="${st}"]`).boundingBox())!, p = (await h.page.locator(`.card[data-id="${post}"]`).boundingBox())!;
      res[mode] = { y1, overlap: a.y + a.height > p.y };
      if (mode === "push") await shot(h, "v15-reflow");
      await close(h);
    }
    const ok = res.push.y1 > y0 && !res.push.overlap && res.overlap.y1 === y0;
    console.log(ok ? "PASS" : "FAIL", "theme-reflow", JSON.stringify({ y0, res }));
  },
  /** ⌘C 一张卡再 ⌘V：新卡放在原卡旁边（错开 36，允许重叠），不去找空地 */
  async v15pastenear() {
    const b = richBoard();
    const st = b.cards[0] as CodeCard;
    const h = await open({ board: b, light, w: 1500, h: 950 });
    await h.page.locator(`.card[data-id="${st.id}"] .chead .ctitle`).click(); await h.page.waitForTimeout(200);
    await h.page.keyboard.press("Control+c"); await h.page.waitForTimeout(200);
    await h.page.mouse.move(1300, 800);
    const text = st.segments[0].text.join("\n");
    await h.page.evaluate((t) => { const dt = new DataTransfer(); dt.setData("text/plain", t); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); }, text);
    await h.page.waitForTimeout(1400);
    const nb = h.board(), p0 = nb.place[st.id];
    const nid = nb.cards.find((c) => !b.cards.some((o) => o.id === c.id))?.id;
    const p1 = nid ? nb.place[nid] : undefined;
    await shot(h, "v15-pastenear");
    const ok = !!p1 && p1.x === p0.x + 36 && p1.y === p0.y + 36;
    console.log(ok ? "PASS" : "FAIL", "paste-near", JSON.stringify({ p0, p1 }));
    await close(h);
  },
  /** 线上的变量框能沿线拖，位置存成 t */
  async v15labeldrag() {
    const b = richBoard();
    const h = await open({ board: b, light, w: 1500, h: 950 });
    const box = h.page.locator('.vchips[data-link="L2"]');
    const r0 = (await box.boundingBox())!;
    await h.page.mouse.move(r0.x + 10, r0.y + 8); await h.page.mouse.down(); await h.page.mouse.move(r0.x + 10, r0.y + 120, { steps: 8 }); await h.page.mouse.up(); await h.page.waitForTimeout(1300);
    const r1 = (await box.boundingBox())!;
    const at = (h.board().links.find((l) => l.id === "L2") as any).at;
    await shot(h, "v15-labeldrag");
    console.log(at !== undefined && Math.abs(r1.y - r0.y) > 40 ? "PASS" : "FAIL", "label-drag", JSON.stringify({ at, dy: r1.y - r0.y }));
    await close(h);
  },
};
