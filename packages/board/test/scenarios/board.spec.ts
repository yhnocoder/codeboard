import { shot, symCard, findSym, put, type Host } from "../harness";
import { cornerAt, emptyBoard, DEFAULT_SETTINGS, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import { test, open, check, light, expect, until, idle, hold } from "../fixtures";
import { DBL_CLICK, LINK_LEAVE, LIVE_DELAY, SNAP_SPEED, SNAP_SETTLE } from "../../src/state/timing";

const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + s.text.findIndex((t) => re.test(t)); };
const close = (h: Host) => h.page.context().close();

/** step → schedule (child to the right), → postprocess (child below), with variables, sidenotes and assorted stickers */
function richBoard(): Board {
  const b = emptyBoard("b1", "board");
  const step = card("LLMEngine.step"), sch = card("Scheduler.schedule"), post = card("Scheduler.postprocess");
  put(b, step, 80, 80, 600); put(b, sch, 780, 60, 560); put(b, post, 140, 420, 560);
  const s0 = step.segments[0];
  const l1 = lineOf(step, /scheduler\.schedule\(/), l2 = lineOf(step, /scheduler\.postprocess\(/);
  b.links.push({ id: "L1", from: { card: step.id, seg: s0.id, line: l1 }, to: { card: sch.id }, call: { name: "schedule", col: 37, vars: [{ a: "seqs", ret: true }, { a: "is_prefill", ret: true }] } });
  b.links.push({ id: "L2", from: { card: step.id, seg: s0.id, line: l2 }, to: { card: post.id }, call: { name: "postprocess", col: 23, vars: [{ a: "seqs" }, { a: "token_ids" }, { a: "is_prefill" }] } });
  b.sidenotes.push({ id: "n1", kind: "text", md: "Prefill first, then decode.", at: { card: step.id, seg: s0.id, lines: [l1, l1] } });
  b.stickers.push({ id: "k1", icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: step.id, seg: s0.id, line: l1 } });
  b.stickers.push({ id: "k2", icon: { pack: "builtin", name: "question" }, at: { kind: "line", card: step.id, seg: s0.id, line: l1 + 2 } });
  b.stickers.push({ id: "k3", icon: { pack: "builtin", name: "bug" }, at: { kind: "canvas", ...cornerAt(560), on: { card: sch.id } } });
  b.stickers.push({ id: "k4", icon: { pack: "builtin", name: "todo-text" }, at: { kind: "canvas", x: 900, y: 600, size: 32 } });
  b.stickers.push({ id: "k5", icon: { pack: "emoji", name: "🔥" }, at: { kind: "canvas", x: 980, y: 600, size: 40 } });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

test("zoomLevels", async () => {
  const b = richBoard();
  b.sections.push({ id: "g1", title: "Scheduling", x: 740, y: 20, w: 640, h: 560, color: "blue" });
  b.place[b.cards[1].id].section = "g1";
  for (const [z, n] of [[0.45, "board-12-overview"], [0.18, "board-13-map"]] as const) {
    b.cam = { x: 60, y: 60, z };
    const h = await open({ board: structuredClone(b), light, w: 1400, h: 900 });
    await shot(h, n);
    if (n === "board-12-overview") {
      // Overview hides code with opacity, so the hidden code must not take the pointer: a press on a call lands on the cover and goes to the card
      const hit = await h.page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(".card .src .call");
        if (!el) return { call: false, inSrc: true, cover: false };
        const r = el.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement | null;
        return { call: true, inSrc: !!t?.closest(".src, .gutter"), cover: !!t?.classList.contains("ovm") };
      });
      check("overview-hidden-code-takes-no-pointer", hit.call && !hit.inSrc && hit.cover, JSON.stringify(hit));
    }
    if (n === "board-13-map") {
      // Map labels hold their size while the camera moves (they scale with the board), then settle to the exact size after it stops
      await h.page.mouse.move(700, 450);
      await h.page.keyboard.down("Control");
      for (let i = 0; i < 4; i++) { await h.page.mouse.wheel(0, 20); await hold(h, 40, "pinch rhythm: the camera keeps moving between the wheel steps"); }
      await h.page.keyboard.up("Control");
      // pictures of the labels during and right after the pinch: taken at these times on purpose
      await shot(h, "board-13b-map-pinch-mid", "now");
      const fs = () => h.page.evaluate(() => { const e = document.querySelector(".maplabel"); return e ? getComputedStyle(e).fontSize : "none"; });
      const mid = await fs();
      await hold(h, 200, "a picture 200 ms after the pinch"); await shot(h, "board-13c-map-pinch-200ms", "now");
      await shot(h, "board-13d-map-pinch-settled");
      const z = await h.page.evaluate(() => +((document.querySelector(".world") as HTMLElement).style.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1));
      const end = await fs(), iz = await h.page.evaluate(() => +getComputedStyle(document.querySelector(".world > .card")!).getPropertyValue("--iz"));
      check("map-labels-settle-after-pinch", Math.abs(iz * z - 1) < 0.01, JSON.stringify({ mid, end, z, iz }));
    }
    await close(h);
  }
});

/** A Section folding from its label's button, with pictures mid-fold and folded: the fold is saved and its card is hidden */
test("sectionFoldShots", async () => {
  const b = richBoard();
  b.sections.push({ id: "g1", title: "Scheduling", x: 740, y: 20, w: 640, h: 560, color: "blue" });
  const inside = b.cards[1].id;
  b.place[inside].section = "g1";
  const h = await open({ board: structuredClone({ ...b, cam: { x: 0, y: 0, z: 0.8 } }), light, w: 1400, h: 900 });
  await h.page.locator('.slabel[data-sect="g1"] button[aria-label="Collapse Section"]').click();
  await hold(h, 120, "a picture mid-fold"); await shot(h, "board-14-folding", "now");
  await shot(h, "board-15-folded");
  await until(h, "the fold is saved", () => h.board().sections.find((q) => q.id === "g1")?.collapsed);
  const shown = await h.page.locator(`.card[data-id="${inside}"]`).isVisible();
  check("sectionFoldShots the folded Section hides its card", !shown, { shown });
  await close(h);
});

test("linkPlusDelay", async () => {
  const h = await open({ board: richBoard(), light, w: 1500, h: 950 });
  await shot(h, "board-01-board");
  await h.page.locator('path.lhit[data-link="L2"]').hover({ force: true }); await h.page.locator(".vplus").first().waitFor();
  // the timing is what this checks: the "+" stays for linkLeave after the pointer left, then goes
  await h.page.mouse.move(10, 10); await hold(h, LINK_LEAVE - 180, "still inside linkLeave after leaving the arrow");
  const plusSoon = await h.page.locator(".vplus").count();
  await hold(h, LINK_LEAVE + 100, "linkLeave is over: the + must be gone");
  const plusLater = await h.page.locator(".vplus").count();
  check("vplus-delay", plusSoon >= 1 && plusLater === 0, JSON.stringify({ plusSoon, plusLater }));
  await h.page.locator(".card .src .l").nth(3).hover();
  await shot(h, "board-02-ports");
  await close(h);
});

