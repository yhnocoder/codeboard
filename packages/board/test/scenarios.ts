// Board interaction scenarios: each one opens a board, performs a series of actions, and takes screenshots.
import { ready, open, shot, symCard, findSym, viewOf, put, type Host } from "./harness";
import { emptyBoard, putShared, type Board } from "@codeboard/core";
import { V015 } from "./v015";
import { WEB } from "./scenarios-web";
import { V017 } from "./v017";
import { V017LABELS } from "./v017labels";
import { V017STACK } from "./v017stack";
import { THEMES_V17 } from "./scenarios-themes";
import { V018MD } from "./v018md";
import { CODEEDIT } from "./scenarios-codeedit";
import { V018TYPE } from "./v018type";
import { V018TYPESEQ } from "./v018typeseq";
import { V018REVIEW } from "./v018review";
import { SHARED } from "./scenarios-shared";
import { SUBBOARDS } from "./scenarios-subboards";
import { CHAINS } from "./scenarios-chains";
import { CALLS } from "./scenarios-calls";
import { QUESTIONS } from "./scenarios-questions";
import { VARIANTS } from "./scenarios-variants";
import { FIXQ } from "./scenarios-fixq";
import { HEADER } from "./scenarios-header";
import { NOTE_EDITING } from "./scenarios-note-editing";
import { CODE_CARDS } from "./scenarios-code-cards";
import { BOARDS } from "./scenarios-boards";
import { UX } from "./scenarios-ux";

const light = process.argv.includes("--light");
const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function boardWith(...quals: string[]): Board {
  const b = emptyBoard("b1", "nano-vllm · generate main flow");
  let x = 80;
  for (const q of quals) { const s = findSym(q); const c = symCard(s.f, s.s); put(b, c, x, 80); x += 640; }
  return b;
}
const callEl = (h: Host, name: string, nth = 0) => h.page.locator(`.card .src .call:text-is("${name}")`).nth(nth);

