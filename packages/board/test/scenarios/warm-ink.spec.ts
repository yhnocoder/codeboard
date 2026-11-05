// Warm Ink (暖墨, the default look): what it draws and moves on its own (themes.css's Warm Ink section, Links.tsx tapered lines,
// Menu.tsx / Chrome.tsx gliding pills, CodeBody.tsx's header line, actions/common.ts popAlong).
//  warmInkLook    — cards with a crisp edge drawn above the header (inner highlight, warm bottom edge, squircle) over a soft shadow;
//                   tapered filled arrows with a small dart head; the header line hidden until the code is scrolled; the selection
//                   ring with its halo (link dots only on hover); the frosted toolbar, dock and menu with a gliding pill; light and
//                   dark, with screenshots (WARM_SHOTS: a copy elsewhere). Classic and Ink Wash keep their own look
//  warmInkMotions — the select ring, the menu's close, the jump-to-line sweep and the toolbar pill run (transform / opacity /
//                   clip-path only) and finish; a new card from a call: its arrow draws from the source, then the card springs out
//                   of the arrowhead with the arrow's end on it every frame
import * as fs from "node:fs";
import * as path from "node:path";
import { shot, symCard, findSym, put, OUT } from "../harness";
import { emptyBoard, type Board } from "@codeboard/core";
import { test, open, check, idle, until, type Host } from "../fixtures";

const card = (q: string) => {
  const s = findSym(q);
  return symCard(s.f, s.s);
};

/** The same board as ink-wash.spec.ts */
function board(): Board {
  const b = emptyBoard("b1", "nano-vllm · 推理一步");
  const step = card("LLMEngine.step"),
    sch = card("Scheduler.schedule"),
    run = card("ModelRunner.run");
  put(b, step, 60, 110, 560);
  put(b, sch, 760, 60, 480);
  put(b, run, 760, 470, 480);
  b.place[sch.id].h = 300;
  b.place[run.id].h = 160;
  b.cards.push({
    id: "n1",
    kind: "note",
    look: "note",
    md: "## 一步推理\n\n先 schedule 挑出这一批，==prefill 和 decode 不混在一批里==；再交给 ModelRunner 跑模型、采样。",
  } as never);
  b.place.n1 = { x: 80, y: 440, w: 340 };
  const s0 = step.segments[0];
  const at = (re: RegExp) => s0.start + s0.text.findIndex((t) => re.test(t));
  b.links.push({
    id: "L1",
    kind: "call",
    from: { card: step.id, seg: s0.id, line: at(/scheduler\.schedule\(/) },
    to: { card: sch.id },
    call: { name: "schedule", col: 37 },
  } as never);
  b.links.push({
    id: "L2",
    kind: "call",
    from: { card: step.id, seg: s0.id, line: at(/model_runner\.call\(/) },
    to: { card: run.id },
    call: { name: "call", col: 38 },
  } as never);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

/** A copy of the screenshots somewhere else too (WARM_SHOTS), e.g. for review */
function keep(name: string) {
  const dir = process.env.WARM_SHOTS;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(dir, `${name}.png`));
  } catch {
    /* no such folder here: harness output only */
  }
}
async function snap(h: Host, name: string, at: "idle" | "now" = "idle") {
  await shot(h, name, at);
  keep(name);
}

const finish = (h: Host) => h.page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
/** What the running animations and transitions of these elements animate (their keyframes' properties): the ring layer
 *  (.cface::before) or the sweep (wi-sweep) */
const animated = (h: Host, of: "ring" | "sweep") =>
  h.page.evaluate(
    (of) =>
      document
        .getAnimations()
        .filter((a) => {
          const e = a.effect as KeyframeEffect;
          return of === "ring"
            ? e.pseudoElement === "::before" && !!e.target?.classList.contains("cface")
            : (a as CSSAnimation).animationName === "wi-sweep";
        })
        .flatMap((a) =>
          (a.effect as KeyframeEffect)
            .getKeyframes()
            .flatMap((k) => Object.keys(k))
            .filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)),
        ),
    of,
  );
const CHEAP = ["transform", "opacity", "scale", "translate", "clipPath", "clip-path"];
const cheap = (ps: string[]) => ps.every((p) => CHEAP.includes(p));

