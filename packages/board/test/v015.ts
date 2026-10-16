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
    const l = h.page.locator(".card").first().locator(".src .l").nth(5);
    await l.click({ position: { x: 40, y: 8 } }); await h.page.waitForTimeout(200);
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
};