const S: Record<string, () => Promise<void>> = {
  ...V015,
  ...WEB,
  ...V017,
  ...V017LABELS,
  ...V017STACK,
  ...THEMES_V17,
  ...V018MD,
  ...CODEEDIT,
  /** 旧名字：v0.1.8 的 textarea 编辑换成 CodeMirror 后由 codeedit 接着查 */
  v18codeedit: () => CODEEDIT.codeedit(),
  ...V018TYPE,
  ...V018TYPESEQ,
  ...V018REVIEW,
  ...SHARED,
  ...SUBBOARDS,
  ...BOARDS,
  ...CHAINS,
  ...CALLS,
  ...QUESTIONS,
  ...VARIANTS,
  ...FIXQ,
  ...HEADER,
  ...NOTE_EDITING,
  ...CODE_CARDS,
  ...UX,
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
    await h.page.locator(".bbar button[aria-label=\"Section\"]").click();
    await h.page.mouse.move(r!.x - 40, r!.y - 60); await h.page.mouse.down();
    await h.page.mouse.move(r!.x + r!.width + 30, r!.y + r!.height + 40, { steps: 8 }); await h.page.mouse.up();
    await h.page.waitForTimeout(400);
    await h.page.keyboard.type("Engine"); await h.page.keyboard.press("Enter");
    await h.page.locator(".bbar button[aria-label=\"Section\"]").click();
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
    // Unified: switching turns it into a single-column diff (previously rows weren't redrawn and stayed side by side)
    await h.page.locator(".cmpwrap .tools button", { hasText: "Unified" }).click(); await h.page.waitForTimeout(500);
    const u = { urow: await h.page.locator(".cmpwrap .urow").count(), crow: await h.page.locator(".cmpwrap .crow").count() };
    await shot(h, "cmp-03-unified");
    console.log(u.urow > 0 && u.crow === 0 ? "PASS" : "FAIL", "compare-unified", JSON.stringify(u));
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
    // Arrow: select two cards, click Link
    await h.page.keyboard.press("Control+a");
    await h.page.locator(".bbar button[aria-label=\"Arrow\"]").click(); await h.page.waitForTimeout(400);
    // Text: double-click empty space
    await h.page.mouse.dblclick(700, 120); await h.page.waitForTimeout(300);
    await h.page.keyboard.type("Scheduler overview"); await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(300);
    await shot(h, "misc-01");
    // Merge: ⌥-drag the second card's title onto the first card's title
    const heads = h.page.locator(".card.ccard .chead");
    const a = await heads.nth(0).boundingBox(), b = await heads.nth(1).boundingBox();
    await h.page.mouse.move(b!.x + 60, b!.y + 10); await h.page.mouse.down();
    await h.page.keyboard.down("Alt");
    await h.page.mouse.move(a!.x + 80, a!.y + 12, { steps: 12 }); await h.page.waitForTimeout(200);
    await h.page.mouse.up(); await h.page.keyboard.up("Alt"); await h.page.waitForTimeout(700);
    await shot(h, "misc-02-merged");
    console.log("kinds:", h.board().cards.map((c: any) => c.kind + (c.segments ? ":" + c.segments.length : "")).join(","), "links:", JSON.stringify(h.board().links.map((l) => [l.kind, l.from.card, l.to.card])));
    // Section, then collapse
    await h.page.keyboard.press("Control+a");
    await h.page.locator(".card.ccard .chead").first().click({ button: "right" }); await h.page.waitForTimeout(200);
    await h.page.locator(".ctx button", { hasText: "Move to New Section" }).first().click().catch(() => console.log("no Move to New Section"));
    await h.page.waitForTimeout(300); await h.page.keyboard.type("Scheduler"); await h.page.keyboard.press("Enter");
    await h.page.waitForTimeout(400);
    await shot(h, "misc-03-section");
    console.log("sections:", JSON.stringify(h.board().sections.map((q) => [q.title, q.collapsed ?? false])));
    await h.page.context().browser()!.close();
  },
  // v0.1.7: the Compare one-flow rule is gone: each column can expand into its own call graph, and the Compare shows both marks
  async cmptree() {
    const h = await open({ board: boardWith("LLMEngine.step", "Scheduler.schedule"), light });
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(400);
    await h.page.keyboard.press("Control+a");
    await h.page.locator(".card.ccard .chead").first().click({ button: "right" }); await h.page.waitForTimeout(200);
    await h.page.locator(".ctx button", { hasText: "Compare" }).first().click(); await h.page.waitForTimeout(800);
    await h.page.locator(".card .call", { hasText: /^schedule$/ }).first().click(); await h.page.waitForTimeout(800);
    await h.page.keyboard.press("Escape");
    await h.page.locator(".card .call", { hasText: /^can_allocate$/ }).first().click(); await h.page.waitForTimeout(1600);
    const b = h.board(); const cmp = b.cards.find((c) => c.kind === "compare") as any;
    const marks = await h.page.locator(".card.cmp .chead .step").allTextContents();
    const ok = b.links.filter((l) => l.call).length === 2 && marks.length === 2 && new Set(marks).size === 2;
    console.log(ok ? "PASS" : "FAIL", "cmptree", JSON.stringify({ links: b.links.length, cols: cmp?.cols, marks }));
    await shot(h, "cmptree");
    await h.page.context().browser()!.close();
  },
  // v0.1.7: deleting a link or card under a Compare is no longer refused (R → X → cl, R → Y → cr); the columns end up in two graphs
  async cmpdel() {
    const b = boardWith("LLMEngine.step", "Scheduler.schedule", "Scheduler.postprocess");
    const [R, X, Y] = b.cards as any[];
    const P = b.place; P[X.id].x = P[R.id].x + 56; P[X.id].y = 700; P[Y.id].x = P[R.id].x + 56; P[Y.id].y = 1300;
    const cl = symCard(findSym("BlockManager.can_allocate").f, findSym("BlockManager.can_allocate").s);
    const cr = symCard(findSym("BlockManager.allocate").f, findSym("BlockManager.allocate").s);
    b.cards.push(cl, cr, { id: "k", kind: "compare", cols: [cl.id, cr.id] });
    b.place.k = { x: 1400, y: 700, w: 900 };
    const ln = (c: any, d: number) => c.segments[0].start + d;
    const call = (id: string, f: any, line: number, t: any) => ({ id, from: { card: f.id, seg: f.segments[0].id, line }, to: { card: t.id }, call: { name: "f", col: 0 } });
    b.links.push(call("RX", R, ln(R, 2), X), call("RY", R, ln(R, 4), Y), call("Xcl", X, ln(X, 3), cl), call("Ycr", Y, ln(Y, 3), cr));
    const h = await open({ board: b, light });
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(500);
    const marks0 = await h.page.locator(".card.cmp .chead .step").allTextContents();
    // Delete the R → X link, then the common ancestor card
    await h.page.locator('path.lhit[data-link="RX"]').dispatchEvent("pointerdown", { button: 0 });
    await h.page.keyboard.press("Delete"); await h.page.waitForTimeout(300);
    await h.page.locator(".card", { has: h.page.locator(".ctitle", { hasText: /^LLMEngine\.step$/ }) }).locator(".chead").click({ position: { x: 40, y: 10 } });
    await h.page.waitForTimeout(100);
    await h.page.keyboard.press("Delete"); await h.page.waitForTimeout(1600);
    const nb = h.board();
    const marks = await h.page.locator(".card.cmp .chead .step").allTextContents();
    const ok = nb.cards.length === 5 && nb.links.map((l) => l.id).join() === "Xcl,Ycr" && marks0.join() === "A,A" && new Set(marks).size === 2;
    console.log(ok ? "PASS" : "FAIL", "cmpdel", JSON.stringify({ cards: nb.cards.length, links: nb.links.map((l) => l.id), marks0, marks }));
    await shot(h, "cmpdel");
    await h.page.context().browser()!.close();
  },
  // Regression: Relocate changes the snippet, or the snippet moved at HEAD: Link endpoints, Sidenotes and hidden lines follow; moves don't go on the undo stack
  async rebase() {
    const b = boardWith("Scheduler.schedule", "Scheduler.postprocess");
    const [A, B] = b.cards as any[];
    const sa = A.segments[0], sb = B.segments[0];
    sa.hidden = [[sa.start + 8, sa.start + 9]];
    b.links.push({ id: "L", from: { card: B.id, seg: sb.id, line: sb.start + 2 }, to: { card: A.id, seg: sa.id, line: sa.start + 3 } } as any);
    b.sidenotes.push({ id: "n1", kind: "text", md: "x", at: { card: B.id, seg: sb.id, lines: [sb.start + 2, sb.start + 2] } } as any);
    const h = await open({ board: b, light });
    // A moves down 5 lines as a whole (HEAD changed, content didn't)
    await h.post({ type: "stale", stale: { [sa.id]: { state: "moved", start: sa.start + 5, end: sa.end + 5, version: sa.version } } });
    await h.page.waitForTimeout(300);
    // B is Relocated 7 lines down (same content)
    await h.post({ type: "replaceSegment", card: B.id, seg: { ...sb, start: sb.start + 7, end: sb.end + 7 }, view: viewOf(sb) } as any);
    await h.page.waitForTimeout(300);
    await h.page.keyboard.press("Control+z"); await h.page.keyboard.press("Meta+z"); // undoes only the Relocate; the move must not be undone
    await h.page.waitForTimeout(1300);
    const nb = h.board() as any, L = nb.links[0], na = nb.cards[0].segments[0], nbs = nb.cards[1].segments[0];
    const ok = na.start === sa.start + 5 && JSON.stringify(na.hidden) === JSON.stringify([[sa.start + 13, sa.start + 14]]) && L.to.line === sa.start + 8
      && nbs.start === sb.start && L.from.line === sb.start + 2 && nb.sidenotes[0].at.lines[0] === sb.start + 2;
    // Relocate again (no undo): Link start and Sidenote follow to the new lines
    await h.post({ type: "replaceSegment", card: B.id, seg: { ...sb, start: sb.start + 7, end: sb.end + 7 }, view: viewOf(sb) } as any);
    await h.page.waitForTimeout(1300);
    const nb2 = h.board() as any;
    const ok2 = nb2.links[0].from.line === sb.start + 9 && nb2.sidenotes[0].at.lines[0] === sb.start + 9;
    console.log(ok && ok2 ? "PASS" : "FAIL", "rebase", JSON.stringify({ aStart: na.start - sa.start, hidden: na.hidden?.[0]?.map((x: number) => x - sa.start), to: L.to.line - sa.start, bAfterUndo: nbs.start - sb.start, from: nb2.links[0].from.line - sb.start, note: nb2.sidenotes[0].at.lines[0] - sb.start }));
    await h.page.context().browser()!.close();
  },
  // Host sync is not an undo step: a change, then a stale "moved" from the host, then ⌘Z undoes the change and the lines stay where the host put them
  async syncundo() {
    const b = boardWith("Scheduler.schedule", "Scheduler.postprocess");
    const [A, B] = b.cards as any[];
    const sa = A.segments[0], name0 = b.name;
    b.links.push({ id: "L", from: { card: B.id }, to: { card: A.id, seg: sa.id, line: sa.start + 3 } } as any);
    b.sidenotes.push({ id: "n1", kind: "text", md: "x", at: { card: A.id, seg: sa.id, lines: [sa.start + 2, sa.start + 2] } } as any);
    const h = await open({ board: b, light });
    await h.post({ type: "rename", name: "Renamed" }); await h.page.waitForTimeout(200);
    await h.post({ type: "stale", stale: { [sa.id]: { state: "moved", start: sa.start + 5, end: sa.end + 5, version: sa.version } } });
    await h.page.waitForTimeout(300);
    await h.page.keyboard.press("Meta+z"); await h.page.waitForTimeout(1300);
    const at = (x: any) => ({ name: x.name, start: x.cards[0].segments[0].start - sa.start, to: x.links[0].to.line - sa.start, note: x.sidenotes[0].at.lines[0] - sa.start });
    const u = at(h.board());
    await h.page.keyboard.press("Meta+Shift+z"); await h.page.waitForTimeout(1300);
    const r = at(h.board());
    await h.page.keyboard.press("Meta+z"); await h.page.keyboard.press("Meta+z"); await h.page.waitForTimeout(1300); // nothing older to undo: the move stays
    const u2 = at(h.board());
    const moved = (x: any) => x.start === 5 && x.to === 8 && x.note === 7;
    const ok = u.name === name0 && moved(u) && r.name === "Renamed" && moved(r) && u2.name === name0 && moved(u2);
    console.log(ok ? "PASS" : "FAIL", "sync-undo", JSON.stringify({ u, r, u2 }));
    await h.page.context().browser()!.close();
  },
  // Autosave sends item-level patches: the host copy built from patches must equal the board the page holds.
  // A patch the host turned down makes the page send the whole board (full patch) with the next change.
  async patchsave() {
    const b = boardWith("Scheduler.schedule", "Scheduler.postprocess", "LLMEngine.step");
    const [A, B] = b.cards;
    b.links.push({ id: "L", from: { card: A.id }, to: { card: B.id } });
    b.sidenotes.push({ id: "n1", kind: "text", md: "x", at: { card: A.id } } as any);
    let fail = false;
    const patches: any[] = [];
    const h = await open({ board: b, light, on: (m, reply) => {
      if (m.type !== "patch") return false;
      patches.push(m.patch);
      if (!fail) return false;
      fail = false; void reply(m.req!, undefined, "disk full"); return true;
    } });
    const head = (i: number) => h.page.locator(".card").nth(i).locator(".chead");
    await head(0).click({ position: { x: 60, y: 10 } }); await h.page.waitForTimeout(1200);
    const idle = patches.length; // selecting is not a change
    await h.page.keyboard.press("ArrowRight"); await h.page.waitForTimeout(1200);
    const nudge = patches.at(-1); // the first change also numbers the cards (head.born)
    await h.page.keyboard.press("Meta+Shift+BracketRight"); await h.page.waitForTimeout(1200); // bring to front: order only
    const front = patches.at(-1);
    // the card that is on screen (the third one sticks out past the right edge, and the canvas does not scroll to it)
    await head(0).click({ position: { x: 60, y: 10 } }); await h.page.keyboard.press("Backspace"); await h.page.waitForTimeout(1200);
    const del = patches.at(-1);
    await h.page.keyboard.press("Meta+z"); await h.page.waitForTimeout(1200);
    await h.post({ type: "rename", name: "Renamed" }); await h.page.waitForTimeout(1200);
    const ren = patches.at(-1);
    const inc = structuredClone(h.board());
    fail = true;
    await head(0).click({ position: { x: 60, y: 10 } }); await h.page.keyboard.press("ArrowDown"); await h.page.waitForTimeout(1200);
    const failed = patches.at(-1);
    const toast = await h.page.locator(".toast").textContent().catch(() => "");
    await h.page.keyboard.press("ArrowDown"); await h.page.waitForTimeout(1200);
    const full = patches.at(-1);
    const { applyPatch } = await import("@codeboard/core");
    const moved = Object.keys(failed?.place?.set ?? {})[0];
    const y = (x: any) => x.place[moved].y;
    const y0 = y(inc);
    applyPatch(inc, failed);
    const twice = y(h.board()) - y0 === 2 * (y(inc) - y0) && y(inc) !== y0;
    const ok = idle === 0 && nudge?.place && !nudge.cards && Object.keys(nudge.place.set).length === 1
      && front?.cards?.order && !front.cards.set && del?.cards?.del?.length === 1
      && ren?.head?.name === "Renamed" && !ren.cards && /Couldn't save the board: disk full/.test(toast ?? "") && full?.full === true && twice;
    console.log(ok ? "PASS" : "FAIL", "patch-save", JSON.stringify({ idle, nudge: nudge && Object.keys(nudge), front: front && Object.keys(front.cards ?? {}), del: del && Object.keys(del), ren: ren && Object.keys(ren), toast, full: !!full?.full, twice }));
    await h.page.context().browser()!.close();
  },
  // A shared card changed on another board (host "shared" message): applied as a sync (no patch back, not undoable).
  // Undoing a local change to that card afterwards keeps the other board's version and says so
  async sharedsync() {
    const b = boardWith("Scheduler.schedule", "Scheduler.postprocess");
    const [A, B] = b.cards as any[];
    const patches: any[] = [];
    const h = await open({ board: b, light, on: (m) => { if (m.type === "patch") patches.push(m); return false; } });
    const head = (i: number) => h.page.locator(".card").nth(i).locator(".chead");
    await head(0).click({ position: { x: 60, y: 10 } }); await h.page.keyboard.press("Alt+z"); await h.page.waitForTimeout(1200);
    const wrote = patches.at(-1)?.patch.cards?.set?.[0]?.wrap === true;
    const n0 = patches.length;
    // Another board renames the card (its copy has our wrap); the host's copy already has it
    const sc = { card: { ...structuredClone(A), wrap: true, title: "Remote" }, sidenotes: [{ id: "rn", kind: "text", md: "remote note", at: { card: A.id } }], items: [A.id, "rn"] } as any;
    putShared(h.board(), structuredClone(sc));
    await h.post({ type: "shared", cards: [sc] });
    await h.page.waitForTimeout(1200);
    const echo = patches.length - n0; // must be 0
    const title = await h.page.locator(".card").nth(0).locator(".ctitle").textContent();
    await h.page.keyboard.press("Meta+z"); await h.page.waitForTimeout(300);
    const toast = await h.page.locator(".toast").textContent().catch(() => "");
    await h.page.waitForTimeout(1200);
    const after = h.board().cards.find((c) => c.id === A.id) as any;
    const undoPatch = patches.slice(n0).find((m) => m.undo);
    // A local card still undoes normally, without the toast
    await h.page.locator(".toast").evaluate((e) => e.remove()).catch(() => {});
    await head(1).click({ position: { x: 60, y: 10 } }); await h.page.keyboard.press("Alt+z"); await h.page.waitForTimeout(1200);
    await h.page.keyboard.press("Meta+z"); await h.page.waitForTimeout(1200);
    const local = (h.board().cards.find((c) => c.id === B.id) as any).wrap;
    const toast2 = await h.page.locator(".toast").count();
    const ok = wrote && echo === 0 && title === "Remote" && /not undone/.test(toast ?? "") && after.wrap === true && after.title === "Remote"
      && h.board().sidenotes.some((n) => n.id === "rn") && !local && toast2 === 0;
    console.log(ok ? "PASS" : "FAIL", "shared-sync", JSON.stringify({ wrote, echo, title, toast, after: { wrap: after.wrap, title: after.title }, undoPatch: !!undoPatch, local, toast2 }));
    await h.page.context().browser()!.close();
  },
  // Regression: after Update, Sidenotes and highlights follow edited lines instead of being treated as deleted
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
  // Regression: draw the inner frame first, then the outer one; the outer frame is the parent
  async secout() {
    const h = await open({ board: boardWith("LLMEngine.step"), light });
    const r = await h.page.locator(".card").first().boundingBox();
    const draw = async (pad: number, name: string) => {
      await h.page.locator(".bbar button[aria-label=\"Section\"]").click();
      await h.page.mouse.move(r!.x - pad, r!.y - pad - 20); await h.page.mouse.down();
      await h.page.mouse.move(r!.x + r!.width + pad, r!.y + r!.height + pad, { steps: 8 }); await h.page.mouse.up();
      await h.page.waitForTimeout(300); await h.page.keyboard.type(name); await h.page.keyboard.press("Enter"); await h.page.waitForTimeout(300);
    };
    await draw(30, "Inner"); await draw(90, "Outer"); await h.page.waitForTimeout(1200); // wait for autosave
    const ss = h.board().sections, inner = ss.find((q) => q.title === "Inner")!, outer = ss.find((q) => q.title === "Outer")!;
    const ok = inner.parent === outer.id && !outer.parent && h.board().place[h.board().cards[0].id]?.section === inner.id;
    console.log(ok ? "PASS" : "FAIL", "secout", JSON.stringify(ss.map((q) => [q.title, q.parent ? ss.find((x) => x.id === q.parent)!.title : null]).concat([["card", h.board().place[h.board().cards[0].id]?.section === inner.id ? "Inner" : "?"]])));
    await shot(h, "secout");
    await h.page.context().browser()!.close();
  },
  // Regression: subtrees expanded by Walkthrough are not written to the board
  async walkview() {
    const h = await open({ board: boardWith("LLMEngine.step"), light });
    await h.page.locator(".card .src .call", { hasText: /^schedule$/ }).first().click(); await h.page.waitForTimeout(700);
    const root = h.board().cards[0].id;
    await h.page.locator(".card").first().locator(".chead").click({ button: "right" }); await h.page.waitForTimeout(200);
    await h.page.locator('.ctx button:has(.lb:text-is("Call Graph"))').hover(); await h.page.waitForTimeout(400);
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
  // #3 #4: field / function / module / library previews
  async peekkinds() {
    const h = await open({ board: boardWith("LLMEngine.__init__", "ModelRunner.__init__"), light });
    const cases: [string, string, string, string][] = [
      ["field", "LLMEngine.__init__", "config.kvcache_block_size", "kvcache_block_size"],
      ["function", "ModelRunner.__init__", "load_model(self.model", "load_model"],
      ["module", "LLMEngine.__init__", "mp.get_context", "mp"],
      ["library", "LLMEngine.__init__", "mp.get_context", "get_context"],
    ];
    for (const [k, card, line, word] of cases) {
      await h.page.mouse.move(5, 5); await h.page.waitForTimeout(500);
      await hoverWord(h, card, line, word); await h.page.waitForTimeout(1100);
      const pop = h.page.locator(".pop.k-peek");
      const info = await pop.evaluate((e) => ({
        title: e.querySelector(".pt")?.textContent, sig: e.querySelector(".pk-sig")?.textContent, doc: !!e.querySelector(".pk-doc"),
        rows: [...e.querySelectorAll(".pl .no")].map((x) => x.textContent).join(","), hl: e.querySelector(".pl.hl .no")?.textContent,
        more: e.querySelector(".pk-more")?.textContent, lib: e.querySelector(".lib-tag")?.textContent, head: e.querySelector(".pk-head")?.textContent,
      })).catch(() => null);
      console.log(k, JSON.stringify(info));
      await shot(h, `peekkinds-${k}`);
    }
    await h.page.context().browser()!.close();
  },
  // #34: library calls get no underline and don't expand on click; ⌥-click / context menu Expand Anyway; restored after adding to Study Scope
  async libcalls() {
    const h = await open({ board: boardWith("ModelRunner.warmup_model"), light });
    const lib = h.page.locator(`.card .src .call[data-p="torch"]`).first();
    const deco = () => lib.evaluate((e) => getComputedStyle(e).textDecorationLine);
    console.log("lib calls:", await h.page.locator(".card .src .call[data-p]").count(), "project calls:", await h.page.locator(".card .src .call:not([data-p])").count(), "lib deco:", await deco());
    await shot(h, "libcalls-01");
    await lib.click(); await h.page.waitForTimeout(700);
    console.log("after click: cards", h.board().cards.length, "expand sent", h.sent.filter((m) => m.type === "expand").length);
    await lib.click({ modifiers: ["Alt"] }); await h.page.waitForTimeout(700);
    console.log("after alt-click: expand sent", h.sent.filter((m) => m.type === "expand").length);
    await h.page.mouse.move(5, 5); await h.page.waitForTimeout(400);
    await lib.click({ button: "right" }); await h.page.waitForTimeout(400);
    console.log("menu:", JSON.stringify(await h.page.locator(".ctx button").allTextContents()));
    await shot(h, "libcalls-02-menu");
    await h.page.locator(".ctx button", { hasText: "Study Scope" }).first().click(); await h.page.waitForTimeout(500);
    console.log("setSetting:", JSON.stringify(h.sent.filter((m) => m.type === "setSetting")), "deco now:", await deco());
    await shot(h, "libcalls-03-scoped");
    await h.page.context().browser()!.close();
  },
  // #32: dragging onto an existing card also offers variable candidates
  async attachvars() {
    const h = await open({ board: boardWith("ModelRunner.__init__", "Qwen3ForCausalLM"), light });
    const c = await callEl(h, "Qwen3ForCausalLM").boundingBox();
    const t = await h.page.locator(".card").nth(1).locator(".chead").boundingBox();
    await h.page.mouse.move(c!.x + 10, c!.y + c!.height / 2); await h.page.mouse.down();
    await h.page.mouse.move(t!.x + 60, t!.y + 40, { steps: 10 }); await h.page.mouse.up();
    await h.page.waitForTimeout(2500);
    const ls = h.board().links;
    console.log(ls.length === 1 && ls[0].call && ls[0].call.cands?.length ? "PASS" : "FAIL", "attachvars", JSON.stringify(ls.map((l) => l.call)));
    await shot(h, "attachvars");
    await h.page.context().browser()!.close();
  },
  async themes() {
    // Themes: switch through 8 materials × light/dark in Settings, one board screenshot each.
    // Board: entry function with two expanded calls (laid out to the right, variables on links), a Note, a Section, a labeled arrow and a heading; entry card selected and a toast shown
    const b = boardWith("LLMEngine.step");
    for (const [q, name] of [["Scheduler.schedule", "schedule"], ["ModelRunner.run", "call"]] as const) {
      const s0 = findSym(q); const c = symCard(s0.f, s0.s); put(b, c, 0, 0);
      const seg = (b.cards[0] as any).segments[0], i = seg.text.findIndex((t: string) => t.includes(`.${name}(`));
      b.links.push({ id: `c${b.links.length}`, from: { card: b.cards[0].id, seg: seg.id, line: seg.start + i }, to: { card: c.id }, call: { name, col: seg.text[i].indexOf(`.${name}(`) + 1 } } as any);
    }
    const [a] = b.cards;
    const kids = b.links.filter((l) => l.call).map((l) => l.to.card);
    b.place[a.id] = { x: 80, y: 200, w: 520 };
    kids.forEach((id, i) => { b.place[id] = { x: 760, y: 60 + i * 420, w: 470, h: i ? 264 : 324 }; }); // code area height (format v4): 300 / 360 tall in Warm Ink
    const vars = [[{ a: "seqs" }, { a: "is_prefill" }], [{ a: "token_ids", ret: true }]];
    b.links.filter((l) => l.call).forEach((l, i) => { l.call!.vars = vars[i] ?? []; });
    const note = { id: "n1", kind: "note" as const, md: "# Why chunked prefill\nKeeps memory **bounded**: prefill admits waiting seqs until the `max_num_batched_tokens` budget runs out.", bg: true };
    const title = { id: "t1", kind: "note" as const, md: "Engine loop", bg: false, size: "title" as const };
    b.cards.push(note, title);
    b.place[note.id] = { x: 110, y: 520, w: 360, section: "sec1" }; b.place[title.id] = { x: 70, y: 70, w: 300 };
    b.sections.push({ id: "sec1", title: "Engine", x: 50, y: 160, w: 600, h: 560, color: "sand" });
    b.place[a.id].section = "sec1";
    b.links.push({ id: "l1", from: { card: note.id }, to: { card: a.id }, style: { color: "blue" }, label: "why" });
    b.cam = { x: 120, y: 60, z: 0.92 };
    const h = await open({ board: b, light: false });
    await h.page.waitForTimeout(600);
    await h.page.keyboard.press("Escape");
    const poke = async () => {
      // Show a toast (click Arrow with no card selected), then select the entry card (click its header)
      await h.page.keyboard.press("Escape");
      await h.page.mouse.click(700, 24); // empty canvas: clear selection
      await h.page.locator('.bbar .tbtn[aria-label="Arrow"]').click();
      // An empty spot on the card header (header layout varies by material; find a point that hits .chead itself)
      const pt = await h.page.evaluate((id) => {
        const card = document.querySelector(`.card[data-id="${id}"]`)!, hd = card.querySelector(".chead")!, r = card.getBoundingClientRect();
        for (let y = r.top + 3; y < r.top + 120; y += 4) for (let x = r.right - 40; x > r.left; x -= 6) { const e = document.elementFromPoint(x, y); if (e === hd || e?.matches(".chead .grow, .cband, .cband .cname")) return { x, y }; }
        return { x: r.left + 4, y: r.top + 4 };
      }, a.id);
      await h.page.mouse.click(pt.x, pt.y);
    };
    await poke(); await h.page.waitForTimeout(400);
    console.log("cards after poke:", h.board().cards.length, "toast:", await h.page.locator(".toast").count(), "selected:", await h.page.locator(".card.sel").count());
    const mode = async (m: "light" | "dark") => { await h.page.evaluate((c) => { document.body.className = c; }, `vscode-${m}`); await h.page.waitForTimeout(100); };
    for (const m of ["light", "dark"] as const) {
      await mode(m);
      await h.page.mouse.move(5, 450);
      await shot(h, `theme-${m}-warm-ink-base`);
      await h.page.keyboard.press("Meta+,"); await h.page.waitForTimeout(300);
      await shot(h, `theme-${m}-settings`);
      if (m === "light") {
        await h.page.keyboard.press("Escape"); await h.page.keyboard.press("?"); await h.page.waitForTimeout(200);
        await shot(h, `theme-${m}-keys-overlay`);
        await h.page.locator(".keys .tlink").click(); await h.page.waitForTimeout(300);
        console.log("Search… in ? overlay opens Settings:", await h.page.locator(".settings").count() === 1, "overlay closed:", !(await h.page.locator(".keys").count()));
        await h.page.locator(".st-filter").scrollIntoViewIfNeeded();
        await shot(h, `theme-${m}-settings-keys`);
        await h.page.locator(".st-filter").fill("zoom"); await h.page.waitForTimeout(100);
        await shot(h, `theme-${m}-settings-keys-zoom`);
        await h.page.locator(".st-filter").fill("");
        await h.page.locator(".st-filter").press("Escape"); await h.page.waitForTimeout(200);
        console.log("Esc in filter closes settings:", !(await h.page.locator(".settings").count()));
        await h.page.keyboard.press("Meta+,"); await h.page.waitForTimeout(300);
      }
      const n = await h.page.locator(".st-sw").count();
      for (let i = 0; i < n; i++) {
        const sw = h.page.locator(".st-sw").nth(i);
        const name = (await sw.locator(".st-swn").textContent())!.toLowerCase().replace(/ /g, "-");
        await sw.click(); await h.page.waitForTimeout(150);
        if (i === n - 1) await shot(h, `theme-${m}-settings-${name}`);
        await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(150);
        await poke();
        if (await h.page.locator(".card.sel").count() !== 1) console.log("theme", m, name, "selected", await h.page.locator(".card.sel").count());
        await h.page.mouse.move(5, 450);
        await shot(h, `theme-${m}-${i}-${name}`);
        await h.page.keyboard.press("Meta+,"); await h.page.waitForTimeout(150);
      }
      await h.page.locator(".st-sw").first().click();
      await h.page.keyboard.press("Escape");
    }
    const set = h.sent.filter((x) => x.type === "setSetting");
    console.log("setSetting:", set.length, JSON.stringify(set.at(-1)));
    console.log("links:", h.board().links.length, "sections:", h.board().sections.length);
    await h.page.context().browser()!.close();
  },
};