/** The look's computed styles that only Warm Ink has (so other looks can be checked for none of them) */
const probe = (h: Host) =>
  h.page.evaluate(() => {
    const cs = (e: Element, p?: string) => getComputedStyle(e, p);
    const corner = (e: Element, p?: string) => cs(e, p).getPropertyValue("corner-top-left-shape");
    const c = document.querySelector<HTMLElement>(".card.ccard")!,
      head = c.querySelector(".chead")!;
    const links = [...document.querySelectorAll<SVGGElement>("g.link")].map((g) => {
      const t = g.querySelector<SVGPathElement>("path.taper");
      return {
        taper: !!t && /^M.*A1\.25 1\.25 0 0 0 .*Z$/.test(t.getAttribute("d") ?? "") && cs(t).fill !== "none",
        edge: cs(g.querySelector("path.edge")!).stroke,
        head: [...g.querySelector(".ahead.end")!.classList].join(" "),
        headFill: cs(g.querySelector(".ahead.end")!).fill,
      };
    });
    const bar = document.querySelector(".bbar > .pill")!,
      dock = document.querySelector(".dock > .pill")!;
    return {
      ring: {
        z: cs(c, "::after").zIndex,
        shadow: cs(c, "::after").boxShadow,
        corner: corner(c, "::after"),
        cardCorner: corner(c),
        // the edge is drawn above the header's background: the header is not positioned above it
        headZ: cs(head).zIndex,
        soft: cs(c, "::before").boxShadow,
        selCorner: corner(c.querySelector(".cface")!, "::before"),
        selContent: cs(c.querySelector(".cface")!, "::before").content,
      },
      links,
      headLine: cs(head).borderBottomColor,
      // only code cards trade the header line for the scrolled one; a Note keeps its line
      noteLine: cs(document.querySelector(".card.note .chead")!).borderBottomColor,
      hdl: document.querySelectorAll(".card.ccard .hdl").length,
      bar: { frost: cs(bar).backdropFilter, bg: cs(bar).backgroundColor, sh: cs(bar).boxShadow },
      dock: { frost: cs(dock).backdropFilter },
      tpill: document.querySelectorAll(".bbar .tpill").length,
      menuExit: cs(document.documentElement).getPropertyValue("--menu-exit").trim(),
    };
  });

