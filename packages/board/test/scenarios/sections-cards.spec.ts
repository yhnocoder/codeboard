import { shot, symCard, findSym, put, type Host } from "../harness";
import { DEFAULT_SETTINGS, emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle, hold } from "../fixtures";

const close = (h: Host) => h.page.context().close();

/** Two Sections side by side: a code card in the left one, a Note with a heading in the right one */
function twoSections(): Board {
  const b = emptyBoard("b1", "nano-vllm · sections");
  const s = findSym("Scheduler.schedule");
  const code = symCard(s.f, s.s);
  put(b, code, 100, 110, 480);
  const note: NoteCard = { id: "n1", kind: "note", look: "note", md: "# KV cache budget\n\nPrefill first, then decode." };
  put(b, note, 760, 110, 320);
  b.sections.push({ id: "S1", title: "异构并行计算", x: 60, y: 60, w: 560, h: 760 });
  b.sections.push({ id: "S2", title: "Scheduling", x: 720, y: 60, w: 520, h: 420 });
  b.place[code.id].section = "S1";
  b.place.n1.section = "S2";
  return b;
}

/** Section frame: a solid hairline (no dashes), no pill behind the title, handle and caret only on hover; selected = accent */
test("sectionLook", async () => {
  const h = await open({ board: twoSections(), light });
  await h.page.keyboard.press("Shift+!"); await idle(h);
  await h.page.mouse.move(1380, 880); await idle(h);
  const look = () => h.page.evaluate(() => {
    const f = document.querySelector('.sect[data-sect="S2"]')!, l = document.querySelector('.slabel[data-sect="S2"]')!;
    const fs = getComputedStyle(f), ls = getComputedStyle(l);
    const op = (sel: string) => { const e = l.querySelector(sel); return e ? +getComputedStyle(e).opacity : -1; };
    return { border: fs.borderTopStyle, radius: parseFloat(fs.borderTopLeftRadius), cardRadius: parseFloat(getComputedStyle(document.querySelector(".card")!).borderTopLeftRadius), labelBg: ls.backgroundColor, dots: op(".dots"), chev: op(".chev2"), shadow: fs.boxShadow };
  });
  const rest = await look();
  await shot(h, "sect-look-01-idle");
  await h.page.locator('.slabel[data-sect="S2"] .sname').hover(); await idle(h); // the handle and caret fade in
  const hover = await look();
  await shot(h, "sect-look-02-hover");
  await h.page.locator('.slabel[data-sect="S2"] .sname').click(); await h.page.locator('.sect.sel[data-sect="S2"], .slabel.sel[data-sect="S2"]').first().waitFor(); await idle(h);
  const selected = await look();
  await shot(h, "sect-look-03-selected");
  const clear = (c: string) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
  check("section-look-idle", rest.border !== "dashed" && rest.radius <= rest.cardRadius + 2 && clear(rest.labelBg) && rest.dots === 0 && rest.chev === 0, rest);
  check("section-look-hover", hover.dots > 0.9 && hover.chev > 0.9, hover);
  check("section-look-selected", selected.shadow !== rest.shadow, { idle: rest.shadow, selected: selected.shadow });
  await close(h);
});

/** Section ▸ Fit Content: the frame tightens to its member cards plus the standard padding (22 at the sides and bottom, 34 at the top
 *  for the title), animated; one undo step brings the old frame back */
