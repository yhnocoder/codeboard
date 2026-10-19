// v0.2 sub-boards (wireframe 05): one browser plays a board panel; the host is core Storage on a temp dir and switches the
// panel between boards like Panels.switchBoard (crumbs, cameras, walkthrough hops), pushes skeletons after saves (120 ms debounce).
// Usage: node packages/board/test/run-harness.mjs subboards [--light]   screenshots: test-out/harness/subboards-*.png
import * as fs from "node:fs";
import * as path from "node:path";
import { cutCrumbs, emptyBoard, skeletonOf, subBoardsOf, wouldCycle, type Board, type Camera, type Crumb, type Skeleton, type SegView, type HostToBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../../../extensions/vscode/src/nodefs";
import { open, shot, symCard, findSym, viewOf, put, OUT, type Host } from "./harness";

const light = process.argv.includes("--light");
const wait = (h: Host, ms = 1100) => h.page.waitForTimeout(ms);
const viewsOf = (b: Board): Record<string, SegView> => {
  const v: Record<string, SegView> = {};
  for (const c of b.cards) if (c.kind === "code") for (const s of c.segments) v[s.id] = viewOf(s);
  return v;
};
const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
/** first line of a card whose text matches re */
const lineOf = (c: ReturnType<typeof card>, re: RegExp) => { const s = c.segments[0]; return s.start + Math.max(0, s.text.findIndex((t) => re.test(t))); };

/** A host for one board panel that switches between boards (exported for the other board scenarios) */
export async function subHost(start: Board, others: Board[]) {
  const dir = path.join(OUT, `subboards-store-${start.id}`); // one per start board: scenarios run side by side
  fs.rmSync(dir, { recursive: true, force: true });
  const store = new Storage(nodeFs, { dir: () => dir });
  for (const b of [start, ...others]) await store.save(b);
  let cur = start.id, crumbs: Crumb[] = [], cams: Camera[] = [];
  const inits: { id: string; crumbs: number; walk?: unknown }[] = [];
  let h!: Host; // a patch can come in before open() returns (the first skeletons mark lost arrows): h?.post there
  const sent = new Map<string, string>();
  const sk = (id: string): Skeleton | null => { const b = store.peek(id); return b ? skeletonOf(b, (x) => store.peek(x)?.name) : null; };
  const dirty = new Set<string>();
  let all = false, t: ReturnType<typeof setTimeout> | undefined;
  const push = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const b = store.peek(cur);
      if (!b) return;
      const out: Record<string, Skeleton | null> = {};
      for (const id of subBoardsOf(b)) {
        if (sent.has(id) && !all && !dirty.has(id)) continue;
        const s = sk(id), k = JSON.stringify(s);
        if (sent.get(id) === k) continue;
        sent.set(id, k); out[id] = s;
      }
      dirty.clear(); all = false;
      if (Object.keys(out).length) void h.post({ type: "skeletons", boards: out });
    }, 120);
  };
  store.onDidSave((b) => { dirty.add(b.id); push(); });
  // like Panels: a deleted board on the breadcrumbs can't be gone back to
  store.onDidRemoveBoard((id) => { const c = cutCrumbs(crumbs, cams, id); if (c) { crumbs = c.crumbs; cams = c.cams; void h.post({ type: "crumbs", crumbs }); } });
  store.onDidChange(() => { all = true; push(); });
  const init = async (walk?: unknown, cam?: Camera) => {
    const b = (await store.load(cur))!;
    if (cam) b.cam = cam;
    sent.clear();
    inits.push({ id: cur, crumbs: crumbs.length, walk });
    const m: HostToBoard = { type: "init", board: b, boards: await store.list(), views: viewsOf(b), stale: {}, host: { isMac: true, assetBase: "", target: true, settings: { theme: "warm-ink", hideOnNew: {}, studyScope: [], stickerDir: "", zoomOverview: 0.6, zoomMap: 0.25, dblClick: "text" } } };
    if (crumbs.length) m.crumbs = crumbs;
    if (walk) m.walk = walk as any;
    await h.post(m);
    push();
  };
  h = await open({
    board: (await store.load(cur))!, light, w: 1400, h: 900,
    on: async (m, reply) => {
      switch (m.type) {
        case "patch": await store.patch(cur, m.patch, { undo: m.undo }); await h?.post({ type: "boards", boards: await store.list() }); await reply(m.req, { skipped: 0 }); return true;
        case "skeletons": await store.list(); await reply(m.req, Object.fromEntries(m.ids.map((id) => [id, sk(id)]))); return true;
        case "newBoard": await store.save(m.board, { group: null }); await reply(m.req, true); return true;
        case "deleteBoard": await store.remove(m.id); await reply(m.req, true); return true;
        case "dropBoard": {
          const framed = (await store.list()).some((x) => x.id !== cur && x.subs?.includes(m.id));
          await reply(m.req, !framed && (await store.dropIfUnchanged(m.id, m.made))); return true;
        }
        case "restoreBoard": await reply(m.req, await store.restore(m.id)); return true;
        case "confirm": await reply(m.req, true); return true;
        case "enterBoard": {
          const metas = await store.list();
          if (wouldCycle((id) => metas.find((x) => x.id === id)?.subs, cur, m.id)) return true;
          crumbs = [...crumbs, { id: cur, name: store.peek(cur)!.name, frame: m.frame }]; cams = [...cams, m.cam];
          cur = m.id; await init(m.walk); return true;
        }
        case "leaveBoard": {
          if (!crumbs.length) return true;
          const d = m.depth ?? crumbs.length - 1;
          const to = crumbs[d], cam = cams[d];
          crumbs = crumbs.slice(0, d); cams = cams.slice(0, d); cur = to.id;
          await init(m.walk, cam); return true;
        }
        default: return false;
      }
    },
  });
  await init(); // the harness's own init has no board list / skeleton push yet
  return { store, h, inits, cur: () => cur, crumbs: () => crumbs };
}