test("warmInkLook", async () => {
  const res: Record<string, unknown> = {};
  let ok = true;
  for (const lt of [true, false]) {
    const mode = lt ? "light" : "dark";
    const h = await open({ board: board(), light: lt, w: 1300, h: 820 });
    await idle(h);
    const r = await probe(h);
    await snap(h, `warm-ink-board-${mode}`);
    // scrolling the code shows the line under the header (Scheduler.schedule: its code is taller than the card)
    const sch = h.page.locator(".card.ccard").nth(1);
    const line = () => sch.evaluate((c) => getComputedStyle(c.querySelector(".hdl")!, "::after").opacity);
    const before = { on: await sch.locator(".hdl.on").count(), opacity: await line() };
    await sch.locator(".cbody").evaluate((e) => {
      e.scrollTop = 60;
    });
    await sch.locator(".hdl.on").waitFor({ state: "attached" });
    await finish(h);
    const scrolled = { opacity: await line() };
    await snap(h, `warm-ink-scrolled-${mode}`);
    await sch.locator(".cbody").evaluate((e) => {
      e.scrollTop = 0;
    });
    await until(h, "the header line goes when back at the top", async () => !(await sch.locator(".hdl.on").count()));
    await finish(h);
    const back = { opacity: await line() };
    // select a card: the ring and its halo; the link dots come only while the pointer is on the card
    await h.page.locator(".card.ccard .ctitle").first().click();
    await h.page.locator(".card.ccard.sel").waitFor();
    await h.page.mouse.move(700, 760);
    await idle(h);
    const sel = await h.page.evaluate(() => {
      const c = document.querySelector(".card.sel")!,
        b = getComputedStyle(c.querySelector(".cface")!, "::before");
      return {
        opacity: b.opacity,
        scale: b.scale,
        shadow: b.boxShadow,
        ring: getComputedStyle(c, "::after").boxShadow,
        dots: [...c.querySelectorAll(":scope > .cface > .eport")].map((e) => getComputedStyle(e).opacity),
      };
    });
    await snap(h, `warm-ink-selected-${mode}`);
    // the menu: frosted, 8px squircle corners; the hovered row is a pill under it, the row itself not filled
    await h.page.locator(".card.ccard .ctitle").nth(2).click({ button: "right" });
    await h.page.locator(".ctx.open").waitFor();
    const row = h.page.locator(".ctx.open > button:not([disabled])").nth(1);
    await row.hover();
    await h.page.locator(".ctx.open .mpill.on").waitFor();
    await finish(h);
    const menu = await h.page.evaluate(() => {
      const m = document.querySelector(".ctx.open")!,
        cs = getComputedStyle(m),
        b = m.querySelectorAll<HTMLElement>(":scope > button:not([disabled])")[1],
        p = m.querySelector<HTMLElement>(".mpill")!;
      return {
        radius: cs.borderTopLeftRadius,
        corner: cs.getPropertyValue("corner-top-left-shape"),
        frost: cs.backdropFilter,
        rowBg: getComputedStyle(b).backgroundColor,
        pillAt: new DOMMatrix(getComputedStyle(p).transform).m42 === b.offsetTop && p.offsetHeight === b.offsetHeight,
      };
    });
    await snap(h, `warm-ink-menu-${mode}`);
    await h.page.keyboard.press("Escape");
    await until(h, "the menu closed", async () => !(await h.page.locator(".ctx:not(.closing)").count()));
    await h.page.context().close();
    const one =
      r.ring.z === "3" &&
      (r.ring.shadow.match(/inset/g) ?? []).length === 2 &&
      r.ring.corner === r.ring.cardCorner &&
      r.ring.corner !== "round" &&
      r.ring.selCorner === r.ring.cardCorner &&
      r.ring.headZ === "auto" &&
      r.ring.soft.split("rgba").length - 1 === 4 &&
      r.links.length === 2 &&
      r.links.every((l) => l.taper && l.edge === "none" && /\bdart\b/.test(l.head) && l.headFill !== "none") &&
      r.headLine === "rgba(0, 0, 0, 0)" &&
      r.noteLine !== "rgba(0, 0, 0, 0)" &&
      r.hdl === 3 &&
      before.on === 0 &&
      before.opacity === "0" &&
      scrolled.opacity === "1" &&
      back.opacity === "0" &&
      r.bar.frost.includes("blur(22px)") &&
      r.bar.frost.includes("saturate(1.9)") &&
      r.dock.frost.includes("blur(22px)") &&
      /, 0\.6\d?\)$/.test(r.bar.bg) &&
      r.bar.sh.includes("inset") &&
      r.tpill === 1 &&
      r.menuExit === "90" &&
      sel.opacity === "1" &&
      (sel.scale === "1" || sel.scale === "none") &&
      sel.shadow.includes("1.5px") &&
      sel.shadow.includes("3px") &&
      !sel.ring.includes(" 0px 0px 0px 1.5px") &&
      sel.dots.every((o) => o === "0") &&
      menu.radius === "8px" &&
      menu.corner === r.ring.cardCorner &&
      menu.frost.includes("blur(24px)") &&
      menu.rowBg === "rgba(0, 0, 0, 0)" &&
      menu.pillAt;
    ok &&= one;
    res[mode] = { ...r, before, scrolled, back, sel, menu, ok: one };
  }
  // other looks: none of it
  for (const theme of ["classic", "ink-wash"]) {
    const h = await open({ board: board(), light: true, w: 1300, h: 820, settings: { theme } as never });
    await idle(h);
    const r = await probe(h);
    await h.page.locator(".card.ccard .ctitle").nth(2).click({ button: "right" });
    await h.page.locator(".ctx.open").waitFor();
    const pills = await h.page.locator(".mpill").count();
    await h.page.context().close();
    const one =
      r.ring.z === "-1" &&
      r.ring.selContent !== '""' &&
      r.links.every((l) => !l.taper && !/\bdart\b/.test(l.head)) &&
      r.hdl === 0 &&
      r.tpill === 0 &&
      pills === 0 &&
      (theme === "classic" ? r.headLine !== "rgba(0, 0, 0, 0)" && r.menuExit === "" : r.menuExit === "130");
    ok &&= one;
    res[theme] = { ...r, pills, ok: one };
  }
  check("warmInkLook", ok, res);
});