test("sectionFitContent", async () => {
  const b = emptyBoard("b1", "fit section");
  put(b, { id: "a", kind: "note", look: "note", md: "# Prefill\n\nChecks the free KV blocks." } as NoteCard, 240, 220, 300);
  put(b, { id: "c", kind: "note", look: "note", md: "# Decode\n\nOne token per step." } as NoteCard, 600, 300, 260);
  b.sections.push({ id: "S", title: "Scheduling", x: 80, y: 60, w: 1100, h: 760 });
  b.place.a.section = "S"; b.place.c.section = "S";
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1300, h: 900 });
  await idle(h);
  await shot(h, "sect-fit-01-before");
  await h.page.locator('.slabel[data-sect="S"] .sname').click({ button: "right" }); await h.page.locator(".ctx button").first().waitFor(); await idle(h);
  const items = await h.page.locator(".ctx button").allTextContents();
  check("sectionFitContent in the Section menu", items.some((t) => t.includes("Fit Content")), { items });
  if (!items.some((t) => t.includes("Fit Content"))) return;
  const w0 = (await h.page.locator('.sect[data-sect="S"]').boundingBox())!.width;
  await h.page.locator(".ctx button", { hasText: "Fit Content" }).click();
  const samples = await h.page.evaluate(() => new Promise<number[]>((res) => {
    const el = document.querySelector('.sect[data-sect="S"]')!, out: number[] = [];
    const f = () => { out.push(el.getBoundingClientRect().width); if (out.length < 30) requestAnimationFrame(f); else res(out); };
    requestAnimationFrame(f);
  }));
  await until(h, "Fit Content is saved", () => h.board().sections[0].w !== 1100); await idle(h);
  const got = await h.page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const f = r('.sect[data-sect="S"]'), a = r('.card[data-id="a"]'), c = r('.card[data-id="c"]');
    const want = { l: Math.min(a.left, c.left) - 22, t: Math.min(a.top, c.top) - 34, r: Math.max(a.right, c.right) + 22, b: Math.max(a.bottom, c.bottom) + 22 };
    return { frame: { l: f.left, t: f.top, r: f.right, b: f.bottom }, want };
  });
  const w1 = got.frame.r - got.frame.l;
  const mid = samples.filter((v) => v < w0 - 2 && v > w1 + 2).length;
  const s = h.board().sections[0];
  await shot(h, "sect-fit-02-after");
  const near = (x: number, y: number) => Math.abs(x - y) < 1.5;
  check("sectionFitContent wraps its members", near(got.frame.l, got.want.l) && near(got.frame.t, got.want.t) && near(got.frame.r, got.want.r) && near(got.frame.b, got.want.b)
    && near(s.x, got.want.l) && near(s.y, got.want.t) && near(s.w, w1), { got, s });
  check("sectionFitContent animated", mid >= 3, { w0, w1, samples });
  await h.page.keyboard.press("Control+z");
  await until(h, "the undo is saved", () => h.board().sections[0].w !== s.w); await idle(h);
  const back = h.board().sections[0];
  check("sectionFitContent one undo step", back.x === 80 && back.y === 60 && back.w === 1100 && back.h === 760, { back });
  await close(h);
});

/** A collapsed Section is a compact pill: a small caret, the title in bold, "· N cards" in grey. Hovering it shows a few of its cards
 *  (kind icon and title, two columns) and "+N more". The caret is one small icon that turns when the Section expands */