/** Screenshot also into the PR shots folder when SHOTS_DIR is set */
async function shotPr(h: Host, name: string) {
  await shot(h, name);
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
}

export const SUBBOARDS: Record<string, () => Promise<void>> = {
  async subboards() {
    const res: Record<string, unknown> = {};
    try { await run(res); } catch (e) { console.log("FAIL subboards", (e as Error).message.split("\n")[0], JSON.stringify(res)); process.exit(1); }
  },
  /** Turn into Board, edit the new board, go back, ⌘Z: the parent goes back, the sub-board keeps the edit; ⌘⇧Z links to it again. Unedited: ⌘Z trashes it, ⌘⇧Z brings it back */
  async turnIntoBoardUndo() {
    const E = emptyBoard("bUndo", "Undo");
    const a = card("Scheduler.schedule"), c = card("BlockManager.allocate"), d = card("BlockManager.can_allocate");
    put(E, a, 60, 60, 560); put(E, c, 700, 60, 480); put(E, d, 700, 500, 480);
    const t = await subHost(E, []);
    const h = t.h, page = h.page, res: Record<string, unknown> = {};
    const turn = async (ids: string[], name: string) => {
      await page.keyboard.press("Shift+Digit1"); await wait(h, 700);
      for (const [i, id] of ids.entries()) await page.locator(`.card[data-id="${id}"] .chead`).click({ position: { x: 120, y: 10 }, modifiers: i ? ["Shift"] : [] });
      await page.keyboard.press("Meta+Shift+b"); await wait(h, 400);
      await page.locator(".dialog input").fill(name);
      await page.locator(".dialog button", { hasText: "Create Board" }).click(); await wait(h, 1600);
      const f = t.store.peek("bUndo")!.cards.find((k) => k.kind === "board" && !E.cards.some((x) => x.id === k.id));
      return f?.kind === "board" ? f : undefined;
    };
    const undo = async () => { await page.mouse.click(5, 880); await page.keyboard.press("Meta+z"); await wait(h, 1500); };
    const redo = async () => { await page.keyboard.press("Meta+Shift+z"); await wait(h, 1500); };
    try {
      // edited: enter, delete a card, come back, undo
      const f1 = (await turn([c.id, d.id], "Alloc"))!;
      await page.locator(`.card[data-id="${f1.id}"] .sbhead`).dblclick({ position: { x: 200, y: 12 } }); await wait(h, 1600);
      res.entered = t.cur() === f1.board;
      await page.keyboard.press("Shift+Digit1"); await wait(h, 700);
      await page.locator(`.card[data-id="${d.id}"] .chead`).click({ position: { x: 120, y: 10 } });
      await page.keyboard.press("Backspace"); await wait(h, 1400);
      await page.keyboard.press("Escape"); await wait(h, 300);
      await page.keyboard.press("Escape"); await wait(h, 1600);
      res.back = t.cur() === "bUndo";
      await undo();
      res.parentBack = t.store.peek("bUndo")!.cards.map((k) => k.id).sort().join() === [a.id, c.id, d.id].sort().join();
      res.childKept = t.store.peek(f1.board)?.cards.map((k) => k.id);
      await redo();
      const again = t.store.peek("bUndo")!.cards.find((k) => k.id === f1.id);
      res.relinked = again?.kind === "board" && again.board === f1.board && t.store.peek(f1.board)?.cards.length === 1;
      // unedited: undo trashes it, redo brings the file back
      await undo();
      const kept = t.store.peek(f1.board); // the edited Alloc board stays after a second undo too
      res.stillKept = kept?.cards.length === 1;
      await redo();
      const f2 = (await turn([a.id], "Sched"))!;
      await undo();
      res.trashed = !t.store.peek(f2.board);
      await redo();
      res.restored = !!t.store.peek(f2.board) && t.store.peek("bUndo")!.cards.some((k) => k.id === f2.id);
    } catch (e) { res.error = (e as Error).message.split("\n")[0]; }
    const ok = res.entered && res.back && res.parentBack && JSON.stringify(res.childKept) === JSON.stringify([c.id]) && res.relinked && res.stillKept && res.trashed && res.restored;
    console.log(ok ? "PASS" : "FAIL", "turnIntoBoardUndo", JSON.stringify(res));
    await h.page.context().browser()!.close();
    if (!ok) process.exit(1);
  },
};