test("menusFitWindow", async () => {
  const h = await open({ board: richBoard(), light, w: 1500, h: 950 });
  await h.page.locator(".card.ccard .chead").first().click({ button: "right", position: { x: 300, y: 12 } }); await h.page.locator(".ctx button").first().waitFor();
  await shot(h, "board-03-cardmenu");
  await h.page.locator(".ctx button", { hasText: /^View$/ }).hover();
  await shot(h, "board-04-view");
  await h.page.keyboard.press("Escape");
  await h.page.locator('.bbar button[aria-label="Code"]').click(); await h.page.locator(".ctx button").first().waitFor();
  await shot(h, "board-05-codemenu");
  await h.page.keyboard.press("Escape");
  await h.page.locator('.bbar button[aria-label="More"]').click(); await h.page.locator(".ctx button").first().waitFor();
  await shot(h, "board-06-more");
  await h.page.keyboard.press("Escape");
  // Menu hits the bottom edge: flips upward, last item visible
  await h.page.locator(".card.ccard").nth(2).locator(".chead").click({ button: "right", position: { x: 200, y: 12 } });
  await h.page.locator(".ctx button").first().waitFor(); await idle(h); // the earlier menus have faded out, this one is placed
  const vis = await h.page.evaluate(() => { const m = document.querySelector(".ctx")!; const r = m.getBoundingClientRect(); const last = [...m.querySelectorAll("button")].pop()!.getBoundingClientRect(); return r.top >= 0 && last.bottom <= innerHeight; });
  check("menu-fits", vis);
  await close(h);
});

test("arrangeMenuDisablesNoOps", async () => {
  const b = richBoard(), [bottom, , top] = b.cards.map((c) => c.id);
  const h = await open({ board: b, light, w: 1500, h: 950 });
  const arrange = async (id: string) => {
    await h.page.locator(`.card[data-id="${id}"] .chead`).click({ button: "right", position: { x: 200, y: 12 } });
    await h.page.locator(".ctx button", { hasText: /^Arrange$/ }).hover();
    const sub = h.page.locator(".ctx").last();
    await sub.locator(":scope > button").first().waitFor(); await idle(h);
    return Object.fromEntries(await sub.locator(":scope > button").evaluateAll((bs) => bs.map((x) => [x.querySelector(".lb")!.textContent!.trim(), (x as HTMLButtonElement).disabled])));
  };
  const onTop = await arrange(top);
  check("arrange-top-card", onTop["Bring to Front"] && onTop["Bring Forward"] && !onTop["Send Backward"] && !onTop["Send to Back"], JSON.stringify(onTop));
  await h.page.keyboard.press("Escape"); await h.page.keyboard.press("Escape"); await idle(h);
  const atBack = await arrange(bottom);
  check("arrange-bottom-card", !atBack["Bring to Front"] && !atBack["Bring Forward"] && atBack["Send Backward"] && atBack["Send to Back"], JSON.stringify(atBack));
  await h.page.locator(".ctx").last().locator(":scope > button", { has: h.page.locator(".lb", { hasText: /^Bring to Front$/ }) }).click();
  await until(h, "the bottom card moves to the front", () => h.board().cards.at(-1)?.id === bottom);
  await close(h);
});

test("stickerPlace", async () => {
  const h = await open({ board: richBoard(), light, w: 1500, h: 950 });
  await h.page.locator('.bbar button[aria-label="Sticker"]').click(); await h.page.locator(".stkpick .scell").first().waitFor();
  await shot(h, "board-07-picker");
  await h.page.locator(".stkpick .scell").nth(3).click();
  // Click the gutter → stick to that line (click code body → bind to the card, tested by stickerBinding)
  await h.page.locator(".card").first().locator(".gutter .no").nth(5).click();
  await until(h, "the line sticker is saved", () => h.board().stickers.length === 6); await idle(h);
  await h.page.mouse.click(1200, 800); await idle(h);
  await h.page.locator('.bbar button[aria-label="Sticker"]').click();
  await h.page.locator(".stkpick .scell").nth(0).click();
  await h.page.mouse.click(1250, 760);
  await until(h, "the canvas sticker is saved", () => h.board().stickers.length === 7); await idle(h);
  const st = h.board().stickers;
  const ok = st.length === 7 && st[5].at.kind === "line" && st[6].at.kind === "canvas";
  check("sticker-place", ok, JSON.stringify(st.slice(5).map((s) => s.at)));
  await shot(h, "board-08-placed");
  await h.page.keyboard.press("Delete"); await idle(h);
  check("sticker-delete", h.board().stickers.length === 6);
  // 选好贴纸（放置模式）后换了白板：模式不能带到新白板上，点画布不放贴纸
  await h.page.locator('.bbar button[aria-label="Sticker"]').click();
  await h.page.locator(".stkpick .scell").nth(0).click(); await idle(h);
  const placing = await h.page.evaluate(() => document.getElementById("board")!.dataset.mode);
  const b2 = emptyBoard("b2", "other");
  await h.post({ type: "init", board: b2, boards: [{ id: "b2", name: "other", cards: 0 }], views: {}, stale: {}, host: { isMac: true, assetBase: "", target: true, settings: { ...DEFAULT_SETTINGS } } });
  await h.page.locator(".card").first().waitFor({ state: "detached" }); await idle(h); // the other board is shown
  const after = await h.page.evaluate(() => document.getElementById("board")!.dataset.mode ?? null);
  // a sticker would be placed by the click itself: the board is idle once that would have happened
  await h.page.mouse.click(700, 500); await idle(h);
  const placed = await h.page.evaluate(() => document.querySelectorAll("[data-sticker]").length);
  check("sticker-place-board-switch", placing === "place" && after === null && !placed, JSON.stringify({ placing, after, placed }));
  await close(h);
});