test("sectionCollapsedPill", async () => {
  const b = emptyBoard("b1", "collapsed section");
  const s = findSym("Scheduler.schedule");
  const code = symCard(s.f, s.s);
  put(b, code, 120, 140, 480);
  const titles = ["Prefill", "Decode", "Preemption", "Block manager", "Prefix cache", "KV budget", "Sampling"];
  titles.forEach((t, i) => put(b, { id: `n${i}`, kind: "note", look: "note", md: `# ${t}\n\nNotes.` } as NoteCard, 660 + (i % 2) * 300, 140 + Math.floor(i / 2) * 160, 260));
  for (const id of Object.keys(b.place)) b.place[id].section = "S";
  b.sections.push({ id: "S", title: "异构并行计算", x: 80, y: 80, w: 1200, h: 800, collapsed: true });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 900, h: 600 });
  await idle(h);
  await h.page.mouse.move(800, 550);
  const pill = '.slabel[data-sect="S"]';
  const look = await h.page.evaluate((sel) => {
    const p = document.querySelector(sel)!, n = p.querySelector<HTMLElement>(".sname")!, c = p.querySelector(".scount");
    const pr = p.getBoundingClientRect(), cr = c?.getBoundingClientRect();
    return { name: n.textContent, weight: +getComputedStyle(n).fontWeight, clipped: n.scrollWidth > n.clientWidth + 1, count: c?.textContent?.replace(/\s+/g, " ").trim(), countInside: !!cr && cr.right <= pr.right + 0.5,
      countGrey: !!c && getComputedStyle(c).color !== getComputedStyle(n).color };
  }, pill);
  await shot(h, "sect-pill-01-collapsed");
  check("sectionCollapsedPill title and count", look.name === "异构并行计算" && look.weight >= 600 && !look.clipped && look.count === "· 8 cards" && look.countInside && look.countGrey, look);
  // hover: a preview of a few member cards, each with its kind icon, then "+N more"
  // the preview shows PEEK_DELAY after the pointer comes onto the pill (a timer): wait for it, then for its fade-in
  await h.page.locator(`${pill} .sname`).hover(); await h.page.locator(`${pill} .spv`).waitFor({ timeout: 5000 }); await idle(h);
  const pv = await h.page.evaluate((sel) => {
    const v = document.querySelector(`${sel} .spv`);
    if (!v) return null;
    const rows = [...v.querySelectorAll(".spv-i")].map((r) => ({ icon: !!r.querySelector("svg"), text: r.textContent?.trim() }));
    return { rows, more: v.querySelector(".spv-more")?.textContent?.trim(), opacity: +getComputedStyle(v).opacity };
  }, pill);
  await shot(h, "sect-pill-02-hover-preview");
  const shownTitles = pv?.rows.map((r) => r.text) ?? [];
  check("sectionCollapsedPill hover preview", !!pv && pv.opacity > 0.9 && pv.rows.length === 5 && pv.rows.every((r) => r.icon) && shownTitles.every((t) => !!t && ([...titles, "Scheduler.schedule"].some((x) => t.includes(x)))) && pv.more === "+3 more", pv);
  await h.page.mouse.move(800, 550); await h.page.locator(`${pill} .spv`).waitFor({ state: "detached", timeout: 5000 }); await idle(h);
  const gone = await h.page.evaluate((sel) => { const v = document.querySelector(`${sel} .spv`); return !v || +getComputedStyle(v).opacity < 0.05; }, pill);
  check("sectionCollapsedPill preview hides", gone);
  // the caret: one small icon, pointing right while collapsed and down once expanded (it turns)
  const angle = () => h.page.evaluate((sel) => {
    const i = document.querySelector(`${sel} .chev2 svg`);
    if (!i) return null;
    // the turn, from the rotate property or the transform
    const cs = getComputedStyle(i), rot = cs.rotate && cs.rotate !== "none" ? parseFloat(cs.rotate) : 0;
    const m = new DOMMatrix(cs.transform === "none" ? "" : cs.transform);
    return { deg: Math.round(rot + (Math.atan2(m.b, m.a) * 180) / Math.PI), size: Math.min(i.getBoundingClientRect().width, i.getBoundingClientRect().height) };
  }, pill);
  const a0 = await angle();
  await h.page.locator(`${pill} .chev2`).click();
  await until(h, "expanding is saved", () => !h.board().sections[0].collapsed); await idle(h);
  await h.page.locator(`${pill} .sname`).hover(); await idle(h);
  const a1 = await angle();
  const gap = await h.page.evaluate((sel) => { const n = document.querySelector(`${sel} .sname`)!.getBoundingClientRect(), c = document.querySelector(`${sel} .chev2`)!.getBoundingClientRect(); return c.left - n.right; }, pill);
  await shot(h, "sect-pill-03-expanded-hover");
  check("sectionCollapsedPill caret turns", !!a0 && !!a1 && a0.size <= 12 && Math.abs(a1.deg - a0.deg) === 90 && gap >= 0 && gap < 10, { a0, a1, gap });
  await close(h);
});

/** A Note grows while its Section is collapsed (a larger Note font in the settings); revealing it expands the Section and frames the
 *  Note by its new height, not the one measured before the collapse */
