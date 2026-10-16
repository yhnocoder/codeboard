// 白板交互场景：每个场景开一个白板、做一串操作、截图。
import { ready, open, shot, symCard, findSym, viewOf, put, type Host } from "./harness";
import { emptyBoard, type Board } from "@codeboard/core";
import { WEB } from "./scenarios-web";

const light = process.argv.includes("--light");
const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function boardWith(...quals: string[]): Board {
  const b = emptyBoard("b1", "nano-vllm · generate 主流程");
  let x = 80;
  for (const q of quals) { const s = findSym(q); const c = symCard(s.f, s.s); put(b, c, x, 80); x += 640; }
  return b;
}
const callEl = (h: Host, name: string, nth = 0) => h.page.locator(`.card .src .call:text-is("${name}")`).nth(nth);

const S: Record<string, () => Promise<void>> = {
  ...WEB,
  async basic() {
    const h = await open({ board: boardWith("LLMEngine.step"), light });
    await shot(h, "01-start");
    await callEl(h, "schedule").click();
    await h.page.waitForTimeout(900);
    await shot(h, "02-expanded");
    await callEl(h, "postprocess").click();
    await h.page.waitForTimeout(900);
    await shot(h, "03-two");
    console.log("cards:", h.board().cards.length, "links:", h.board().links.length);
    await h.page.context().browser()!.close();
  },
  async flow() {
    const h = await open({ board: boardWith("LLMEngine.step"), light });
    await callEl(h, "schedule").click(); await h.page.waitForTimeout(700);
    await shot(h, "flow-00");
    await callEl(h, "postprocess").first().click({ timeout: 5000 }); await h.page.waitForTimeout(700);
    const pos = () => JSON.stringify(h.board().cards.map((c: any) => [c.segments?.[0]?.symbol?.qual, h.board().place[c.id]?.x, h.board().place[c.id]?.y]));
    await h.page.waitForTimeout(1200); console.log(pos());
    await h.page.locator(".card .src .call", { hasText: "allocate" }).first().click();
    await h.page.waitForTimeout(1200); console.log(pos(), JSON.stringify(h.board().links.map((l) => [l.from.card, l.to.card]))); await h.page.waitForTimeout(700);
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(700);
    await shot(h, "flow-01-three");
    await h.page.keyboard.press("Escape");
    await h.page.keyboard.press("p"); await h.page.waitForTimeout(900);
    await shot(h, "flow-02-walk");
    await h.page.keyboard.press("ArrowRight"); await h.page.waitForTimeout(900);
    await shot(h, "flow-03-walk2");
    await h.page.keyboard.press("Escape");
    console.log("cards:", h.board().cards.length, "links:", h.board().links.length);
    await h.page.context().browser()!.close();
  },
  async notes() {
    const h = await open({ board: boardWith("Scheduler.schedule"), light });
    await h.page.locator(".card .no").nth(5).click();
    await h.page.locator(".card .no").nth(7).click({ modifiers: ["Shift"] });
    await shot(h, "notes-01-lines");
    await h.page.keyboard.press("s"); await h.page.waitForTimeout(400);
    await shot(h, "notes-02-add");
    await h.page.locator(".pop button", { hasText: /^Text$/ }).click();
    await h.page.locator(".pop textarea, .pop [contenteditable]").first().click();
    await h.page.keyboard.type("Prefill admits waiting seqs until the token budget runs out.");
    await h.page.locator(".pop button", { hasText: /^Add$/ }).click();
    await h.page.waitForTimeout(400);
    await shot(h, "notes-03-done");
    await h.page.mouse.move(1300, 800);
    await h.page.keyboard.press("n"); await h.page.waitForTimeout(300);
    await h.page.keyboard.type("# Why chunked prefill\nKeeps $O(n)$ memory **bounded**.");
    await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(300);
    await h.page.mouse.click(1300, 500);
    await shot(h, "notes-04-note");
    console.log("cards:", h.board().cards.map((c) => c.kind).join(","), "sidenotes:", JSON.stringify((h.board() as any).sidenotes));
    await h.page.locator(".card .mk").first().hover(); await h.page.waitForTimeout(600);
    await shot(h, "notes-05-hover");
    await h.page.context().browser()!.close();
  },
  async sections() {
    const b = boardWith("LLMEngine.step", "Scheduler.schedule");
    const h = await open({ board: b, light });
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(600);
    const r = await h.page.locator(".card").first().boundingBox();
    await h.page.locator(".bbar button", { hasText: "Section" }).click();
    await h.page.mouse.move(r!.x - 40, r!.y - 60); await h.page.mouse.down();
    await h.page.mouse.move(r!.x + r!.width + 30, r!.y + r!.height + 40, { steps: 8 }); await h.page.mouse.up();
    await h.page.waitForTimeout(400);
    await h.page.keyboard.type("Engine"); await h.page.keyboard.press("Enter");
    await h.page.locator(".bbar button", { hasText: "Section" }).click();
    await h.page.mouse.move(r!.x - 80, r!.y - 120); await h.page.mouse.down();
    await h.page.mouse.move(1350, 820, { steps: 8 }); await h.page.mouse.up();
    await h.page.waitForTimeout(300);
    await h.page.keyboard.type("Generate step"); await h.page.keyboard.press("Enter");
    await h.page.waitForTimeout(400);
    await shot(h, "sec-01-nested");
    console.log(JSON.stringify(h.board().sections.map((s) => [s.name, s.parent ?? null])), JSON.stringify(h.board().cards.map((c) => h.board().place[c.id]?.section ?? null)));
    await h.page.context().browser()!.close();
  },
  async compare() {
    const h = await open({ board: boardWith("Scheduler.schedule", "Scheduler.postprocess"), light });
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(500);
    await h.page.keyboard.press("Control+a"); await h.page.keyboard.press("Meta+a");
    await h.page.locator(".card").first().locator(".chead").click({ button: "right" });
    await h.page.waitForTimeout(200);
    await shot(h, "cmp-01-menu");
    await h.page.locator(".ctx button", { hasText: "Compare" }).first().click();
    await h.page.waitForTimeout(900);
    await shot(h, "cmp-02-compare");
    console.log("kinds:", h.board().cards.map((c) => c.kind).join(","));
    await h.page.context().browser()!.close();
  },
  async versions() {
    const b = boardWith("Scheduler.schedule");
    const h = await open({ board: b, light });
    const seg = (b.cards[0] as any).segments[0].id;
    await h.post({ type: "stale", stale: { [seg]: { state: "changed", hiddenOnly: false, head: "f64d8210" } } } as any);
    await h.page.waitForTimeout(400);
    await shot(h, "ver-01-stale");
    await h.page.locator(".banner button", { hasText: "Review" }).click();
    await h.page.waitForTimeout(1200);
    await shot(h, "ver-02-diff");
    console.log(await h.page.evaluate(() => [...document.querySelectorAll(".pop, .pop .diffpop, .pop .dbody, .pop .crows, .pop .db")].map((e) => { const r = e.getBoundingClientRect(); return e.className + " " + Math.round(r.x) + " " + Math.round(r.width) + " " + getComputedStyle(e).width; }).join("\n")));
    await h.page.locator(".pop button", { hasText: /^Update/ }).first().click();
    await h.page.waitForTimeout(600);
    await shot(h, "ver-03-updated");
    console.log("version:", JSON.stringify((h.board().cards[0] as any).segments[0].version));
    await h.page.context().browser()!.close();
  },
  async lost() {
    const b = boardWith("Scheduler.schedule", "Scheduler.postprocess");
    const h = await open({ board: b, light });
    const [s1, s2] = b.cards.map((c: any) => c.segments[0].id);
    await h.post({ type: "stale", stale: { [s1]: { state: "lost" }, [s2]: { state: "changed", hiddenOnly: false, head: "f64d8210" } } } as any);
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(600);
    await shot(h, "lost-01");
    await h.page.locator(".banner button", { hasText: "Update All" }).click(); await h.page.waitForTimeout(800);
    await h.page.locator(".cmiss button", { hasText: "Keep Old Version" }).click(); await h.page.waitForTimeout(500);
    await shot(h, "lost-02");
    console.log("banner:", await h.page.locator(".banner").count(), "cmiss:", await h.page.locator(".cmiss").count(), JSON.stringify(h.board().cards.map((c: any) => [c.keepOld ?? null, c.segments[0].version.commit])));
    await h.page.context().browser()!.close();
  },
  async misc() {
    const h = await open({ board: boardWith("Scheduler.schedule", "Scheduler.postprocess"), light });
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(500);
    // Plain link：选两张卡，点 Link
    await h.page.keyboard.press("Control+a");
    await h.page.locator(".bbar button", { hasText: "Link" }).click(); await h.page.waitForTimeout(400);
    // Text：双击空白处
    await h.page.mouse.dblclick(700, 120); await h.page.waitForTimeout(300);
    await h.page.keyboard.type("Scheduler overview"); await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(300);
    await shot(h, "misc-01");
    // 合并：⌥ 拖第二张卡的标题到第一张标题上
    const heads = h.page.locator(".card.ccard .chead");
    const a = await heads.nth(0).boundingBox(), b = await heads.nth(1).boundingBox();
    await h.page.mouse.move(b!.x + 60, b!.y + 10); await h.page.mouse.down();
    await h.page.keyboard.down("Alt");
    await h.page.mouse.move(a!.x + 80, a!.y + 12, { steps: 12 }); await h.page.waitForTimeout(200);
    await h.page.mouse.up(); await h.page.keyboard.up("Alt"); await h.page.waitForTimeout(700);
    await shot(h, "misc-02-merged");
    console.log("kinds:", h.board().cards.map((c: any) => c.kind + (c.segments ? ":" + c.segments.length : "")).join(","), "links:", JSON.stringify(h.board().links.map((l) => [l.kind, l.from.card, l.to.card])));
    // Section 并折叠
    await h.page.keyboard.press("Control+a");
    await h.page.locator(".card.ccard .chead").first().click({ button: "right" }); await h.page.waitForTimeout(200);
    await h.page.locator(".ctx button", { hasText: "Move to New Section" }).first().click().catch(() => console.log("no Move to New Section"));
    await h.page.waitForTimeout(300); await h.page.keyboard.type("Scheduler"); await h.page.keyboard.press("Enter");
    await h.page.waitForTimeout(400);
    await shot(h, "misc-03-section");
    console.log("sections:", JSON.stringify(h.board().sections.map((q) => [q.title, q.collapsed ?? false])));
    await h.page.context().browser()!.close();
  },
  // 回归：Compare 的两栏不能被展开 / 连线拆到两棵树里
  async cmptree() {
    const h = await open({ board: boardWith("LLMEngine.step", "Scheduler.schedule"), light });
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(400);
    await h.page.keyboard.press("Control+a");
    await h.page.locator(".card.ccard .chead").first().click({ button: "right" }); await h.page.waitForTimeout(200);
    await h.page.locator(".ctx button", { hasText: "Compare" }).first().click(); await h.page.waitForTimeout(800);
    await h.page.locator(".card .call", { hasText: /^schedule$/ }).first().click(); await h.page.waitForTimeout(800);
    await h.page.keyboard.press("Escape");
    await h.page.locator(".card .call", { hasText: /^can_allocate$/ }).first().click(); await h.page.waitForTimeout(800);
    const toast = await h.page.locator(".toast").textContent().catch(() => "");
    const roots = new Set(h.board().links.filter((l) => l.kind === "call").map((l) => l.from.card));
    const b = h.board(); const cmp = b.cards.find((c) => c.kind === "compare") as any;
    const ok = b.links.filter((l) => l.kind === "call").length === 1 && /one flow/.test(toast ?? "");
    console.log(ok ? "PASS" : "FAIL", "cmptree", JSON.stringify({ links: b.links.length, roots: [...roots], cols: cmp?.cols, toast }));
    await shot(h, "cmptree");
    await h.page.context().browser()!.close();
  },
  // 回归：删 Link / 删卡也不能把 Compare 的两栏拆到两棵树里（R → X → cl，R → Y → cr）
  async cmpdel() {
    const b = boardWith("LLMEngine.step", "Scheduler.schedule", "Scheduler.postprocess");
    const [R, X, Y] = b.cards as any[];
    const P = b.place; P[X.id].x = P[R.id].x + 56; P[X.id].y = 700; P[Y.id].x = P[R.id].x + 56; P[Y.id].y = 1300;
    const cl = symCard(findSym("BlockManager.can_allocate").f, findSym("BlockManager.can_allocate").s);
    const cr = symCard(findSym("BlockManager.allocate").f, findSym("BlockManager.allocate").s);
    b.cards.push(cl, cr, { id: "k", kind: "compare", cols: [cl.id, cr.id] });
    b.place.k = { x: 1400, y: 700, w: 900 };
    const ln = (c: any, d: number) => c.segments[0].start + d;
    const call = (id: string, f: any, line: number, t: any) => ({ id, kind: "call", from: { card: f.id, seg: f.segments[0].id, line }, to: { card: t.id } });
    b.links.push(call("RX", R, ln(R, 2), X) as any, call("RY", R, ln(R, 4), Y) as any, call("Xcl", X, ln(X, 3), cl) as any, call("Ycr", Y, ln(Y, 3), cr) as any);
    const h = await open({ board: b, light });
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(500);
    const toast = () => h.page.locator(".toast").textContent().catch(() => "");
    // 删共同的祖先卡
    await h.page.locator(".card", { has: h.page.locator(".ctitle", { hasText: /^LLMEngine\.step$/ }) }).locator(".chead").click({ position: { x: 40, y: 10 } });
    await h.page.waitForTimeout(100);
    await h.page.keyboard.press("Delete"); await h.page.waitForTimeout(300);
    const t1 = await toast();
    await shot(h, "cmpdel-0");
    // 删 R → X 这条线（右键菜单）
    await h.page.keyboard.press("Escape");
    await h.page.waitForTimeout(2800); // 等上一个提示消失
    await h.page.locator('path.lhit[data-link="RX"]').dispatchEvent("pointerdown", { button: 0 });
    await h.page.keyboard.press("Delete"); await h.page.waitForTimeout(300);
    const t2 = await toast();
    await h.page.waitForTimeout(1300);
    const nb = h.board();
    const ok = nb.cards.length === 6 && nb.links.length === 4 && /one flow/.test(t1 ?? "") && /one flow/.test(t2 ?? "");
    console.log(ok ? "PASS" : "FAIL", "cmpdel", JSON.stringify({ cards: nb.cards.length, links: nb.links.map((l) => l.id), t1, t2 }));
    await shot(h, "cmpdel");
    await h.page.context().browser()!.close();
  },
  // 回归：Relocate 换段、HEAD 下段挪了位置：Link 两端、Sidenote、隐藏行跟着走；挪位置不进撤销栈
  async rebase() {
    const b = boardWith("Scheduler.schedule", "Scheduler.postprocess");
    const [A, B] = b.cards as any[];
    const sa = A.segments[0], sb = B.segments[0];
    sa.hidden = [[sa.start + 8, sa.start + 9]];
    b.links.push({ id: "L", kind: "plain", from: { card: B.id, seg: sb.id, line: sb.start + 2 }, to: { card: A.id, seg: sa.id, line: sa.start + 3 } } as any);
    b.sidenotes.push({ id: "n1", kind: "text", md: "x", at: { card: B.id, seg: sb.id, lines: [sb.start + 2, sb.start + 2] } } as any);
    const h = await open({ board: b, light });
    // A 整体下移 5 行（HEAD 变了，内容没变）
    await h.post({ type: "stale", stale: { [sa.id]: { state: "moved", start: sa.start + 5, end: sa.end + 5 } } } as any);
    await h.page.waitForTimeout(300);
    // B 被 Relocate 到下移 7 行的位置（同样内容）
    await h.post({ type: "replaceSegment", card: B.id, seg: { ...sb, start: sb.start + 7, end: sb.end + 7 }, view: viewOf(sb) } as any);
    await h.page.waitForTimeout(300);
    await h.page.keyboard.press("Control+z"); await h.page.keyboard.press("Meta+z"); // 只撤掉 Relocate；挪位置不该被撤
    await h.page.waitForTimeout(1300);
    const nb = h.board() as any, L = nb.links[0], na = nb.cards[0].segments[0], nbs = nb.cards[1].segments[0];
    const ok = na.start === sa.start + 5 && JSON.stringify(na.hidden) === JSON.stringify([[sa.start + 13, sa.start + 14]]) && L.to.line === sa.start + 8
      && nbs.start === sb.start && L.from.line === sb.start + 2 && nb.sidenotes[0].at.lines[0] === sb.start + 2;
    // 再做一次 Relocate（不撤销）：Link 起点和 Sidenote 跟到新行
    await h.post({ type: "replaceSegment", card: B.id, seg: { ...sb, start: sb.start + 7, end: sb.end + 7 }, view: viewOf(sb) } as any);
    await h.page.waitForTimeout(1300);
    const nb2 = h.board() as any;
    const ok2 = nb2.links[0].from.line === sb.start + 9 && nb2.sidenotes[0].at.lines[0] === sb.start + 9;
    console.log(ok && ok2 ? "PASS" : "FAIL", "rebase", JSON.stringify({ aStart: na.start - sa.start, hidden: na.hidden?.[0]?.map((x: number) => x - sa.start), to: L.to.line - sa.start, bAfterUndo: nbs.start - sb.start, from: nb2.links[0].from.line - sb.start, note: nb2.sidenotes[0].at.lines[0] - sb.start }));
    await h.page.context().browser()!.close();
  },
  // 回归：Update 后 Sidenote 和高亮跟着改过的行走，不当成删掉
  async follow() {
    const b = boardWith("Scheduler.schedule");
    const c = b.cards[0] as any, s0 = c.segments[0];
    s0.hl = [s0.start + 3, s0.start + 6];
    s0.hidden = [[s0.start + 8, s0.start + 9]];
    b.sidenotes.push({ id: "n1", kind: "text", md: "on the edited line", at: { card: c.id, seg: s0.id, lines: [s0.start + 3, s0.start + 3] } } as any);
    const h = await open({ board: b, light });
    await h.post({ type: "stale", stale: { [s0.id]: { state: "changed", hiddenOnly: false, head: "f64d8210" } } } as any);
    await h.page.waitForTimeout(300);
    await h.page.locator(".banner button", { hasText: "Update All" }).click(); await h.page.waitForTimeout(900);
    const nb = h.board() as any, ns = nb.cards[0].segments[0], n = nb.sidenotes[0];
    const ok = JSON.stringify(n.at.lines) === JSON.stringify([s0.start + 3, s0.start + 3]) && !n.lineRemoved && JSON.stringify(ns.hl) === JSON.stringify(s0.hl) && JSON.stringify(ns.hidden) === JSON.stringify(s0.hidden);
    console.log(ok ? "PASS" : "FAIL", "follow", JSON.stringify({ at: n.at, removed: n.lineRemoved ?? false, hl: ns.hl, hidden: ns.hidden, version: ns.version.commit }));
    await h.page.context().browser()!.close();
  },
  // 回归：先画内框、再画外框，外框是父级
  async secout() {
    const h = await open({ board: boardWith("LLMEngine.step"), light });
    const r = await h.page.locator(".card").first().boundingBox();
    const draw = async (pad: number, name: string) => {
      await h.page.locator(".bbar button", { hasText: "Section" }).click();
      await h.page.mouse.move(r!.x - pad, r!.y - pad - 20); await h.page.mouse.down();
      await h.page.mouse.move(r!.x + r!.width + pad, r!.y + r!.height + pad, { steps: 8 }); await h.page.mouse.up();
      await h.page.waitForTimeout(300); await h.page.keyboard.type(name); await h.page.keyboard.press("Enter"); await h.page.waitForTimeout(300);
    };
    await draw(30, "Inner"); await draw(90, "Outer"); await h.page.waitForTimeout(1200); // 等自动保存
    const ss = h.board().sections, inner = ss.find((q) => q.title === "Inner")!, outer = ss.find((q) => q.title === "Outer")!;
    const ok = inner.parent === outer.id && !outer.parent && h.board().place[h.board().cards[0].id]?.section === inner.id;
    console.log(ok ? "PASS" : "FAIL", "secout", JSON.stringify(ss.map((q) => [q.title, q.parent ? ss.find((x) => x.id === q.parent)!.title : null]).concat([["card", h.board().place[h.board().cards[0].id]?.section === inner.id ? "Inner" : "?"]])));
    await shot(h, "secout");
    await h.page.context().browser()!.close();
  },
  // 回归：Walkthrough 展开折叠的子树不写进白板
  async walkview() {
    const h = await open({ board: boardWith("LLMEngine.step"), light });
    await h.page.locator(".card .src .call", { hasText: /^schedule$/ }).first().click(); await h.page.waitForTimeout(700);
    const root = h.board().cards[0].id;
    await h.page.locator(".card").first().locator(".chead").click({ button: "right" }); await h.page.waitForTimeout(200);
    await h.page.locator(".ctx button", { hasText: /Collapse/ }).first().click(); await h.page.waitForTimeout(1500);
    const before = JSON.stringify(h.board());
    await h.page.keyboard.press("Escape"); await h.page.keyboard.press("p"); await h.page.waitForTimeout(600);
    const shown = await h.page.locator(".card").count();
    await h.page.keyboard.press("ArrowRight"); await h.page.waitForTimeout(1600);
    const during = JSON.stringify(h.board());
    await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(1600);
    const after = JSON.stringify(h.board()), hidden = await h.page.locator(".card").count();
    const strip = (j: string) => { const o = JSON.parse(j); delete o.cam; return JSON.stringify(o); };
    const ok = shown === 2 && hidden === 1 && strip(before) === strip(during) && strip(before) === strip(after) && (JSON.parse(after).place[root]?.collapsed === true);
    console.log(ok ? "PASS" : "FAIL", "walkview", JSON.stringify({ shown, hidden, savedChanged: strip(before) !== strip(during) }));
    await h.page.context().browser()!.close();
  },
  async palette() {
    const h = await open({ board: boardWith("LLMEngine.step"), light });
    await h.page.keyboard.press("Control+k"); await h.page.keyboard.press("Meta+k");
    await h.page.waitForTimeout(300);
    await shot(h, "pal-01-entry");
    await h.page.keyboard.type("alloc"); await h.page.waitForTimeout(400);
    await shot(h, "pal-02-query");
    await h.page.keyboard.press("Enter"); await h.page.waitForTimeout(900);
    await shot(h, "pal-03-placed");
    console.log("cards:", h.board().cards.length);
    await h.page.context().browser()!.close();
  },
  async peek() {
    const h = await open({ board: boardWith("Scheduler.schedule"), light });
    await h.page.locator(".card .src .call", { hasText: "can_allocate" }).first().hover();
    await h.page.waitForTimeout(1200);
    await shot(h, "peek-01");
    await h.page.context().browser()!.close();
  },
};

(async () => {
  await ready();
  for (const n of names.length ? names : Object.keys(S)) { console.log("▶", n); await S[n](); }
})().catch((e) => { console.error(e); process.exit(1); });