async function run(res: Record<string, unknown>) {
  {
    // Engine: LLMEngine.step calls schedule / postprocess; schedule calls can_allocate, allocate, preempt (call marks)
    const E = emptyBoard("bEngine", "Engine");
    const step = card("LLMEngine.step"), sch = card("Scheduler.schedule"), can = card("BlockManager.can_allocate"), alloc = card("BlockManager.allocate"), pre = card("Scheduler.preempt"), post = card("Scheduler.postprocess");
    put(E, step, 60, 120, 600);
    put(E, sch, 820, 60); put(E, can, 1460, 60, 480); put(E, alloc, 1460, 420, 480); put(E, pre, 1460, 760, 480); put(E, post, 820, 900);
    const s0 = step.segments[0], c0 = sch.segments[0];
    const L = (id: string, from: typeof step, re: RegExp, to: string, name: string) => E.links.push({ id, from: { card: from.id, seg: from.segments[0].id, line: lineOf(from, re) }, to: { card: to }, call: { name, col: 0 } });
    L("l1", step, /schedule\(\)/, sch.id, "schedule");
    L("l2", step, /postprocess\(/, post.id, "postprocess");
    L("l3", sch, /can_allocate\(/, can.id, "can_allocate");
    L("l4", sch, /\.allocate\(/, alloc.id, "allocate");
    L("l5", sch, /preempt\(/, pre.id, "preempt");
    E.sections.push({ id: "secS", title: "Scheduling", x: 790, y: 20, w: 1180, h: 1300, color: "blue" });
    for (const c of [sch, can, alloc, pre, post]) E.place[c.id].section = "secS";
    // Ops: one dispatch line with 7 branches (folds into "+N" in the skeleton)
    const O = emptyBoard("bOps", "Ops");
    const disp = card("LLMEngine.step");
    put(O, disp, 60, 60);
    for (let i = 0; i < 7; i++) {
      const id = `op${i}`;
      O.cards.push({ id, kind: "note", md: `handler_${i}`, bg: true }); O.place[id] = { x: 760, y: 40 + i * 190, w: 260 };
      O.links.push({ id: `ol${i}`, from: { card: disp.id, seg: disp.segments[0].id, line: lineOf(disp, /schedule\(\)/) }, to: { card: id }, call: { name: "schedule", col: 0 } });
    }
    const t = await subHost(E, [O]);
    const h = t.h, page = h.page;
    void s0; void c0;
    await wait(h, 800);
    await page.keyboard.press("Shift+Digit1"); await wait(h, 900);

    // 1. Turn into Board: select the Scheduling cards (marquee would catch the section; select through the store API instead)
    for (const [i, c] of [sch, can, alloc, pre, post].entries()) await page.locator(`.card[data-id="${c.id}"] .chead`).click({ position: { x: 120, y: 10 }, modifiers: i ? ["Shift"] : [] });
    await page.keyboard.press("Meta+Shift+b"); await wait(h, 400);
    await page.locator(".dialog input").fill("Scheduler");
    await page.locator(".dialog button", { hasText: "Create Board" }).click(); await wait(h, 1800);
    const eng = t.store.peek("bEngine")!;
    const frame = eng.cards.find((c) => c.kind === "board");
    const child = frame?.kind === "board" ? t.store.peek(frame.board) : undefined;
    res.frame = !!frame && eng.cards.length === 2;
    res.child = child ? child.cards.length : 0;
    res.childLinks = child?.links.length;
    res.subLinks = eng.links.filter((l) => l.to.card === frame?.id && l.to.sub).map((l) => l.to.sub === sch.id || l.to.sub === post.id);
    res.skelCards = await page.locator(`.card[data-id="${frame?.id}"] .skel [data-sub]`).count();
    res.title = await page.locator(`.card[data-id="${frame?.id}"] .sbhead`).textContent();
    res.entry = await page.locator(".sbentry").count();
    await page.keyboard.press("Escape"); await page.keyboard.press("Shift+Digit1"); await wait(h, 900);
    await shotPr(h, "subboards-1-frame");

    // 2. Far zoom: grey blocks with Section colour, name above
    // 滚轮一点一点缩到刚进地图档（< 25%），框还看得清
    for (let i = 0; i < 30 && !(await page.locator(`.card.board.lo-map`).count()); i++) {
      await page.evaluate(() => document.querySelector("#board")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, ctrlKey: true, clientX: 700, clientY: 400, bubbles: true, cancelable: true })));
      await wait(h, 250);
    }
    await wait(h, 1000);
    res.far = await page.locator(`.card.board.lo-map[data-id="${frame?.id}"]`).count();
    await shotPr(h, "subboards-2-far");
    await page.keyboard.press("Shift+Digit1"); await wait(h, 1000);

    // 3. Insert Ops (canvas menu ▸ Insert Board) → its dispatch line folds into "+N more"
    await page.mouse.click(700, 820, { button: "right" }); await wait(h, 300);
    await page.locator(".ctx button", { hasText: "Insert Board" }).hover(); await wait(h, 300);
    await page.locator(".ctx button", { hasText: /^Ops/ }).click(); await wait(h, 1500);
    const opsFrame = t.store.peek("bEngine")!.cards.find((c) => c.kind === "board" && c.board === "bOps");
    res.more = await page.locator(`.card[data-id="${opsFrame?.id}"] .skel .sk-more`).textContent().catch(() => "");

    // 4. A new arrow from LLMEngine.step into a skeleton card: Arrow tool, then click the card inside the frame
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+Digit1"); await wait(h, 900);
    await page.locator(`.card[data-id="${step.id}"] .chead`).click({ timeout: 5000, position: { x: 120, y: 10 } });
    await page.locator('.bbar button[aria-label="Arrow"]').click(); await wait(h, 200);
    const target = child?.cards.find((c) => c.id === pre.id);
    await page.locator(`.card[data-id="${frame?.id}"] .skel [data-sub="${target?.id}"] .sk-box`).click({ force: true }); await wait(h, 1500);
    const nl = t.store.peek("bEngine")!.links.find((l) => l.to.sub === pre.id && !l.call);
    res.newArrow = !!nl;
    for (let i = 0; i < 20 && await page.locator(".toast.show").count(); i++) await wait(h, 250);
    // 骨架里那张卡在视口外时 Playwright 的点击会先把 #board 滚过去（线那层的 .wext 把世界层撑大了）：滚回来，后面按屏幕坐标点的地方才对得上
    await page.evaluate(() => { const b = document.querySelector("#board")!; b.scrollLeft = 0; b.scrollTop = 0; });
    await page.mouse.move(5, 5); await wait(h, 300);
    await shotPr(h, "subboards-4-arrow-into-skeleton");

    // 5. Double-click enters the sub-board (same panel) with a breadcrumb; cycle refused; Esc returns
    await page.locator(`.card[data-id="${frame?.id}"] .sbhead`).dblclick({ position: { x: 200, y: 12 } }); await wait(h, 1600);
    res.entered = t.cur() === (frame as any)?.board && t.crumbs().length === 1;
    res.crumbs = await page.locator(".crumbs").textContent().catch(() => "");
    await shotPr(h, "subboards-3-breadcrumb");
    await page.mouse.click(700, 820, { button: "right" }); await wait(h, 300);
    await page.locator(".ctx button", { hasText: "Insert Board" }).hover(); await wait(h, 300);
    await page.locator(".ctx button", { hasText: /^Engine/ }).click(); await wait(h, 300);
    res.cycleToast = await page.locator(".toast").textContent().catch(() => "");
    res.noCycle = !subBoardsOf(t.store.peek(t.cur())!).includes("bEngine");
    // remove preempt in the child: the parent arrow into it goes lost (Esc here would leave: nothing is selected)
    await wait(h, 400); res.lo = await page.locator(".card.lo-ov, .card.lo-map").count();
    await page.keyboard.press("Shift+Digit1"); await wait(h, 900);
    await page.locator(`.card[data-id="${pre.id}"] .chead`).click({ timeout: 5000, position: { x: 120, y: 10 } });
    await page.keyboard.press("Backspace"); await wait(h, 1400);
    await page.keyboard.press("Escape"); await wait(h, 300);
    await page.keyboard.press("Escape"); await wait(h, 1600);
    res.back = t.cur() === "bEngine" && !(await page.locator(".crumbs").count());
    await wait(h, 800);
    res.lost = t.store.peek("bEngine")!.links.filter((l) => l.to.sub === pre.id).every((l) => l.lost?.to);

    // 6. Walkthrough from LLMEngine.step: enters Scheduler at schedule, walks there, returns to Engine and goes on
    await page.locator(`.card[data-id="${step.id}"] .chead`).click({ timeout: 5000, position: { x: 120, y: 10 } });
    await page.keyboard.press("p"); await wait(h, 900);
    const before = t.inits.length;
    await page.keyboard.press("ArrowRight"); await wait(h, 2000); // → the frame: camera goes in, panel switches
    res.walkIn = t.cur() !== "bEngine" && (t.inits.at(-1)?.walk as any)?.into !== undefined;
    res.walkBar = await page.locator(".present .ptitle").textContent().catch(() => "");
    for (let i = 0; i < 6 && t.cur() !== "bEngine"; i++) { await page.keyboard.press("ArrowRight"); await wait(h, 1300); }
    res.walkOut = t.cur() === "bEngine" && t.inits.length >= before + 2 && (t.inits.at(-1)?.walk as any)?.resume !== undefined;
    res.walkAfter = await page.locator(".present .cnt").textContent().catch(() => "");
    await page.keyboard.press("Escape"); await wait(h, 400);

    // 7. Remove only the frame: the Ops board stays in the library
    await page.keyboard.press("Shift+Digit1"); await wait(h, 900);
    await page.locator(`.card[data-id="${opsFrame?.id}"] .sbhead`).click({ position: { x: 150, y: 12 } });
    await page.keyboard.press("Backspace"); await wait(h, 1400);
    res.removedFrame = !t.store.peek("bEngine")!.cards.some((c) => c.id === opsFrame?.id) && !!t.store.peek("bOps");

    const ok = res.frame && res.child === 5 && res.childLinks === 3 && (res.subLinks as boolean[]).length === 2 && (res.subLinks as boolean[]).every(Boolean)
      && (res.skelCards as number) >= 5 && /Scheduler.*5 cards.*bb823b3/.test(String(res.title)) && (res.entry as number) >= 2 && res.far === 1
      && /\+4 more/.test(String(res.more)) && res.newArrow && res.entered && /Engine.*Scheduler/.test(String(res.crumbs))
      && /Can’t put Engine inside Scheduler: Scheduler is already inside Engine/.test(String(res.cycleToast)) && res.noCycle && res.back && res.lost
      && res.walkIn && res.walkOut && res.removedFrame && res.lo === 0;
    console.log(ok ? "PASS" : "FAIL", "subboards", JSON.stringify(res));
    await h.page.context().browser()!.close();
  }
}