// A drag still held when the host switches boards (into a sub-board, another board opened) is dropped: releasing it afterwards
// changes nothing, and the old board's snapshot never reaches the new board's undo stack (⌘Z there must not bring old cards back)
test("dragDroppedOnBoardSwitch", async () => {
  const res: Record<string, number> = {};
  for (const [kind, sel] of [["sticker", '[data-sticker="k4"]'], ["label", '.vchips[data-link="L1"]'], ["section", '.slabel[data-sect="gD"]']] as const) {
    const b = richBoard();
    b.sections.push({ id: "gD", title: "Drag me", x: 1500, y: 60, w: 300, h: 200 });
    b.cam = { x: 0, y: 0, z: 0.8 };
    const h = await open({ board: b, light, w: 1500, h: 950 });
    const box = (await h.page.locator(sel).first().boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await h.page.mouse.move(x, y); await h.page.mouse.down();
    await h.page.mouse.move(x + 30, y + 20, { steps: 4 });
    const b2 = emptyBoard("b2", "other");
    await h.post({ type: "init", board: b2, boards: [{ id: "b2", name: "other", cards: 0 }], views: {}, stale: {}, host: { isMac: true, assetBase: "", target: true, settings: { ...DEFAULT_SETTINGS } } });
    await h.page.locator(".card").first().waitFor({ state: "detached" }); await idle(h);
    await h.page.mouse.move(x + 60, y + 40, { steps: 4 }); await h.page.mouse.up(); await idle(h);
    await h.page.keyboard.press("Meta+z"); await idle(h);
    res[kind] = await h.page.locator(".card, [data-sticker], .slabel").count(); // the old board's cards, stickers and Sections
    await close(h);
  }
  check("dragDroppedOnBoardSwitch", Object.values(res).every((n) => n === 0), "nothing of the old board after the release and ⌘Z", res);
});

// 自定义贴纸包的 SVG 由白板用 DOMPurify 清洗：脚本、事件属性、javascript: 链接（包括实体编码的）、foreignObject、<style> 都去掉
test("stickerSvgSanitize", async () => {
  const bad: Record<string, string> = {
    onload: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" onload="window.__pwned=1"><circle cx="8" cy="8" r="6" onclick="window.__pwned=2"/></svg>`,
    script: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><script>window.__pwned=3</script><rect width="16" height="16"/></svg>`,
    jshref: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16"><a href="javascript:window.__pwned=4"><rect width="8" height="8"/></a><a xlink:href="javascript:alert(1)"><rect x="8" width="8" height="8"/></a></svg>`,
    entity: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><a href="&#106;avascript&#58;window.__pwned=5"><rect width="16" height="16"/></a><a href="&#x6A;&#x61;vascript:x"><rect width="4" height="4"/></a></svg>`,
    foreign: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><foreignObject width="16" height="16"><iframe src="javascript:window.__pwned=6"></iframe><img src="x" onerror="window.__pwned=7"></foreignObject><style>body{display:none}</style><path d="M0 0h16v16z"/></svg>`,
  };
  const b = emptyBoard("b1", "svg");
  Object.keys(bad).forEach((name, i) => b.stickers.push({ id: "k" + i, icon: { pack: "evil", name }, at: { kind: "canvas", x: 200 + i * 60, y: 200, size: 40 } }));
  const h = await open({ board: b, light, on: (m, reply) => (m.type === "stickerPacks" ? (void reply(m.req!, [{ id: "evil", name: "Evil", icons: Object.entries(bad).map(([name, svg]) => ({ name, svg })) }]), true) : false) });
  await h.page.locator('.bbar button[aria-label="Sticker"]').click();
  await h.page.locator(".glyph.custom").first().waitFor(); await idle(h); // the pack comes with the host's reply
  const r = await h.page.evaluate(() => {
    const gs = [...document.querySelectorAll(".glyph.custom")];
    const html = gs.map((g) => g.innerHTML).join("\n");
    const attrs = gs.flatMap((g) => [...g.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => `${a.name}=${a.value}`)));
    return { n: gs.length, html, pwned: (window as any).__pwned, script: /<script|<foreignobject|<iframe|<style|<img/i.test(html), on: attrs.filter((a) => /^on/i.test(a)), js: attrs.filter((a) => /javascript/i.test(a)), svgs: gs.filter((g) => g.querySelector("svg")).length };
  });
  const ok = r.n >= 5 && r.svgs === r.n && !r.pwned && !r.script && !r.on.length && !r.js.length;
  check("sticker-svg-clean", ok, JSON.stringify({ n: r.n, svgs: r.svgs, pwned: r.pwned, script: r.script, on: r.on, js: r.js }));
  if (!ok) console.log(r.html);
  await close(h);
});

test("emptyCardDiscard", async () => {
  const b = emptyBoard("b1", "fresh");
  const h = await open({ board: b, light });
  await h.page.locator('.bbar button[aria-label="Note"]').click(); await h.page.locator(".md-pm:focus").waitFor(); await idle(h);
  await h.page.mouse.click(1000, 700); await idle(h); // leaving the empty note discards it
  await h.page.locator('.bbar button[aria-label="Code"]').click();
  await h.page.locator(".ctx button", { hasText: /^New Code$/ }).click(); await h.page.locator(".card .cm-content:focus").waitFor();
  await shot(h, "board-09-newcode");
  await hold(h, DBL_CLICK, "two single clicks on the same spot, not a double-click (which would make a Text)");
  await h.page.mouse.click(1000, 700);
  // dropping an untouched new card is a live change: the board sends it LIVE_DELAY later (a timer idle() can't see)
  await expect(h.page.locator(".card")).toHaveCount(0);
  await hold(h, LIVE_DELAY, "the discard is sent to the host after LIVE_DELAY"); await idle(h);
  const n = h.board().cards.length;
  await h.page.locator('.bbar button[aria-label="More"]').click();
  await h.page.locator(".ctx button", { hasText: /^Undo/ }).waitFor();
  const undo = await h.page.locator(".ctx button", { hasText: /^Undo/ }).isDisabled();
  check("fresh-discard", n === 0 && undo, JSON.stringify({ n, undoDisabled: undo, kinds: h.board().cards.map((c: any) => c.kind + ":" + (c.md ?? c.segments?.[0]?.text)) }));
  await close(h);
});

test("cardResizeFit", async () => {
  const b = emptyBoard("b1", "fit");
  const one = card("Scheduler.is_finished");
  put(b, one, 80, 80, 700);
  const h = await open({ board: b, light });
  const grip = h.page.locator(".card .grip").first();
  const g = (await grip.boundingBox())!;
  await h.page.mouse.move(g.x + 7, g.y + 7); await h.page.mouse.down(); await h.page.mouse.move(g.x + 7, g.y + 200, { steps: 6 }); await h.page.mouse.up();
  await until(h, "the resize is saved", () => h.board().place[one.id].h); await idle(h);
  const tall = h.board().place[one.id].h;
  const g2 = (await grip.boundingBox())!;
  await h.page.mouse.move(g2.x + 7, g2.y + 7); await h.page.mouse.down(); await h.page.mouse.move(g2.x + 7, g2.y - 400, { steps: 8 }); await h.page.mouse.up();
  const short = (await h.page.locator(".card").first().boundingBox())!.height;
  await shot(h, "board-10-short");
  await grip.dblclick(); await idle(h);
  const p = h.board().place[one.id];
  check("resize-fit", tall && short < 100 && p.w < 700, JSON.stringify({ tall, short, fit: p }));
  await shot(h, "board-11-fit");
  await close(h);
});

// the empty-space context menu stays fully inside the window at all four corners
test("contextMenuCorners", async () => {
  const b = emptyBoard("b1", "ctx");
  put(b, card("Scheduler.schedule"), 80, 80, 560);
  const h = await open({ board: b, light });
  const vw = h.page.viewportSize()!;
  const out: any[] = [];
  for (const [x, y] of [[vw.width - 8, 8], [8, vw.height - 70], [vw.width - 8, vw.height - 70], [vw.width - 30, vw.height / 2]]) {
    await h.page.mouse.click(x, y, { button: "right" });
    await h.page.locator(".ctx button").first().waitFor(); await idle(h);
    const r = await h.page.locator(".ctx").first().evaluate((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, sh: e.scrollHeight, ch: e.clientHeight }; });
    out.push(r && { at: [x, y], ...r, ok: r.l >= 0 && r.t >= 0 && r.r <= vw.width && r.b <= vw.height });
    await shot(h, `board-ctx-${out.length}`);
    await h.page.keyboard.press("Escape"); await idle(h);
  }
  check("ctx-in-viewport", out.every((o) => o?.ok), JSON.stringify(out));
  await close(h);
});