test("revealFramesRegrownCard", async () => {
  const b = emptyBoard("b1", "reveal regrown");
  const md = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the Note`).join("\n\n");
  put(b, { id: "n", kind: "note", look: "note", md } as NoteCard, 2600, 1800, 420);
  b.place.n.section = "S";
  b.sections.push({ id: "S", title: "Far", x: 2560, y: 1740, w: 500, h: 900 });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1400, h: 900 });
  await idle(h);
  const short = await h.page.locator('.card[data-id="n"]').evaluate((e) => (e as HTMLElement).offsetHeight);
  await h.post({ type: "merged", patch: { sections: { set: [{ ...b.sections[0], collapsed: true }] } } });
  await h.page.locator('.card[data-id="n"]').waitFor({ state: "detached" });
  await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, noteFontSize: { ...DEFAULT_SETTINGS.noteFontSize, body: 40 } } } });
  await h.post({ type: "reveal", card: "n" });
  await h.page.locator('.card[data-id="n"]').waitFor();
  await idle(h);
  const r = await h.page.locator('.card[data-id="n"]').evaluate((e) => {
    const c = e.getBoundingClientRect();
    return { top: Math.round(c.top), bottom: Math.round(c.bottom), h: Math.round(c.height), vh: innerHeight };
  });
  await shot(h, "reveal-regrown");
  check("revealFramesRegrownCard", r.h > short * 1.8 && r.top >= 0 && r.bottom <= r.vh, { ...r, short });
  await close(h);
});

/** Drag a card by its title bar from one Section into another: the target Section lights up during the drag, the card joins it, one undo puts it back */
test("dragCardIntoOtherSection", async () => {
  const h = await open({ board: twoSections(), light });
  await h.page.keyboard.press("Shift+!"); await idle(h);
  const head = (await h.page.locator('.card[data-id="n1"] .chead').boundingBox())!;
  const card = (await h.page.locator('.card[data-id="n1"]').boundingBox())!;
  const s1 = (await h.page.locator('.sect[data-sect="S1"]').boundingBox())!;
  const s2a = (await h.page.locator('.sect[data-sect="S2"]').boundingBox())!;
  const grab = { x: head.x + 40, y: head.y + head.height / 2 };
  // put the card's centre in the lower part of S1, below the code card
  const to = { x: s1.x + s1.width / 2, y: s1.y + s1.height - card.height / 2 - 30 };
  const dx = to.x - (card.x + card.width / 2), dy = to.y - (card.y + card.height / 2);
  await h.page.mouse.move(grab.x, grab.y); await h.page.mouse.down();
  await h.page.mouse.move(grab.x + dx / 2, grab.y + dy / 2, { steps: 6 });
  await h.page.mouse.move(grab.x + dx, grab.y + dy, { steps: 10 }); await idle(h);
  const during = await h.page.evaluate(() => [...document.querySelectorAll(".sect.drop, .slabel.drop")].map((e) => (e as HTMLElement).dataset.sect));
  const s2b = (await h.page.locator('.sect[data-sect="S2"]').boundingBox())!;
  await shot(h, "sect-drag-01-over-target");
  await h.page.mouse.up(); await idle(h); // the drop is sent at once
  const after = h.board().place.n1.section;
  const lit = await h.page.locator(".sect.drop").count();
  await shot(h, "sect-drag-02-dropped");
  check("drag-into-section-highlight", during.includes("S1") && !during.includes("S2"), { during });
  // the Section the card leaves keeps its own frame during the drag instead of stretching after the card
  check("drag-source-section-stays", Math.abs(s2b.height - s2a.height) < 2 && Math.abs(s2b.width - s2a.width) < 2, { before: s2a, during: s2b });
  check("drag-into-section-joins", after === "S1" && lit === 0, { after, lit });
  await h.page.keyboard.press("Control+z"); await idle(h);
  check("drag-into-section-undo", h.board().place.n1.section === "S2", { section: h.board().place.n1.section });
  // the same move from the card menu: Move to Section ▸ 异构并行计算 (the card lands inside that Section's frame)
  await h.page.locator('.card[data-id="n1"] .chead').click({ button: "right" });
  await h.page.locator(".ctx button", { hasText: "Move to Section" }).hover();
  await h.page.locator(".ctx button", { hasText: "异构并行计算" }).waitFor();
  await shot(h, "sect-menu-01-move-to");
  await h.page.locator(".ctx button", { hasText: "异构并行计算" }).click();
  await until(h, "Move to Section saves the card in S1", () => h.board().place.n1.section !== "S2"); await idle(h);
  const p = h.board().place.n1, f = (await h.page.locator('.sect[data-sect="S1"]').boundingBox())!, c = (await h.page.locator('.card[data-id="n1"]').boundingBox())!;
  await shot(h, "sect-menu-02-moved");
  check("move-to-section-menu", p.section === "S1" && p.y >= 60 && p.y <= 820 && c.x >= f.x && c.x + c.width <= f.x + f.width && c.y >= f.y && c.y + c.height <= f.y + f.height + 1, { p, f, c });
  await close(h);
});

/** A drag that comes to rest is looked at again this long after its last move, as a slow one, so it snaps (interact.ts snapPace) */
const SNAP_SETTLE = 110;
/** Dragging a Section by its label aligns it with other Sections like a card drag: slowed down near another Section's edge it
 *  snaps onto it and a guide line shows; holding Ctrl turns snapping off. The cards inside move along; one undo puts it back */
test("sectionDragSnapsToSection", async () => {
  const b = emptyBoard("b1", "section snapping");
  put(b, { id: "a", kind: "note", look: "note", md: "Prefill" } as NoteCard, 120, 140, 220);
  put(b, { id: "c", kind: "note", look: "note", md: "Decode" } as NoteCard, 660, 500, 200);
  b.sections.push({ id: "S1", title: "Scheduling", x: 60, y: 60, w: 400, h: 300 });
  b.sections.push({ id: "S2", title: "KV cache", x: 600, y: 420, w: 320, h: 220 });
  b.place.a.section = "S1"; b.place.c.section = "S2";
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, settings: { theme: "warm-ink" } as any });
  await idle(h);
  const box = async (id: string) => (await h.page.locator(`.sect[data-sect="${id}"]`).boundingBox())!;
  const s1 = await box("S1"), s2 = await box("S2");
  const label = (await h.page.locator('.slabel[data-sect="S2"] .sname').boundingBox())!;
  const grab = { x: label.x + 10, y: label.y + label.height / 2 };
  // S2's left edge to 4px right of S1's left edge, its top 40px lower (no horizontal edge or centre line within reach)
  const dx = s1.x + 4 - s2.x, dy = 40;
  const guides = () => h.page.evaluate(() => [...document.querySelectorAll(".guides .guide")].map((g) => { const r = g.getBoundingClientRect(); return { v: g.classList.contains("v"), x: r.x, y: r.y, h: r.height }; }));
  const card0 = { ...h.board().place.c };
  await h.page.mouse.move(grab.x, grab.y); await h.page.mouse.down();
  await h.page.mouse.move(grab.x + dx / 2, grab.y + dy / 2, { steps: 8 });
  await h.page.mouse.move(grab.x + dx, grab.y + dy, { steps: 12 });
  await hold(h, SNAP_SETTLE + 100, "the pointer rests past the drag's settle delay: it snaps now if it is going to"); await idle(h);
  const during = await guides(), s2d = await box("S2");
  await shot(h, "sect-snap-01-guide");
  await h.page.mouse.up();
  await until(h, "the Section's move is saved", () => h.board().sections.find((q) => q.id === "S2")!.x !== 600); await idle(h);
  const sec2 = h.board().sections.find((q) => q.id === "S2")!, card1 = h.board().place.c;
  const left = (await box("S2")).x, gone = (await guides()).length;
  await shot(h, "sect-snap-02-dropped");
  const v = during.find((g) => g.v);
  check("section-drag-guide", !!v && Math.abs(v.x - s1.x) < 1.5 && v.y <= s1.y + 1 && v.y + v.h >= s2d.y + s2d.height - 1, { during, s1, s2d });
  check("section-drag-snaps", Math.abs(s2d.x - s1.x) < 0.5 && Math.abs(left - s1.x) < 0.5 && sec2.x === 60 && sec2.y === 460 && gone === 0, { s2d, left, sec2, gone });
  check("section-drag-moves-cards", card1.x === card0.x + (sec2.x - 600) && card1.y === card0.y + 40, { card0, card1 });
  await h.page.keyboard.press("Control+z");
  await until(h, "the undo is saved", () => h.board().sections.find((q) => q.id === "S2")!.x !== sec2.x); await idle(h);
  const back = h.board().sections.find((q) => q.id === "S2")!;
  check("section-drag-undo", back.x === 600 && back.y === 420 && h.board().place.c.x === card0.x, { back, c: h.board().place.c });
  // Ctrl held: no snapping, no guide
  const label2 = (await h.page.locator('.slabel[data-sect="S2"] .sname').boundingBox())!;
  const g2 = { x: label2.x + 10, y: label2.y + label2.height / 2 };
  await h.page.mouse.move(g2.x, g2.y); await h.page.mouse.down(); await h.page.keyboard.down("Control");
  await h.page.mouse.move(g2.x + dx, g2.y + dy, { steps: 12 });
  await hold(h, SNAP_SETTLE + 100, "the pointer rests past the drag's settle delay: with Ctrl it still must not snap"); await idle(h);
  const free = await guides();
  await h.page.mouse.up(); await h.page.keyboard.up("Control");
  await until(h, "the Section's move is saved", () => h.board().sections.find((q) => q.id === "S2")!.x !== 600); await idle(h);
  const sec3 = h.board().sections.find((q) => q.id === "S2")!;
  check("section-drag-ctrl-no-snap", free.length === 0 && sec3.x === 64, { free, sec3 });
  await close(h);
});

/** Membership is by overlap: a card belongs to a Section covering more than a third of its area; several → the one covering most.
 *  A wide card a bit under half inside joins (the Section lights up during the drag); a card about a quarter inside stays out;
 *  a card over two Sections joins the one it overlaps more */
test("sectionMembershipByOverlap", async () => {
  const b = emptyBoard("b1", "membership");
  put(b, { id: "c1", kind: "note", look: "note", md: "A quarter inside" } as NoteCard, 100, 620, 200);
  put(b, { id: "m1", kind: "note", look: "note", md: "Over two Sections" } as NoteCard, 100, 760, 400);
  put(b, { id: "w1", kind: "note", look: "note", md: "# A wide card\n\nA bit under half of it inside." } as NoteCard, 560, 560, 560);
  b.sections.push({ id: "S", title: "Scheduling", x: 600, y: 100, w: 400, h: 300 });
  b.sections.push({ id: "T", title: "Memory", x: 1100, y: 100, w: 400, h: 300 });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1600 });
  await idle(h);
  const size = (id: string) => h.page.evaluate((i) => { const r = document.querySelector(`.card[data-id="${i}"]`)!.getBoundingClientRect(); return { w: r.width, h: r.height }; }, id);
  const share = (p: { x: number; y: number }, r: { w: number; h: number }, f: { x: number; y: number; w: number; h: number }) =>
    (Math.max(0, Math.min(p.x + r.w, f.x + f.w) - Math.max(p.x, f.x)) * Math.max(0, Math.min(p.y + r.h, f.y + f.h) - Math.max(p.y, f.y))) / (r.w * r.h);
  const S = b.sections[0], T = b.sections[1];
  const move = async (id: string, tx: number, ty: number, name?: string) => {
    const p0 = h.board().place[id];
    const dx = tx - p0.x, dy = ty - p0.y;
    const hd = (await h.page.locator(`.card[data-id="${id}"] .chead`).boundingBox())!;
    const x = hd.x + 30, y = hd.y + hd.height / 2;
    await h.page.mouse.move(x, y); await h.page.mouse.down();
    await h.page.mouse.move(x + dx / 2, y + dy / 2, { steps: 6 }); await h.page.mouse.move(x + dx, y + dy, { steps: 8 }); await idle(h);
    const lit = await h.page.evaluate(() => [...document.querySelectorAll(".sect.drop")].map((e) => (e as HTMLElement).dataset.sect));
    if (name) await shot(h, name);
    await h.page.mouse.up(); await idle(h); // the drop is sent at once
    const p = h.board().place[id], r = await size(id);
    return { p, lit, s: share(p, r, S), t: share(p, r, T) };
  };
  // about a quarter inside S (and a quarter inside T): stays out
  const q = await move("c1", 950, 150, "27-third-01-quarter-inside");
  check("overlap-quarter-stays-out", q.s < 1 / 3 && q.t < 1 / 3 && q.s > 0.15 && !q.p.section && !q.lit.length, q);
  await h.page.keyboard.press("Control+z"); await idle(h);
  // over two Sections, more than a third in each: joins the one it overlaps more
  const two = await move("m1", 840, 150, "27-third-02-over-two-sections");
  check("overlap-two-sections-more-wins", two.s > 1 / 3 && two.t > 1 / 3 && two.p.section === (two.s > two.t ? "S" : "T") && two.lit.length === 1 && two.lit[0] === two.p.section, two);
  await h.page.keyboard.press("Control+z"); await idle(h);
  // wide card a bit under half inside: joins, and the Section lights up during the drag
  const w = await move("w1", 740, 250, "27-third-03-wide-card-over-section");
  await shot(h, "27-third-04-wide-card-joined");
  check("overlap-under-half-joins", w.p.section === "S" && w.s > 0.4 && w.s < 0.5 && w.lit.length === 1 && w.lit[0] === "S", w);
  await close(h);
});

/** A Note whose Markdown starts with a heading shows the heading as its title; a title set by the user wins; no heading = "Note" */
test("noteTitleFromHeading", async () => {
  const b = emptyBoard("b1", "titles");
  put(b, { id: "n1", kind: "note", look: "note", md: "## KV cache **budget**\n\nPrefill first." } as NoteCard, 80, 80, 300);
  put(b, { id: "n2", kind: "note", look: "note", md: "Just a paragraph, no heading." } as NoteCard, 440, 80, 300);
  put(b, { id: "n3", kind: "note", look: "note", md: "# From heading", title: "Chosen by me" } as NoteCard, 800, 80, 300);
  const h = await open({ board: b, light, w: 1200, h: 600 });
  await idle(h);
  const title = (id: string) => h.page.locator(`.card[data-id="${id}"] .chead .ctitle`).textContent();
  const t0 = { n1: await title("n1"), n2: await title("n2"), n3: await title("n3") };
  await shot(h, "note-title-01");
  check("note-title-from-heading", t0.n1 === "KV cache budget" && t0.n2 === "Note" && t0.n3 === "Chosen by me", t0);
  // editing the heading changes the title
  await h.page.locator('.card[data-id="n2"] .nbody').dblclick(); await h.page.locator(".md-pm:focus").waitFor();
  await h.page.keyboard.press("Control+a"); await h.page.keyboard.type("# Decode loop\n\nOne token per step.");
  await h.page.keyboard.press("Escape"); await idle(h);
  const t1 = await title("n2");
  await shot(h, "note-title-02-edited");
  check("note-title-follows-edit", t1 === "Decode loop", { t1, md: (h.board().cards.find((c) => c.id === "n2") as NoteCard).md });
  await close(h);
});

/** ⌘X cuts the selected cards (one undo step brings them back); ⌘V on the same board puts them back as they were; ⌘X while editing a Note cuts text only */
test("cutCardsPasteUndo", async () => {
  const b = twoSections();
  const code = b.cards[0].id;
  const h = await open({ board: b, light });
  await h.page.keyboard.press("Shift+!"); await idle(h);
  const p0 = { ...h.board().place.n1 };
  await h.page.locator('.card[data-id="n1"] .chead').click(); await h.page.locator('.card.sel[data-id="n1"]').waitFor();
  await h.page.keyboard.press("Control+x"); await idle(h);
  const cut = { n1: !!h.board().cards.find((c) => c.id === "n1"), copied: h.sent.some((m) => m.type === "copyCards") };
  await h.page.keyboard.press("Control+z");
  await until(h, "undo brings the cut card back", () => h.board().cards.some((c) => c.id === "n1")); await idle(h);
  const undone = { n1: !!h.board().cards.find((c) => c.id === "n1"), place: h.board().place.n1 };
  await h.page.keyboard.press("Control+Shift+z"); await idle(h);
  const redone = !h.board().cards.some((c) => c.id === "n1");
  check("cut-removes-card", !cut.n1 && cut.copied, cut);
  check("cut-single-undo", undone.n1 && undone.place?.x === p0.x && undone.place?.y === p0.y && undone.place?.section === "S2", { undone, p0 });
  check("cut-redo", redone);
  // paste: the clipboard has the card's text; the same card comes back (same id, its heading intact) at the pointer
  await h.page.mouse.move(1000, 700);
  await h.page.evaluate((t) => { const dt = new DataTransfer(); dt.setData("text/plain", t); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); }, (b.cards[1] as NoteCard).md);
  await idle(h);
  const back = h.board().cards.find((c) => c.id === "n1") as NoteCard | undefined;
  await shot(h, "cut-01-pasted");
  check("cut-paste-restores", !!back && back.md === (b.cards[1] as NoteCard).md && h.board().cards.length === 2, { ids: h.board().cards.map((c) => c.id) });
  // ⌘X inside the Note editor: text is cut, the card stays
  await h.page.locator('.card[data-id="n1"] .nbody').dblclick(); await h.page.locator(".md-pm:focus").waitFor();
  await h.page.keyboard.press("Control+a"); await h.page.keyboard.press("Control+x"); await idle(h);
  await h.page.keyboard.press("Escape"); await idle(h);
  const ids = h.board().cards.map((c) => c.id);
  check("cut-in-editor-keeps-card", ids.includes(code) && h.sent.filter((m) => m.type === "copyCards").length === 1, { ids, copies: h.sent.filter((m) => m.type === "copyCards").length });
  await close(h);
});

/** A click on a Section's empty area selects it (the innermost one); a drag there is still a marquee, and a click outside clears */
test("sectionClickEmptySelects", async () => {
  const b = twoSections();
  b.sections.push({ id: "S3", title: "Inner", x: 760, y: 300, w: 320, h: 160, parent: "S2" });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1400 });
  await idle(h);
  const pg = h.page;
  const selected = () => pg.evaluate(() => [...document.querySelectorAll(".sect.sel")].map((e) => (e as HTMLElement).dataset.sect));
  const box = async (id: string) => (await pg.locator(`.sect[data-sect="${id}"]`).boundingBox())!;
  const s1 = await box("S1"), s3 = await box("S3");
  // S1 的下半截是空的（代码卡在上面）
  await pg.mouse.click(s1.x + 40, s1.y + s1.height - 30); await idle(h);
  const one = await selected();
  await pg.mouse.click(s3.x + s3.width - 30, s3.y + s3.height - 20); await idle(h);
  const inner = await selected();
  await pg.mouse.click(s1.x + s1.width + 40, s1.y + s1.height - 30); await idle(h);
  const none = await selected();
  // 在 S2 里拖一个框把 Note 框住：选中的是卡，不是 Section
  const n1 = (await pg.locator('.card[data-id="n1"]').boundingBox())!;
  await pg.mouse.move(n1.x - 20, n1.y - 20); await pg.mouse.down();
  await pg.mouse.move(n1.x + n1.width / 2, n1.y + n1.height / 2, { steps: 5 }); await pg.mouse.up(); await idle(h);
  const dragged = { sections: await selected(), cards: await pg.evaluate(() => [...document.querySelectorAll(".card.sel")].map((e) => (e as HTMLElement).dataset.id)) };
  check("sectionClickEmptySelects", one.join() === "S1" && inner.join() === "S3" && none.length === 0 && dragged.sections.length === 0 && dragged.cards.join() === "n1", { one, inner, none, dragged });
  await close(h);
});

/** A selected Section moves when its empty area is dragged, with its cards; an unselected one is not moved by that drag */
test("sectionDragEmptyMovesSelected", async () => {
  const b = twoSections();
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1400 });
  await idle(h);
  const pg = h.page;
  const s1 = (await pg.locator('.sect[data-sect="S1"]').boundingBox())!;
  const code = b.cards[0].id;
  const at = () => { const q = h.board(); const s = q.sections.find((x) => x.id === "S1")!; return { sx: s.x, sy: s.y, cx: q.place[code].x, cy: q.place[code].y }; };
  const drag = async (x: number, y: number) => { await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x + 60, y + 40, { steps: 6 }); await pg.mouse.up(); await idle(h); };
  const p0 = at();
  // 没选中：拖空白处是框选，Section 不动
  await drag(s1.x + 40, s1.y + s1.height - 120);
  const p1 = at();
  await pg.mouse.click(s1.x + s1.width + 40, s1.y + 20); await idle(h);
  await pg.mouse.click(s1.x + 40, s1.y + s1.height - 30); await idle(h);
  // 离点选的地方远一点按下（同一处紧接着再按会算双击）
  await drag(s1.x + 200, s1.y + s1.height - 60);
  await until(h, "the Section move is saved", () => at().sx !== p0.sx);
  const p2 = at();
  check("sectionDragEmptyMovesSelected", p1.sx === p0.sx && p1.sy === p0.sy && p2.sx - p0.sx === 60 && p2.sy - p0.sy === 40 && p2.cx - p0.cx === 60 && p2.cy - p0.cy === 40, { p0, p1, p2 });
  await close(h);
});