/** Move the mouse to the middle of `word` on the line (containing `line`) in a card */
async function hoverWord(h: Host, card: string, line: string, word: string) {
  const pt = await h.page.evaluate(([card, line, word]) => {
    for (const c of document.querySelectorAll(".card")) {
      if (!c.querySelector(".chead")?.textContent?.includes(card)) continue;
      for (const l of c.querySelectorAll(".src .l")) {
        const t = l.textContent ?? "";
        const i = t.indexOf(line);
        if (i < 0) continue;
        const at = i + line.indexOf(word) + 1;
        const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
        let n = 0;
        for (let x = w.nextNode() as Text | null; x; x = w.nextNode() as Text | null) {
          if (n + x.length > at) { const r = document.createRange(); r.setStart(x, at - n); r.setEnd(x, at - n + 1); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
          n += x.length;
        }
      }
    }
    return null;
  }, [card, line, word]);
  if (!pt) throw new Error(`hoverWord: ${line} not found`);
  await h.page.mouse.move(pt.x - 3, pt.y); await h.page.mouse.move(pt.x, pt.y, { steps: 2 });
}

(async () => {
  await ready();
  // --shard i/n runs every n-th scenario starting at i (CI splits the harness across parallel jobs)
  const shard = process.argv.find((a) => a.startsWith("--shard="))?.slice(8).split("/").map(Number);
  // 只记录、不判对错的（v18review）不进默认那一轮，要跑就点名
  const all = names.length ? names : Object.keys(S).filter((n) => n !== "v18review");
  for (const n of shard ? all.filter((_, k) => k % shard[1] === shard[0] - 1) : all) { console.log("▶", n); await S[n](); }
})().catch((e) => { console.error(e); process.exit(1); });