/** Stickers bound to a card / arrow: follow when the card is dragged; covered along with it by other cards; dashed outline when selected */
test("stickerBinding", async () => {
  const b = richBoard();
  const post = b.cards[2].id;
  b.stickers.push({ id: "k6", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 420, y: 70, size: 32, on: { card: post } } });
  b.stickers.push({ id: "k7", icon: { pack: "builtin", name: "todo-text" }, at: { kind: "canvas", x: 10, y: -40, size: 28, on: { link: "L2", t: 0.5 } } });
  b.cards.push({ id: "nb", kind: "note", md: "Covers the star", look: "note" });
  b.place.nb = { x: 520, y: 470, w: 260 };
  const h = await open({ board: b, light, w: 1400, h: 900 });
  const pos = () => h.page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-sticker]")].map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.sticker, [Math.round(r.left), Math.round(r.top)]]; })));
  const p0 = await pos();
  // Covered: card nb is above post, k6 is below nb
  const covered = await h.page.evaluate(() => { const e = document.querySelector<HTMLElement>('[data-sticker="k6"]')!; const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement; return !!top.closest('.card[data-id="nb"]'); });
  await shot(h, "board-bind-1");
  const hd = h.page.locator(`.card[data-id="${post}"] .chead`).first();
  const r = (await hd.boundingBox())!;
  await h.page.mouse.move(r.x + 200, r.y + 15); await h.page.mouse.down(); await h.page.mouse.move(r.x + 200, r.y + 75, { steps: 6 }); await h.page.mouse.up();
  await idle(h);
  const p1 = await pos();
  const follows = p1.k6[1] - p0.k6[1] === 60 && p1.k6[0] === p0.k6[0];
  const linkMoved = p1.k7[1] !== p0.k7[1] || p1.k7[0] !== p0.k7[0];
  await h.page.locator('[data-sticker="k7"]').click();
  // the pointer has left the dragged card: its hover ends only after linkLeave (a timer idle() can't see), then its arrows fade back down
  await hold(h, LINK_LEAVE, "the hover on the dragged card ends after linkLeave");
  await idle(h);
  await shot(h, "board-bind-2");
  const tether = await h.page.locator(".tether line").count();
  // Drag k5 (on the canvas) onto the schedule card → binds to it
  const k5 = (await h.page.locator('[data-sticker="k5"]').boundingBox())!;
  const sch = (await h.page.locator(`.card[data-id="${b.cards[1].id}"]`).boundingBox())!;
  await h.page.mouse.move(k5.x + 10, k5.y + 10); await h.page.mouse.down(); await h.page.mouse.move(sch.x + 200, sch.y + 200, { steps: 8 });
  const hot = await h.page.locator(".card.bind-hot").count();
  await h.page.mouse.up(); await idle(h);
  const bound = await h.page.evaluate(() => !!document.querySelector('.card [data-sticker="k5"]'));
  await shot(h, "board-bind-3");
  check("sticker-bind", covered && follows && linkMoved && tether === 1 && hot === 1 && bound, JSON.stringify({ covered, follows, linkMoved, tether, hot, bound, p0: p0.k6, p1: p1.k6 }));
  await close(h);
});

/** Child below-right, horizontally overlapping the parent: start auto-anchors on the right, enters the child from the top; once the user moves it to the left it takes more distance to flip back */
test("childArrowAnchor", async () => {
  const b = emptyBoard("b1", "side");
  const par = card("ModelRunner.__init__"), kid = card("load_model");
  put(b, par, 20, 20, 1100); put(b, kid, 850, 560, 600);
  const s0 = par.segments[0], ln = lineOf(par, /load_model\(/);
  b.links.push({ id: "L1", from: { card: par.id, seg: s0.id, line: ln }, to: { card: kid.id }, call: { name: "load_model", col: 8 } });
  b.cam = { x: 0, y: 0, z: 0.7 };
  const h = await open({ board: structuredClone(b), light, w: 1400, h: 900 });
  const port = (hh: Host) => hh.page.locator("path.port").first().evaluate((e) => +e.getAttribute("data-x")!);
  const auto = await port(h);
  await shot(h, "board-side-1");
  await close(h);
  b.links[0].sides = { from: "left" };
  const h2 = await open({ board: structuredClone(b), light, w: 1400, h: 900 });
  const user = await port(h2);
  await shot(h2, "board-side-2");
  await close(h2);
  check("call-side", auto > 1000 && user < 100, JSON.stringify({ auto, user }));
});

/** Turn into Text / Turn into Note on a Note without a title: the words stay where they are, same size and wrap width */
test("noteTurnIntoTextKeepsWordsInPlace", async () => {
  const b = emptyBoard("b1", "notebg");
  b.cards.push({ id: "n1", kind: "note", md: "Hello\n$a$\n\n$$aaa$$", look: "note" });
  b.place.n1 = { x: 120, y: 120, w: 300 };
  const h = await open({ board: b, light, w: 900, h: 600 });
  const first = () => h.page.evaluate(() => { const c = document.querySelector('.card[data-id="n1"]')!; const t = c.querySelector(".nbody, .tx")!; const r = document.createRange(); r.selectNodeContents(t); const q = r.getClientRects()[0]; const f = getComputedStyle(t).fontSize; const cs = getComputedStyle(t); return { x: Math.round(q.left), y: Math.round(q.top), f, w: Math.round(t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) }; });
  const turn = async (to: string) => {
    const box = (await h.page.locator('.card[data-id="n1"]').boundingBox())!;
    await h.page.mouse.click(box.x + 100, box.y + box.height - 12, { button: "right" });
    await h.page.locator(".ctx button", { hasText: to }).click(); await idle(h);
    await h.page.mouse.click(10, 500); await idle(h);
  };
  const a = await first();
  await shot(h, "board-notebg-1");
  await turn("Turn into Text");
  const c = await first();
  await shot(h, "board-notebg-2");
  const same = (p: typeof a, q: typeof a) => Math.abs(p.x - q.x) <= 1 && Math.abs(p.y - q.y) <= 1 && p.f === q.f && Math.abs(p.w - q.w) <= 1;
  check("noteTurnIntoTextKeepsWordsInPlace text", h.board().cards[0].kind === "note" && (h.board().cards[0] as NoteCard).look === "text" && same(a, c), { a, c });
  await turn("Turn into Note");
  const d = await first();
  check("noteTurnIntoTextKeepsWordsInPlace back", (h.board().cards[0] as NoteCard).look === "note" && same(a, d), { a, d });
  await close(h);
});

/** Card menu submenu opened near the right edge: flips left without covering the parent menu */
test("submenuFlip", async () => {
  const b = emptyBoard("b1", "sub");
  put(b, card("Scheduler.schedule"), 700, 80, 560);
  const h = await open({ board: b, light, w: 1300, h: 800 });
  const vw = h.page.viewportSize()!;
  await h.page.mouse.click(vw.width - 30, 200, { button: "right" });
  await h.page.locator(".ctx button", { hasText: "View" }).hover(); await idle(h); // the submenu opens on pointerenter
  const rs = await h.page.locator(".ctx").evaluateAll((es) => es.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }));
  await shot(h, "board-submenu");
  const [m, s] = rs;
  const ok = rs.length === 2 && (s.l >= m.r - 6 || s.r <= m.l + 6) && s.r <= vw.width && s.l >= 0;
  check("submenu-no-cover", ok, JSON.stringify(rs));
  await close(h);
});

