//  headnarrow — the same card at several widths, with "← N", the version chip and "+ uncommitted". As the card narrows,
//               the version chip and "+ uncommitted" collapse to a small mark first, then "← N" goes,
//               then the path truncates, and the title truncates last. Copy Code is hover-only and takes no width while hidden. Checked in light and dark on several themes,
//               plus the generic UI audit (tools/review/audit.cjs) for L2.
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, emptyBoard, type CodeCard } from "@codeboard/core";
import { shot, put, symCard, findSym, OUT, type Host } from "../harness";
import { test, open, check, idle, until } from "../fixtures";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { audit } = require("../../../../tools/review/audit.cjs") as { audit: (t: unknown, step: string) => Promise<{ issues: { rule: string; what: string }[] }> };

const WIDTHS = [230, 260, 290, 320, 360, 420, 520, 640];
const THEMES = process.env.HEAD_THEMES?.split(",") ?? ["warm-ink", "classic", "drafting", "graphite", "colorful", "soft-light"];
const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };

function board() {
  const b = emptyBoard("b1", "header");
  const src = nv("LLMEngine.step");
  put(b, src, 760, 40, 420);
  WIDTHS.forEach((w, i) => {
    const c: CodeCard = nv("Scheduler.preempt");
    c.segments[0].version = { kind: "git", commit: "bb823b3c0ffee", uncommitted: true } as never;
    put(b, c, 40, 30 + i * 128, w);
    b.links.push({ id: `L${i}`, from: { card: src.id }, to: { card: c.id } } as never);
  });
  b.cam = { x: 0, y: 0, z: 1 };
  return { b, src };
}

/** Per narrow card: is each header item truncated (title / path) or folded (chips), and does anything stick out of the header.
 *  sweep: also resize the first card in 5px steps and check each width (catches leaks right at a tier boundary) */
const measure = (h: Host, ids: string[], sweep: number[] = []) => h.page.evaluate(({ ids, sweep }) => {
  const row = (hd: HTMLElement) => {
    const q = (s: string) => hd.querySelector(s) as HTMLElement | null;
    // Truncated even by a fraction of a pixel: the text is wider than the content box
    const cut = (el: HTMLElement | null) => {
      if (!el || !el.getClientRects().length) return false; // not shown in this theme (Colorful hides the title)
      const r = document.createRange(); r.selectNodeContents(el);
      const cs = getComputedStyle(el);
      return r.getBoundingClientRect().width > el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 0.01;
    };
    // A chip is folded when its label wrapped onto the clipped second line
    const gone = (el: HTMLElement | null) => {
      if (!el) return true;
      const w = el.querySelector(".rw") as HTMLElement | null, l = w?.lastElementChild as HTMLElement | null;
      return w && l ? l.getBoundingClientRect().top >= w.getBoundingClientRect().bottom - 0.5 || el.getBoundingClientRect().width < 1 : cut(el);
    };
    const hr = hd.getBoundingClientRect();
    const st = { w: Math.round(hr.width), title: cut(q(".ctitle")), path: gone(q(".cpath")) || cut(q(".cpath .rl")), rev: gone(q(".rev:not(.unc)")), unc: gone(q(".rev.unc")), back: gone(q(".linkedin")), copy: (q(".hov")?.getBoundingClientRect().width ?? 0) < 1 };
    // Lower priority first: rev/unc → ← N → path → title. A higher one is never cut while a lower one still shows in full
    const order = [st.rev && st.unc, st.back, st.path, st.title];
    const ok = order.every((v, i) => !v || order.slice(0, i).every(Boolean));
    // Folded chips keep a visible mark, and nothing runs past the header's right edge
    const marks = [q(".rev:not(.unc)"), q(".rev.unc")].every((el) => !!el && (!el.getClientRects().length || el.getBoundingClientRect().width >= 8)); // Poster shows the version elsewhere
    const inside = [...hd.children].every((el) => getComputedStyle(el).position === "absolute" || el.getBoundingClientRect().right <= hr.right + 0.5);
    const revHidden = !q(".rev:not(.unc)")?.getClientRects().length;
    return { ...st, revHidden, ok: ok && marks && inside };
  };
  const hd = (id: string) => document.querySelector(`.card[data-id="${id}"] .chead`) as HTMLElement;
  const rows = ids.map((id) => row(hd(id)));
  const card = document.querySelector(`.card[data-id="${ids[0]}"]`) as HTMLElement, w0 = card.style.width;
  const bad = sweep.map((w) => { card.style.width = `${w}px`; return row(hd(ids[0])); }).filter((r) => !r.ok);
  card.style.width = w0;
  return { rows, bad };
}, { ids, sweep });
const SWEEP = Array.from({ length: 89 }, (_, i) => 220 + i * 5);