test("warmInkMotions", async () => {
  const res: Record<string, unknown> = {};
  const h = await open({ board: board(), light: true, w: 1300, h: 820 });
  await idle(h);
  // selecting: only the ring layer fades in and grows from 0.985; the card itself doesn't move
  const cardBox = () =>
    h.page
      .locator(".card.ccard")
      .first()
      .evaluate((c) => c.getAttribute("style"));
  const style0 = await cardBox();
  await h.page.locator(".card.ccard .ctitle").first().click();
  await h.page.locator(".card.ccard.sel").waitFor();
  res.selProps = await animated(h, "ring");
  res.selStill = (await cardBox()) === style0;
  await finish(h);
  // closing the menu: the copy left behind fades out to 0.98
  await h.page.evaluate(() => {
    const w = window as unknown as { __close?: string[] };
    const mo = new MutationObserver((ms) => {
      const c = ms.flatMap((m) => [...m.addedNodes]).find((n) => (n as Element).classList?.contains("closing"));
      if (!c) return;
      mo.disconnect();
      requestAnimationFrame(() => {
        w.__close = (c as Element).getAnimations().map((a) => (a as CSSTransition).transitionProperty);
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });
  await h.page.locator(".card.ccard .ctitle").first().click({ button: "right" });
  await h.page.locator(".ctx.open").waitFor();
  await finish(h);
  await h.page.keyboard.press("Escape");
  await until(h, "the close ran", () => h.page.evaluate(() => !!(window as unknown as { __close?: string[] }).__close));
  res.menuClose = await h.page.evaluate(() => (window as unknown as { __close: string[] }).__close);
  await until(h, "the closing copy is gone", async () => !(await h.page.locator(".ctx").count()));
  // deselecting: the ring fades out
  await h.page.mouse.click(700, 760);
  await until(h, "deselected", async () => !(await h.page.locator(".card.sel").count()));
  res.unselProps = await animated(h, "ring");
  await finish(h);
  // jumping to a line: a warm sweep under the line's text, from its first to its last character
  await h.page
    .locator(".card.ccard")
    .first()
    .locator(".src .call", { hasText: /^schedule$/ })
    .click();
  await until(h, "the line flashes", () => h.page.locator(".rowbg.flash").count());
  const sweep = await h.page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".rowbg.flash")!,
      a = getComputedStyle(row, "::after");
    const s = document.createElement("span");
    s.textContent = "0".repeat(100);
    s.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    row.appendChild(s);
    const ch = s.getBoundingClientRect().width / 100;
    s.remove();
    const as = document.getAnimations().filter((x) => (x as CSSAnimation).animationName === "wi-sweep");
    for (const x of as) {
      x.pause();
      x.currentTime = 120;
    }
    return { width: parseFloat(a.width), ch, n: as.length, bg: a.backgroundColor };
  });
  res.sweep = sweep;
  res.sweepProps = await animated(h, "sweep");
  await snap(h, "warm-ink-motion-sweep", "now");
  await finish(h);
  // the toolbar's pill under the tool in use: Section, then Arrow (it glides over), then none
  await h.page.locator(".card.ccard .ctitle").first().click();
  await h.page.locator(".card.ccard.sel").waitFor();
  await h.page.locator('.bbar .tbtn[aria-label="Section"]').click();
  await h.page.locator(".bbar .tpill.on").waitFor();
  await finish(h);
  const pillAt = () =>
    h.page.evaluate(() => {
      const p = document.querySelector<HTMLElement>(".bbar .tpill")!,
        b = document.querySelector<HTMLElement>(".bbar .tbtn[data-on]");
      return { clip: getComputedStyle(p).clipPath, on: b?.getAttribute("aria-label") ?? null, left: b?.offsetLeft };
    });
  res.pillSection = await pillAt();
  await h.page.locator('.bbar .tbtn[aria-label="Arrow"]').click();
  await until(h, "the pill moves to Arrow", () => h.page.locator('.bbar .tbtn[data-on][aria-label="Arrow"]').count());
  res.pillGlide = await h.page.evaluate(() =>
    document
      .querySelector(".bbar .tpill")!
      .getAnimations()
      .map((a) => (a as CSSTransition).transitionProperty),
  );
  await finish(h);
  res.pillArrow = await pillAt();
  await h.page.keyboard.press("Escape");
  await until(h, "the pill goes", async () => !(await h.page.locator(".bbar .tpill.on").count()));
  await finish(h);
  // a new card from a call: the arrow draws from its source first, then the card springs out of its head, the arrow's end on it
  await idle(h);
  // the links there are (from the board: one off screen has no node now)
  const before = h.board().links.map((l) => l.id);
  await h.page.evaluate((ids) => {
    const w = window as unknown as { __spawn?: unknown[]; __stop?: boolean };
    w.__spawn = [];
    const old = new Set(ids);
    const tick = () => {
      if (w.__stop) return;
      requestAnimationFrame(tick);
      for (const g of document.querySelectorAll<SVGGElement>("g.link")) {
        const c = !old.has(g.dataset.lk) && document.querySelector<HTMLElement>(`.card[data-id="${g.dataset.to}"]`);
        if (!c) continue;
        const t = g.querySelector<SVGPathElement>("path.taper"),
          end = (g.querySelector("path.edge")?.getAttribute("d") ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [],
          tx = Number(/translate\((-?[\d.]+)px/.exec(c.style.transform)?.[1] ?? 0);
        w.__spawn!.push({
          id: g.dataset.lk,
          // how much of the line is drawn (its outline's length)
          len: t ? Math.round(t.getTotalLength()) : -1,
          // where the route ends against where the card's left edge is drawn this frame
          gap: end.length ? Math.round((end[end.length - 2] - (parseFloat(c.style.left) + tx)) * 10) / 10 : null,
          tip: g.querySelectorAll("path.ahead.dart").length,
          op: c.style.opacity,
          tf: c.style.transform,
        });
      }
    };
    requestAnimationFrame(tick);
  }, before);
  const n0 = h.board().cards.length;
  await h.page
    .locator(".card.ccard")
    .first()
    .locator(".src .call", { hasText: /^postprocess$/ })
    .click();
  await until(h, "the call expands", () => h.board().cards.length > n0);
  await idle(h);
  // the call's own new link: from the card clicked, to the card it made
  const made = h
    .board()
    .cards.slice(n0)
    .map((c) => c.id);
  const lk = h.board().links.find((l) => !before.includes(l.id) && made.includes(l.to.card))?.id;
  const spawn = await h.page.evaluate((lk) => {
    const w = window as unknown as {
      __spawn: { id: string; len: number; gap: number | null; tip: number; op: string; tf: string }[];
      __stop?: boolean;
    };
    w.__stop = true;
    return w.__spawn.filter((f) => f.id === lk);
  }, lk);
  res.spawn = spawn;
  await h.page.context().close();
  const names = (k: string) => (res[k] as string[]).join(" ");
  // the arrow grows while the card is hidden, then the card comes out (opacity rising, moving) and settles with no inline style
  const drawing = spawn.filter((f) => f.op === "0");
  const out = spawn.filter((f) => f.op !== "0" && f.tf);
  const grows =
    drawing.length >= 3 &&
    drawing.every((f, i) => i === 0 || f.len >= drawing[i - 1].len) &&
    drawing.at(-1)!.len > drawing[0].len * 2;
  check(
    "warmInkMotions",
    cheap(res.selProps as string[]) &&
      (res.selProps as string[]).includes("opacity") &&
      (res.selProps as string[]).includes("scale") &&
      res.selStill === true &&
      cheap(res.unselProps as string[]) &&
      (res.unselProps as string[]).includes("opacity") &&
      names("menuClose").includes("opacity") &&
      names("menuClose").includes("scale") &&
      Math.abs(sweep.width - ("seqs, is_prefill = self.scheduler.schedule()".length + 1) * sweep.ch) < 1 &&
      sweep.n === 1 &&
      cheap(res.sweepProps as string[]) &&
      (res.pillSection as { on: string }).on === "Section" &&
      (res.pillSection as { clip: string }).clip.startsWith("inset(") &&
      (res.pillArrow as { on: string }).on === "Arrow" &&
      (res.pillArrow as { left: number }).left > (res.pillSection as { left: number }).left &&
      (res.pillGlide as string[]).join(" ") === "clip-path" &&
      grows &&
      drawing.some((f) => f.tip === 1) &&
      out.length >= 2 &&
      out.every((f) => f.gap !== null && Math.abs(f.gap - out[0].gap!) <= 1.5) &&
      spawn.at(-1)!.tf === "" &&
      spawn.at(-1)!.tip === 1,
    res,
  );
});