/** Code card menu: Edit ▸ Add Description enters editing, type, ⌘↵ saves; title bar has a Copy Code icon */
test("codeDescription", async () => {
  const b = emptyBoard("b1", "desc");
  put(b, card("Scheduler.schedule"), 80, 80, 560);
  const h = await open({ board: b, light, w: 1200, h: 800 });
  const hd = h.page.locator(".card .chead").first();
  await hd.click({ button: "right", position: { x: 200, y: 12 } }); await h.page.locator(".ctx button").first().waitFor();
  await shot(h, "board-cardmenu");
  await h.page.locator('.ctx button:has(.lb:text-is("Edit"))').hover();
  await shot(h, "board-cardmenu-edit");
  await h.page.locator(".ctx button", { hasText: "Add Description" }).click(); await idle(h);
  const editing = await h.page.locator(".cdesc.editing").count();
  const focused = await h.page.evaluate(() => !!document.activeElement?.closest(".cdesc"));
  await h.page.keyboard.type("Picks prefill first."); await h.page.keyboard.press("Meta+Enter"); await h.page.keyboard.press("Control+Enter"); await idle(h);
  const desc = (h.board().cards[0] as any).desc;
  await hd.hover(); await idle(h);
  const cpy = await h.page.locator(".chead .ib.cpy").first().evaluate((e) => getComputedStyle(e).opacity);
  await shot(h, "board-desc");
  check("add-description", editing === 1 && focused && desc === "Picks prefill first." && cpy === "1", JSON.stringify({ editing, focused, desc, cpy }));
  await close(h);
});

/** Link label boxes: ↺ + variables, custom label + variables, ↺ only, label only */
test("linkLabelBoxes", async () => {
  const b = richBoard();
  const L1 = b.links[0] as any, L2 = b.links[1] as any;
  L1.call.loop = true; L2.label = "my own label"; L2.call.loop = true;
  const step = b.cards[0], tail = card("Scheduler.preempt");
  put(b, tail, 780, 640, 420);
  b.links.push({ id: "L3", from: { card: b.cards[2].id }, to: { card: tail.id }, label: "only a label" });
  void step;
  const h = await open({ board: b, light, w: 1400, h: 950 });
  await shot(h, "board-vlabel");
  const n = await h.page.locator(".vcard").count();
  check("vlabel-boxes", n === 3, n);
  await close(h);
});

/** Double-click empty space for new Text: same font and position while editing as when displayed, no white box */
test("dblclickText", async () => {
  const h = await open({ board: emptyBoard("b1", "dbl"), light, w: 900, h: 600 });
  await h.page.mouse.dblclick(300, 200); await h.page.locator(".tx.editing").waitFor();
  await shot(h, "board-dbl-1");
  await h.page.keyboard.type("Hello board");
  await shot(h, "board-dbl-2");
  const r = await h.page.evaluate(() => { const t = document.querySelector<HTMLElement>(".tx.editing")!; const cs = getComputedStyle(t); const c = t.closest(".card")!.getBoundingClientRect(), tr = t.getBoundingClientRect(); return { font: cs.fontFamily.slice(0, 20), bg: cs.backgroundColor, sh: cs.boxShadow, inset: Math.round(tr.left - c.left), w: Math.round(c.width - tr.width) }; });
  check("dblclick-text", r.sh === "none" && r.inset < 10 && r.w < 20, JSON.stringify(r));
  await close(h);
});

/** Empty New Code: clicking its own language dropdown and picking an item keeps the card; it disappears only after clicking empty space */
test("freeCodeLanguage", async () => {
  const h = await open({ board: emptyBoard("b1", "free"), light, w: 1300, h: 700 });
  await h.page.mouse.click(300, 200, { button: "right" });
  await h.page.locator(".ctx button", { hasText: "New Code" }).click(); await idle(h);
  await h.page.locator(".card .chead .lang").first().click();
  await h.page.locator(".ctx button").nth(2).waitFor(); await idle(h);
  const afterOpen = await h.page.locator(".card").count();
  await h.page.locator(".ctx button").nth(2).click(); await idle(h);
  const afterPick = await h.page.locator(".card").count();
  // the editor is CodeMirror: its contentDOM inside .freecode has the focus
  const focused = await h.page.evaluate(() => !!document.activeElement?.closest(".freecode"));
  await h.page.mouse.click(800, 500); await idle(h);
  const afterAway = await h.page.locator(".card:not(.ghost-out)").count();
  check("free-lang-keeps-card", afterOpen === 1 && afterPick === 1 && focused && afterAway === 0, JSON.stringify({ afterOpen, afterPick, focused, afterAway }));
  await close(h);
});

/** With codeboard.debug.enabled, Settings has a Debug section; drag the slider to change Peek delay */
test("debugSettings", async () => {
  const h = await open({ board: emptyBoard("b1", "dbg"), light, w: 1200, h: 900, settings: { debug: true } });
  await h.page.keyboard.press("Meta+,");
  await h.page.locator('[data-sec="debug"]').scrollIntoViewIfNeeded();
  await shot(h, "board-debug");
  const n = await h.page.locator('[data-sec="debug"] .st-tr').count();
  check("debug-tune", n >= 6, n);
  await close(h);
});

/**
 * Fast drag: no snapping; slow drag, or a fast one held still before the drop: alignment snap (left edge to another card). Whether a drag snaps depends on its
 * speed (SNAP_SPEED, measured with performance.now() between pointer moves) and on a pause (no move for SNAP_SETTLE = speed 0), so
 * the drags run on Playwright's clock: paused, and moved on by exactly `ms` per step. A busy machine then can't make the fast drag
 * slow (or pause it) between two moves; with the real clock it did.
 */
test("dragSnap", async () => {
  const b = emptyBoard("b1", "snap");
  b.cards.push({ id: "a", kind: "note", md: "A", look: "note" }, { id: "m", kind: "note", md: "moving", look: "note" });
  b.place.a = { x: 100, y: 100, w: 260 }; b.place.m = { x: 500, y: 400, w: 260 };
  const h = await open({ board: b, light, w: 1200, h: 800 });
  const pg = h.page, hd = pg.locator('.card[data-id="m"] .chead');
  await pg.clock.install();
  // `steps` moves of `to / steps` px each, `ms` of the page's clock apart; then `rest` ms without a move before the drop
  const drag = async (to: number, steps: number, ms: number, rest: number) => {
    const r = (await hd.boundingBox())!;
    const x0 = r.x + 40, y = r.y + 10;
    await pg.mouse.move(x0, y);
    // pauseAt only goes forward, and the clock runs on after it is read: pause a minute ahead (timers due by then just fire)
    await pg.clock.pauseAt((await pg.evaluate(() => Date.now())) + 60e3);
    await pg.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await pg.clock.runFor(ms);
      await pg.mouse.move(x0 + (to * i) / steps, y);
    }
    if (rest) await pg.clock.runFor(rest);
    await pg.mouse.up();
    await pg.clock.resume();
    await idle(h); // the drop is sent at once
    return Math.abs(to / steps) / ms * 1000;
  };
  const back = async () => {
    await pg.keyboard.press("Meta+z");
    await until(h, "undo puts the card back", () => h.board().place.m.x === 500); await idle(h);
  };
  // each drag stops at x = 103, only 3px from the other card's left edge at 100
  const fastSpeed = await drag(-397, 4, 16, 0); // dropped while still fast: stays at 103
  const fastX = h.board().place.m.x;
  await back();
  await drag(-397, 4, 16, 2 * SNAP_SETTLE); // fast, then held still before the drop: snaps
  const stoppedX = h.board().place.m.x;
  await back();
  const slowSpeed = await drag(-397, 30, 50, 0); // slow all the way, dropped at once: snaps
  const slowX = h.board().place.m.x;
  check("snap-only-when-slow", fastSpeed > SNAP_SPEED && slowSpeed < SNAP_SPEED && fastX === 103 && stoppedX === 100 && slowX === 100,
    JSON.stringify({ fastX, stoppedX, slowX, fastSpeed, slowSpeed }));
  await close(h);
});