test("headnarrow", async () => {
  const { b } = board();
  const ids = b.cards.slice(1).map((c) => c.id);
  const h = await open({ board: b, light: true, w: 1200, h: 940, settings: { theme: "warm-ink" } as never });
  const d = process.env.SHOTS_DIR;
  let ok = true;
  for (const theme of THEMES) for (const light of [true, false]) {
    await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme } } as never });
    await h.page.evaluate((l) => { document.body.className = l ? "vscode-light" : "vscode-dark"; }, light);
    await idle(h); // the new theme and its transitions
    const { rows, bad } = await measure(h, ids, SWEEP);
    const l2 = (await audit(h.page, theme)).issues.filter((i) => i.rule.startsWith("L2"));
    // The narrowest cards may have to truncate the title once everything else is folded; the widest shows everything in full
    const wide = rows[rows.length - 1];
    const good = rows.every((r) => r.ok && r.copy) && !bad.length && (!wide.rev || wide.revHidden) && !wide.unc && !wide.back && !wide.path && !wide.title;
    if (!good) ok = false;
    console.log(good ? "  ok" : "  BAD", theme, light ? "light" : "dark", JSON.stringify(rows.map((r) => `${r.w}:${["rev", "unc", "back", "copy", "path", "title"].filter((k) => (r as never)[k]).join("+") || "full"}`)), `sweep bad=${JSON.stringify(bad.slice(0, 3))}`, `L2=${l2.length}`, l2.map((i) => i.what).join(" | "));
    const name = `head-${theme}-${light ? "light" : "dark"}`;
    await h.page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: 30, y: 20, width: 660, height: WIDTHS.length * 128 } });
    if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
  }
  await shot(h, "head-last");
  check("headnarrow", ok);
  await h.page.context().close();
});

/** A card's ⋯ menu button (code card, Note) is hidden until the card is hovered or selected, keeps its place so the header does not
 *  move when it appears, and stays while its menu is open even with the pointer over the menu (usage feedback #90) */
test("cardMenuDotsOnHover", async () => {
  const b = emptyBoard("b1", "menu dots");
  put(b, symCard(findSym("Scheduler.schedule").f, findSym("Scheduler.schedule").s), 60, 60, 480);
  b.cards.push({ id: "n1", kind: "note", look: "note", md: "现在考察第三章图 3.11 中的具体矩阵乘法 kernel。" } as any);
  b.place.n1 = { x: 620, y: 60, w: 400 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 1100, h: 700 });
  const pg = h.page;
  await idle(h);
  const dots = () => pg.evaluate(async () => Promise.all([...document.querySelectorAll<HTMLElement>(".chead .cmenu")].map(async (e) => {
    await Promise.all(e.getAnimations().map((a) => a.finished));
    return { card: e.closest<HTMLElement>(".card")!.dataset.id, opacity: +getComputedStyle(e).opacity, x: Math.round(e.getBoundingClientRect().x) };
  })));
  await pg.mouse.move(1080, 680);
  const rest = await dots();
  await pg.locator('.card[data-id="n1"] .nbody').hover();
  const hover = await dots();
  await shot(h, "card-menu-dots-hover");
  await pg.locator('.card[data-id="n1"] .cmenu').click();
  await pg.locator(".ctx.open").waitFor();
  await pg.locator(".ctx.open button").last().hover();
  const menu = await dots();
  await pg.keyboard.press("Escape");
  await pg.locator(".ctx").waitFor({ state: "detached" });
  await pg.mouse.click(800, 600); // the click on ⋯ selected the card, which keeps it shown
  await until(h, "card deselected", () => pg.evaluate(() => !document.querySelector(".card.sel")));
  const after = await dots();
  const op = (r: typeof rest, id: string) => r.find((d) => d.card === id)?.opacity;
  const code = rest.find((d) => d.card !== "n1")?.card ?? "";
  check("cardMenuDotsOnHover", rest.length === 2 && rest.every((d) => d.opacity === 0) && op(hover, "n1") === 1 && op(hover, code) === 0
    && op(menu, "n1") === 1 && after.every((d) => d.opacity === 0) && hover.every((d, i) => d.x === rest[i].x), { rest, hover, menu, after });
});