/** Image cards have no title bar; dragging the image itself moves the card */
test("imageCardDrag", async () => {
  const b = emptyBoard("b1", "img");
  const svg = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#e8a33d"/><text x="40" y="130" font-size="40">diagram</text></svg>');
  b.cards.push({ id: "i1", kind: "image", src: svg, bg: true } as any);
  b.place.i1 = { x: 120, y: 120, w: 400, h: 240 };
  const h = await open({ board: b, light, w: 1000, h: 700 });
  const heads = await h.page.locator('.card[data-id="i1"] .chead').count();
  const r = (await h.page.locator('.card[data-id="i1"]').boundingBox())!;
  await h.page.mouse.move(r.x + 200, r.y + 120); await h.page.mouse.down(); await h.page.mouse.move(r.x + 260, r.y + 170, { steps: 8 }); await idle(h); await h.page.mouse.up(); await idle(h);
  const p = h.board().place.i1;
  await shot(h, "board-img");
  check("image-drag-body", heads === 0 && p.x === 180 && p.y === 170, JSON.stringify({ heads, x: p.x, y: p.y }));
  await close(h);
});

/** Sticker dropped outside a card within 20px of its edge: still snaps and binds (card gets a highlight ring) */
test("stickerMagnet", async () => {
  const b = richBoard();
  const h = await open({ board: b, light, w: 1500, h: 950 });
  const k5 = (await h.page.locator('[data-sticker="k5"]').boundingBox())!;
  const sch = (await h.page.locator(`.card[data-id="${b.cards[1].id}"]`).boundingBox())!;
  await h.page.mouse.move(k5.x + 20, k5.y + 20); await h.page.mouse.down();
  await h.page.mouse.move(sch.x + 30, sch.y - 22, { steps: 10 });
  const hot = await h.page.locator(".card.bind-hot").count();
  await shot(h, "board-magnet");
  await h.page.mouse.up(); await idle(h);
  const at = h.board().stickers.find((k) => k.id === "k5")!.at as any;
  check("sticker-magnet", hot === 1 && at.on?.card === b.cards[1].id, JSON.stringify({ hot, at }));
  await close(h);
});

/** Space below the parent is blocked by other cards: the expanded child stays in view, not off-screen */
test("expandStaysInView", async () => {
  const b = emptyBoard("b1", "board");
  const step = card("LLMEngine.step");
  put(b, step, 80, 80, 600);
  for (let i = 0; i < 3; i++) { const id = `wall${i}`; b.cards.push({ id, kind: "note", md: `wall ${i}`, look: "note" } as any); b.place[id] = { x: -200 + i * 900, y: 640, w: 860, h: 3000 }; }
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1500, h: 950 });
  await h.page.locator(`.card[data-id="${step.id}"] .src .call`, { hasText: /^schedule$/ }).first().click();
  await until(h, "the call expands into a new card", () => h.board().cards.length === 5); await idle(h);
  const nb = h.board();
  const nid = nb.cards.find((c) => c.id !== step.id && !c.id.startsWith("wall"))?.id;
  const r = nid && (await h.page.locator(`.card[data-id="${nid}"]`).boundingBox());
  await shot(h, "board-placeview");
  const ok = !!r && !!nid && nb.place[nid].y < 900 && r.y >= 0 && r.y < 950 - 100 && r.x >= 0 && r.x < 1500 - 100;
  check("place-in-view", ok, JSON.stringify({ p: nid && nb.place[nid], r }));
  await close(h);
});

/** Deleting a sidenote: the popup stays next to the marker instead of jumping to the top-left */
test("sidenoteDelete", async () => {
  const b = richBoard();
  const n1 = b.sidenotes[0];
  b.sidenotes.push({ ...n1, id: "n2", md: "Second note." } as any);
  const h = await open({ board: b, light, w: 1500, h: 950 });
  await h.page.locator(".mk").first().click(); await h.page.locator(".pop.k-notes").waitFor(); await idle(h);
  const p0 = (await h.page.locator(".pop.k-notes").boundingBox())!;
  await h.page.locator('.pop.k-notes [aria-label="Delete Sidenote"]').click();
  await until(h, "the sidenote is deleted", () => h.board().sidenotes.length === 1); await idle(h);
  const p1 = (await h.page.locator(".pop.k-notes").boundingBox())!;
  await shot(h, "board-notedel");
  const ok = Math.abs(p1.x - p0.x) < 30 && Math.abs(p1.y - p0.y) < 30 && h.board().sidenotes.length === 1;
  check("note-delete-stays", ok, JSON.stringify({ p0, p1 }));
  await close(h);
});

/** # headings in Notes have levels; ⌘A in the editor selects only that note's text */
test("noteHeadings", async () => {
  const b = emptyBoard("b1", "board");
  b.cards.push({ id: "t1", kind: "note", md: "# Head\n\n## Sub\n\nBody text here.", look: "text" } as any); b.place.t1 = { x: 60, y: 60, w: 320 };
  b.cards.push({ id: "t2", kind: "note", md: "# Head\n\nBody text here.", look: "note" } as any); b.place.t2 = { x: 460, y: 60, w: 320 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 900, h: 500 });
  const fs = await h.page.evaluate(() => [...document.querySelectorAll(".card h1, .card h2, .card p")].map((e) => [e.tagName, parseFloat(getComputedStyle(e).fontSize)]));
  await shot(h, "board-notehead");
  await h.page.locator('.card[data-id="t2"] .nbody').dblclick(); await h.page.locator(".md-pm:focus").waitFor();
  await h.page.keyboard.press("Control+a");
  await until(h, "⌘A selects text", () => h.page.evaluate(() => String(window.getSelection()).length > 0));
  const selTxt = await h.page.evaluate(() => String(window.getSelection()));
  const h1 = fs.find((x) => x[0] === "H1")?.[1] as number, p = fs.find((x) => x[0] === "P")?.[1] as number;
  const ok = h1 >= p * 1.6 && selTxt.includes("Head") && selTxt.includes("Body text here.") && !selTxt.includes("Sub"); // 所见即所得：选中的是渲染后的字，只限这一块
  check("note-head", ok, JSON.stringify({ fs, selTxt }));
  await close(h);
});

/** Built-in stickers in every theme */
test("stickerThemes", async () => {
  const seen: Record<string, unknown> = {};
  for (const theme of ["warm-ink", "classic", "graphite", "soft-light", "drafting", "colorful", "newspaper", "poster", "ink-wash", "city"]) {
    const b = emptyBoard("b1", "board");
    const names = ["star", "question", "exclaim", "check", "flag", "zap", "bug", "todo", "heart", "hourglass", "warning", "todo-text"];
    names.forEach((n, i) => b.stickers.push({ id: `k${i}`, icon: { pack: "builtin", name: n }, at: { kind: "canvas", x: 40 + i * 52, y: 40, size: 36 } }));
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light, w: 760, h: 140, settings: { theme } as any });
    const bg = await h.page.locator('[data-sticker="k0"] circle.bg').evaluate((e) => getComputedStyle(e).fill);
    await shot(h, `board-stk-${theme}`);
    const got = { look: await h.page.evaluate(() => document.documentElement.dataset.look), drawn: await h.page.evaluate(() => [...document.querySelectorAll("[data-sticker]")].filter((e) => e.getBoundingClientRect().width > 0 && (e.querySelector("svg") || e.textContent?.trim())).length), bg };
    seen[theme] = got;
    check(`stickerThemes ${theme}: every built-in sticker is drawn, its badge filled`, got.look === theme && got.drawn === names.length && !/^(none|transparent|rgba\(0, 0, 0, 0\))$/.test(bg), got);
    await close(h);
  }
  // the badge takes the theme's colors: not one color for all
  check("stickerThemes the badge color follows the theme", new Set(Object.values(seen).map((x: any) => x.bg)).size >= 5, seen);
});

/** Code card metrics per theme: char width, line height, header height, code area vertical padding; cards must fit the same content after a theme switch */
test("themeMetrics", async () => {
  const rows: any[] = [];
  for (const theme of ["warm-ink", "classic", "graphite", "soft-light", "drafting", "colorful", "newspaper", "poster", "ink-wash", "city"]) {
    const b = richBoard();
    const h = await open({ board: b, light, w: 1500, h: 950, settings: { theme } as any });
    await idle(h);
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
  // the code's font size, line height and character width are the same in every theme, so a card holds the same lines and columns
  const base = rows[0];
  const off = rows.filter((r) => r.fs !== base.fs || r.lh !== base.lh || Math.abs(r.ch - base.ch) > 0.05);
  check("themeMetrics code metrics are the same in every theme", off.length === 0, { base: { fs: base.fs, lh: base.lh, ch: base.ch }, off });
});

/** Fixed-height code card: visible code area height unchanged after a theme switch */
test("themeKeepsHeight", async () => {
  const out: Record<string, number> = {};
  for (const theme of ["warm-ink", "classic", "soft-light", "colorful", "newspaper", "poster", "drafting", "graphite", "ink-wash", "city"]) {
    const b = richBoard();
    b.place[b.cards[1].id].h = 164; // code area height: 200 tall in Warm Ink
    const h = await open({ board: b, light, w: 1500, h: 950, settings: { theme } as any });
    await idle(h);
    out[theme] = await h.page.locator(`.card[data-id="${b.cards[1].id}"] .cbody`).evaluate((e) => Math.round(e.getBoundingClientRect().height));
    await close(h);
  }
  const v = Object.values(out);
  check("theme-fit", Math.max(...v) - Math.min(...v) <= 6, JSON.stringify(out));
});

/** Definition preview: closes when the mouse leaves */
test("peekClosesOnLeave", async () => {
  const b = emptyBoard("b1", "board");
  const sch = card("Scheduler.schedule"); put(b, sch, 200, 80, 560); b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1300, h: 900 });
  await h.page.locator(".card .src .call", { hasText: /^can_allocate$/ }).first().hover();
  await h.page.locator(".pop.k-peek").waitFor(); await idle(h); // after the hover delay and the host's peek reply
  const shown = await h.page.locator(".pop.k-peek").count();
  await h.page.mouse.move(5, 500);
  await expect(h.page.locator(".pop.k-peek")).toHaveCount(0); await idle(h);
  const after = await h.page.locator(".pop.k-peek").count();
  await shot(h, "board-peekleave");
  check("peek-leave", shown === 1 && after === 0, JSON.stringify({ shown, after }));
  await close(h);
});

/** Warm Ink: arrow shape when the child is up-right and horizontally close (check screenshot) */
test("arrowShapeUpRight", async () => {
  const b = richBoard();
  b.place[b.cards[0].id] = { ...b.place[b.cards[0].id], x: 80, y: 420 };
  b.place[b.cards[1].id] = { ...b.place[b.cards[1].id], x: 760, y: 40 };
  b.place[b.cards[2].id] = { ...b.place[b.cards[2].id], x: 760, y: 900 };
  const h = await open({ board: b, light: true, w: 1500, h: 950 });
  await shot(h, "board-arrowup");
  // the call arrow L1 leaves the call's row on the parent's right edge, rises through the gap and enters the child's left edge
  // at its title, without going round either card
  const r = await h.page.evaluate(([from, to]) => {
    const box = (id: string) => document.querySelector(`.card[data-id="${id}"]`)!.getBoundingClientRect();
    const a = box(from), c = box(to);
    const path = document.querySelector('path.lhit[data-link="L1"]') as SVGPathElement, m = path.getScreenCTM()!, len = path.getTotalLength();
    const pts = Array.from({ length: 41 }, (_, i) => { const q = path.getPointAtLength((len * i) / 40); return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f }; });
    return { a: { right: a.right, top: a.top, bottom: a.bottom }, c: { left: c.left, top: c.top }, start: pts[0], end: pts[40],
      inGap: pts.every((q) => q.x >= a.right - 2 && q.x <= c.left + 2), rising: pts.every((q, i) => i === 0 || q.y <= pts[i - 1].y + 0.5) };
  }, [b.cards[0].id, b.cards[1].id]);
  const ok = Math.abs(r.start.x - r.a.right) <= 12 && r.start.y > r.a.top && r.start.y < r.a.bottom && Math.abs(r.end.x - r.c.left) <= 12
    && r.end.y >= r.c.top && r.end.y <= r.c.top + 48 && r.inGap && r.rising;
  check("arrowShapeUpRight the arrow to an up-right child runs straight up through the gap between the cards", ok, r);
  await close(h);
});

/** Cards grow taller after a theme switch: overlapped cards get pushed down (one undoable step); left alone when set to overlap */
test("themeReflow", async () => {
  const base = richBoard();
  let h = await open({ board: base, light, w: 1500, h: 950 });
  const r0 = (await h.page.locator(`.card[data-id="${base.cards[0].id}"]`).boundingBox())!;
  await close(h);
  const y0 = Math.round(r0.y + r0.height + 20); // cam = (0,0,1): screen coordinates equal board coordinates
  const res: any = {};
  for (const mode of ["push", "overlap"] as const) {
    const b = richBoard();
    const st = b.cards[0].id, post = b.cards[2].id;
    b.place[post] = { ...b.place[post], x: 80, y: y0 };
    h = await open({ board: b, light, w: 1500, h: 950, settings: { themeReflow: mode } as any });
    await h.page.keyboard.press("Control+,");
    await h.page.locator(".st-sw", { hasText: "Colorful" }).click(); await idle(h);
    await h.page.keyboard.press("Escape"); await idle(h);
    const y1 = h.board().place[post].y;
    const a = (await h.page.locator(`.card[data-id="${st}"]`).boundingBox())!, p = (await h.page.locator(`.card[data-id="${post}"]`).boundingBox())!;
    res[mode] = { y1, overlap: a.y + a.height > p.y };
    if (mode === "push") await shot(h, "board-reflow");
    await close(h);
  }
  const ok = res.push.y1 > y0 && !res.push.overlap && res.overlap.y1 === y0;
  check("theme-reflow", ok, JSON.stringify({ y0, res }));
});

/** A theme switch is not an undo step: ⌘Z after it undoes the previous change, and the reflow push stays */
test("themeNotUndoStep", async () => {
  const base = richBoard();
  let h = await open({ board: base, light, w: 1500, h: 950 });
  const r0 = (await h.page.locator(`.card[data-id="${base.cards[0].id}"]`).boundingBox())!;
  await close(h);
  const y0 = Math.round(r0.y + r0.height + 20);
  const b = richBoard();
  const post = b.cards[2].id, name0 = b.name;
  b.place[post] = { ...b.place[post], x: 80, y: y0 };
  h = await open({ board: b, light, w: 1500, h: 950 });
  await h.post({ type: "rename", name: "Renamed" });
  await until(h, "the rename is saved", () => h.board().name === "Renamed"); await idle(h);
  await h.page.keyboard.press("Control+,");
  await h.page.locator(".st-sw", { hasText: "Colorful" }).click(); await idle(h);
  await h.page.keyboard.press("Escape"); await idle(h);
  const y1 = h.board().place[post].y;
  await h.page.keyboard.press("Meta+z"); await idle(h);
  const u = { name: h.board().name, y: h.board().place[post].y };
  await h.page.keyboard.press("Meta+z"); await idle(h);
  const u2 = { name: h.board().name, y: h.board().place[post].y };
  const ok = y1 > y0 && u.name === name0 && u.y === y1 && u2.y === y1;
  check("theme-undo", ok, JSON.stringify({ y0, y1, u, u2 }));
  await close(h);
});

/** ⌘C a card then ⌘V: the copy goes next to the original (offset 36, overlap allowed), no search for free space */
test("pasteNearOriginal", async () => {
  const b = richBoard();
  const st = b.cards[0] as CodeCard;
  const h = await open({ board: b, light, w: 1500, h: 950 });
  await h.page.locator(`.card[data-id="${st.id}"] .chead .ctitle`).click(); await h.page.locator(`.card.sel[data-id="${st.id}"]`).waitFor();
  await h.page.keyboard.press("Control+c");
  await until(h, "⌘C copies the card", () => h.sent.some((m) => m.type === "copyCards")); await idle(h);
  await h.page.mouse.move(1300, 800);
  const text = st.segments[0].text.join("\n");
  await h.page.evaluate((t) => { const dt = new DataTransfer(); dt.setData("text/plain", t); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); }, text);
  await until(h, "the pasted card is saved", () => h.board().cards.length === b.cards.length + 1); await idle(h);
  const nb = h.board(), p0 = nb.place[st.id];
  const nid = nb.cards.find((c) => !b.cards.some((o) => o.id === c.id))?.id;
  const p1 = nid ? nb.place[nid] : undefined;
  await shot(h, "board-pastenear");
  const ok = !!p1 && p1.x === p0.x + 36 && p1.y === p0.y + 36;
  check("paste-near", ok, JSON.stringify({ p0, p1 }));
  await close(h);
});

/** Drag from a line onto another card's line number → links to that line (the line highlights before release) */
test("lineToLineLink", async () => {
  const b = richBoard();
  b.links = [];
  const h = await open({ board: b, light, w: 1500, h: 950 });
  const step = b.cards[0].id, sch = b.cards[1].id;
  const row = (await h.page.locator(`.card[data-id="${step}"] .src .l`).nth(4).boundingBox())!;
  await h.page.mouse.move(row.x + 100, row.y + row.height / 2); await h.page.locator(`.card[data-id="${step}"] .lport.r`).waitFor(); await idle(h);
  const p = (await h.page.locator(`.card[data-id="${step}"] .lport.r`).boundingBox())!;
  const no = (await h.page.locator(`.card[data-id="${sch}"] .gutter .no`).nth(5).boundingBox())!;
  await h.page.mouse.move(p.x + 4, p.y + 4); await h.page.mouse.down();
  await h.page.mouse.move(no.x + no.width / 2, no.y + no.height / 2, { steps: 10 });
  const lit = await h.page.locator(`.card[data-id="${sch}"] .no.drop`).count();
  await shot(h, "board-line2line-1");
  await h.page.mouse.up();
  await until(h, "the new arrow is saved", () => h.board().links.length); await idle(h);
  const l = h.board().links[0] as any;
  await shot(h, "board-line2line-2");
  check("line-to-line", l?.from.line && l?.to.line && lit === 1, JSON.stringify({ from: l?.from, to: l?.to, lit }));
  await close(h);
});

/** Same call site a second time: jumps to the already expanded card instead of creating a new one */
test("reExpandJumps", async () => {
  const b = emptyBoard("b1", "reexpand");
  const step = card("LLMEngine.step");
  put(b, step, 80, 80, 600);
  const h = await open({ board: b, light, w: 1400, h: 900 });
  const call = h.page.locator(`.card[data-id="${step.id}"] .call`, { hasText: /^schedule$/ });
  await call.click();
  await until(h, "the call expands into a new card", () => h.board().cards.length === 2); await idle(h);
  const n1 = await h.page.locator(".card").count();
  await h.page.mouse.click(1300, 850); await idle(h);
  await call.click(); await idle(h); // a new card would be asked for at once; jumping flies the camera
  const n2 = await h.page.locator(".card").count();
  const selected = await h.page.locator(".card.sel").count();
  check("reexpand-reuses", n1 === 2 && n2 === 2 && selected === 1, JSON.stringify({ n1, n2, selected }));
  await close(h);
});

test("labelDragAlongArrow", async () => {
  const b = richBoard();
  const h = await open({ board: b, light, w: 1500, h: 950 });
  const box = h.page.locator('.vchips[data-link="L2"]');
  const r0 = (await box.boundingBox())!;
  await h.page.mouse.move(r0.x + 10, r0.y + 8); await h.page.mouse.down(); await h.page.mouse.move(r0.x + 10, r0.y + 120, { steps: 8 }); await h.page.mouse.up(); await idle(h); // the drop is sent at once
  const r1 = (await box.boundingBox())!;
  const at = (h.board().links.find((l) => l.id === "L2") as any).at;
  await shot(h, "board-labeldrag");
  check("label-drag", at !== undefined && Math.abs(r1.y - r0.y) > 40, JSON.stringify({ at, dy: r1.y - r0.y }));
  await close(h);
});
