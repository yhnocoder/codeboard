// Ink Wash (水墨): what the look draws with images and motions of its own (state/ink.ts, themes.css, Links.tsx brush lines).
//  inkWashLook             — brush arrows (filled outline + dry-brush hairlines, no stroked line), rice-paper cards (a nine-slice border image,
//                            card size unchanged), vermilion seals, the selection seal, call strokes, the ink toolbar,
//                            a toast clear of the toolbar; light and dark, with screenshots (INK_SHOTS: a copy elsewhere)
//  inkWashFlashBrush       — jumping to a line sweeps a brush under its text: from its first to its last character, half a
//                            character more at each end, so a longer line gets a longer stroke
//  inkWashCallStrokeStable — each call gets one of five strokes, picked by the called word: the same word, the same stroke
//  inkWashMotions          — the stamp, menu (opening and rolling back up), delete and toast motions run (transform / opacity / clip / mask only) and finish;
//                            mid-animation frames as screenshots
//  inkWashSelectSeal       — selecting a card stamps a small vermilion seal 选 on its top-right corner (it drops in) and lifts the
//                            paper 2 px with a deeper shadow; deselecting fades the seal and settles the paper, from wherever the
//                            stamp was; the seal stays clear of the header's ⋯ button; many selected cards each get one; Warm Ink
//                            has no seal and no lift (#128)
//  inkWashPaperFillsCard   — the paper reaches all four edges of cards of very different aspect ratios (#112: it was
//                            shrunk to fit and centred, its torn edge inside the card, off the shadow and header wash)
//  inkWashPaperKeptWhileEditing — a long Note growing while it is edited keeps its paper image: one image per card size was redrawn
//                            and decoded again on every 4 px the card grew, and the card showed the board through it for a frame
//  inkWashBackgroundNoStreaks — the mountains behind the board are plain gradient shapes, no SVG filter: the filter was worked out at
//                            the image's own 900×540 and scaled up, so its near-transparent gradients broke into horizontal streaks
//                            and its anisotropic turbulence smeared them into text-like blots (#136); light and dark, screenshots
//  inkWashTitleNoSeal      — the board's name in the top left has no seal after it (#138)
//  inkWashSectionBrushFrame — a Section's frame is four dry brush strokes (one filled path, no border), the title written in
//                            running script in the gap of the top stroke; selected = strokes and title vermilion; the frame is
//                            the same path every time it is drawn and follows a resize by drag; nested Sections too; light and
//                            dark, with screenshots; Warm Ink keeps its border and title (#137)
import * as fs from "node:fs";
import * as path from "node:path";
import { shot, symCard, findSym, put, OUT } from "../harness";
import { DEFAULT_SETTINGS, emptyBoard, type Board } from "@codeboard/core";
import { test, open, check, idle, until, type Host } from "../fixtures";

const card = (q: string) => {
  const s = findSym(q);
  return symCard(s.f, s.s);
};

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

const ink = { theme: "ink-wash" } as never;

/** A copy of the screenshots somewhere else too (INK_SHOTS), e.g. for review */
function keep(name: string) {
  const dir = process.env.INK_SHOTS;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(dir, `${name}.png`));
  } catch {
    /* no such folder here: harness output only */
  }
}

/** Freezes every running animation and transition at t ms (Web Animations), so a screenshot shows that moment */
const freezeAt = (h: Host, t: number) =>
  h.page.evaluate((t) => {
    const as = document.getAnimations();
    for (const a of as) {
      a.pause();
      a.currentTime = t;
    }
    return as.map((a) => (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty);
  }, t);
const finish = (h: Host) => h.page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));

test("inkWashLook", async () => {
  const res: Record<string, unknown> = {};
  let ok = true;
  // the cards' sizes in Warm Ink: Ink Wash's paper is drawn outside the card and must not change them
  const w = await open({ board: board(), light: true, w: 1300, h: 820 });
  await idle(w);
  const sizes = () =>
    w.page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".card[data-id]")].map((c) => [c.offsetWidth, c.offsetHeight]),
    );
  const warm = await sizes();
  await w.page.context().close();
  for (const lt of [true, false]) {
    const h = await open({ board: board(), light: lt, w: 1300, h: 820, settings: ink });
    await idle(h);
    const r = await h.page.evaluate(() => {
      const cs = (e: Element, p?: string) => getComputedStyle(e, p);
      const links = [...document.querySelectorAll<SVGGElement>("g.link")].map((g) => {
        const b = g.querySelector<SVGPathElement>("path.brush");
        return {
          brush: !!b && /Z$/.test(b.getAttribute("d") ?? "") && cs(b).fill !== "none",
          dash: b ? cs(b).strokeDasharray : "",
          edge: cs(g.querySelector("path.edge")!).stroke,
          feibai: g.querySelectorAll("path.feibai").length,
        };
      });
      const cards = [...document.querySelectorAll<HTMLElement>(".card[data-id]")].map((c) => ({
        paper: c.style.getPropertyValue("--deckle").startsWith('url("data:image/svg+xml'),
        before: cs(c, "::before").borderImageSource.startsWith('url("data:image/svg+xml'),
        bg: cs(c).backgroundColor,
        size: [c.offsetWidth, c.offsetHeight],
      }));
      const step = document.querySelector(".chead > .step");
      const calls = [...document.querySelectorAll<HTMLElement>(".src .call")];
      const pill = document.querySelector(".bbar .pill")!;
      return {
        links,
        cards,
        seal: step
          ? {
              color: cs(step).color,
              bg: cs(step).backgroundColor,
              mask: cs(step).maskImage.split("data:image").length - 1,
            }
          : null,
        calls: calls.length,
        callStroke: calls.every((c) => /\bcv[0-4]\b/.test(c.className) && cs(c).backgroundImage.startsWith("url(")),
        callDeco: calls.every((c) => cs(c).textDecorationLine === "none"),
        // the stroke and its frost are drawn under the buttons, masked to the stroke's outline
        bar: {
          img: cs(pill, "::before").backgroundImage.startsWith("url("),
          mask: cs(pill, "::before").maskImage.startsWith("url("),
          frost: cs(pill, "::before").backdropFilter,
          shadow: cs(pill).boxShadow,
        },
        // the header: a faint ink wash fading to the right, no ink line under it
        heads: [...document.querySelectorAll<HTMLElement>(".card:not(.nobg) > .cface > .chead")].map((e) => ({
          wash: cs(e).backgroundImage.startsWith("linear-gradient("),
          line: cs(e, "::after").content,
        })),
      };
    });
    // select a card: its seal is stamped on
    await h.page.locator(".card.ccard .ctitle").nth(1).click();
    await h.page.locator(".card.ccard.sel").waitFor();
    await finish(h);
    const sel = await h.page.evaluate(() => {
      const c = document.querySelector(".card.sel")!,
        s = getComputedStyle(c.querySelector(".cface")!, "::before");
      return { seal: s.content, opacity: s.opacity, ring: getComputedStyle(c, "::after").boxShadow };
    });
    await h.post({ type: "toast", text: "Copied 3 cards" });
    await h.page.locator(".toast").waitFor();
    await idle(h);
    const toast = await h.page.evaluate(() => {
      const t = document.querySelector(".toast")!.getBoundingClientRect(),
        b = document.querySelector(".bbar .pill")!.getBoundingClientRect();
      return { gap: Math.round(b.top - t.bottom) };
    });
    const name = `ink-wash-board-${lt ? "light" : "dark"}`;
    await shot(h, name);
    keep(name);
    const sizesNow = r.cards.map((c) => c.size);
    const one =
      r.links.length === 2 &&
      r.links.every((l) => l.brush && l.feibai === 1 && l.edge === "none" && (l.dash === "none" || l.dash === "")) &&
      r.cards.every((c) => c.paper && c.before && c.bg === "rgba(0, 0, 0, 0)") &&
      JSON.stringify(sizesNow) === JSON.stringify(warm) &&
      !!r.seal &&
      r.seal.bg === "rgba(0, 0, 0, 0)" &&
      r.seal.mask === 2 &&
      r.calls > 0 &&
      r.callStroke &&
      r.callDeco &&
      r.bar.img &&
      r.bar.mask &&
      r.bar.frost.includes("blur(7px)") &&
      r.bar.shadow === "none" &&
      r.heads.length > 0 &&
      r.heads.every((x) => x.wash && x.line === "none") &&
      sel.seal.includes("选") &&
      sel.opacity === "0.92" &&
      sel.ring === "none" &&
      toast.gap >= 4;
    ok &&= one;
    res[lt ? "light" : "dark"] = { ...r, links: r.links, warm, sel, toast };
    await h.page.context().close();
  }
  check("inkWashLook", ok, res);
});

/** Each code card's selection seal (.cface::before), the card's lift, and whether the seal lies clear of the card's ⋯ button */
const seals = (h: Host) =>
  h.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".card.ccard")].map((c) => {
      const s = getComputedStyle(c.querySelector(".cface")!, "::before"),
        cs = getComputedStyle(c),
        r = c.getBoundingClientRect(),
        m = c.querySelector(".cmenu")!.getBoundingClientRect(),
        px = (v: string) => Number.parseFloat(v) || 0;
      // the seal's box (top / right from the card's corner), widened by what its tilt adds at the corners
      const w = px(s.width),
        a = (Math.abs(px(s.rotate)) * Math.PI) / 180,
        l = r.right - px(s.right) - w,
        t = r.top + px(s.top),
        k = (w / 2) * (Math.cos(a) + Math.sin(a) - 1);
      return {
        sel: c.classList.contains("sel"),
        text: s.content,
        opacity: Number(s.opacity),
        translate: cs.translate,
        shadows: cs.boxShadow.split("rgba").length - 1,
        clear: l - k >= m.right || t + w + k <= m.top,
      };
    }),
  );

test("inkWashSelectSeal", async () => {
  const res: Record<string, unknown> = {};
  const h = await open({ board: board(), light: true, w: 1300, h: 820, settings: ink });
  await idle(h);
  const none = await seals(h);
  res.none = none;
  // slow motion (the CSS durations are × --t), so the transitions can be looked at while they run
  await h.page.evaluate(() => document.documentElement.style.setProperty("--t", "20"));
  const title = h.page.locator(".card.ccard .ctitle");
  await title.nth(1).click();
  await h.page.locator(".card.ccard.sel").waitFor();
  // the seal drops in: it comes down from larger and more turned (scale / rotate) while it fades in
  res.dropping = await h.page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => (a.effect as KeyframeEffect).pseudoElement === "::before" && a.playState === "running")
      .map((a) => (a as CSSTransition).transitionProperty),
  );
  // partway in, click the empty board: the seal fades from where it was, it does not jump
  await until(h, "the seal is partway in", async () => (await seals(h))[1].opacity > 0.3);
  await h.page.mouse.click(690, 30);
  await until(h, "deselected", async () => !(await h.page.locator(".card.sel").count()));
  res.reversed = (await seals(h))[1].opacity;
  await h.page.evaluate(() => document.documentElement.style.removeProperty("--t"));
  await finish(h);
  await idle(h);
  const after = await seals(h);
  res.after = after;
  // one card, at normal speed
  await title.nth(1).click();
  await h.page.locator(".card.ccard.sel").waitFor();
  await idle(h);
  const one = await seals(h);
  res.one = one;
  await shot(h, "ink-wash-select-single");
  keep("ink-wash-select-single");
  // many: each selected card has its own seal
  await title.nth(0).click({ modifiers: ["Shift"] });
  await title.nth(2).click({ modifiers: ["Shift"] });
  await idle(h);
  const many = await seals(h);
  res.many = many;
  await shot(h, "ink-wash-select-multi");
  keep("ink-wash-select-multi");
  await h.page.mouse.click(690, 30);
  await idle(h);
  const gone = await seals(h);
  res.gone = gone;
  await h.page.context().close();
  // Warm Ink: its own selection ring, no seal and no lift
  const w = await open({ board: board(), light: true, w: 1300, h: 820 });
  await idle(w);
  await w.page.locator(".card.ccard .ctitle").nth(1).click();
  await w.page.locator(".card.ccard.sel").waitFor();
  await idle(w);
  const warm = await seals(w);
  res.warm = warm;
  await w.page.context().close();
  type Seal = (typeof none)[number];
  const hidden = (x: Seal) => x.opacity === 0 && x.translate === "none";
  const shown = (x: Seal) =>
    x.text.includes("选") && x.opacity > 0.9 && x.clear && x.translate === "0px -2px" && x.shadows > none[0].shadows;
  check(
    "inkWashSelectSeal",
    none.length === 3 &&
      none.every(hidden) &&
      ["scale", "rotate", "opacity"].every((p) => (res.dropping as string[]).includes(p)) &&
      (res.reversed as number) > 0.15 &&
      after.every(hidden) &&
      one.filter((x) => x.sel).length === 1 &&
      one.every((x) => (x.sel ? shown(x) : hidden(x))) &&
      many.length === 3 &&
      many.every((x) => x.sel && shown(x)) &&
      gone.every(hidden) &&
      warm.some((x) => x.sel) &&
      warm.every((x) => !x.text.includes("选") && x.translate === "none"),
    res,
  );
});

test("inkWashPaperFillsCard", async () => {
  // Notes whose size rounded to the paper's 4 px step has another aspect ratio than the card (a wide short one, #112's Note, a tall
  // one): the paper still reaches the card's edges on all four sides, it is not shrunk to fit and centred inside the card
  const md =
    "认识到现代 DRAM 的 burst 组织方式以及现代缓存层次的 cache line 组织方式后，**把线程的内存访问组织成有利的模式**。";
  const b = emptyBoard("b1", "纸");
  const sizes: Record<string, { x: number; y: number; w: number; h: number }> = {
    wide: { x: 40, y: 60, w: 900, h: 102 },
    note: { x: 40, y: 220, w: 460, h: 202 },
    tall: { x: 560, y: 220, w: 298, h: 398 },
  };
  for (const [id, p] of Object.entries(sizes)) {
    b.cards.push({ id, kind: "note", look: "note", title: "memory coalescing 内存合并访存", md } as never);
    b.place[id] = p;
  }
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 1000, h: 680, settings: ink });
  await idle(h);
  await shot(h, "ink-wash-paper-edges");
  keep("ink-wash-paper-edges");
  const png = (await h.page.screenshot()).toString("base64");
  // just inside each edge (3 px, past the torn edge's ±1 px), halfway along it: the paper's colour, not the board's
  const res = await h.page.evaluate(async (png) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const x = cv.getContext("2d", { willReadFrequently: true })!;
    x.drawImage(img, 0, 0);
    const at = (px: number, py: number) => [...x.getImageData(Math.round(px), Math.round(py), 1, 1).data.slice(0, 3)];
    const paper = [0xfb, 0xf8, 0xf1];
    const off = (c: number[]) => c.reduce((s, v, i) => s + Math.abs(v - paper[i]), 0);
    return [...document.querySelectorAll<HTMLElement>(".card[data-id]")].map((c) => {
      const r = c.getBoundingClientRect(),
        mx = r.left + r.width / 2,
        my = r.top + r.height * 0.7;
      const sides = { left: at(r.left + 3, my), right: at(r.right - 4, my), bottom: at(mx, r.bottom - 4) };
      return {
        id: c.dataset.id,
        sides,
        off: Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, off(v)])),
      };
    });
  }, png);
  await h.page.context().close();
  check("inkWashPaperFillsCard", res.length === 3 && res.every((c) => Object.values(c.off).every((d) => d <= 8)), res);
});

test("inkWashPaperKeptWhileEditing", async () => {
  const md = Array.from(
    { length: 30 },
    (_, i) =>
      `Line ${i}: the loss $L_{${i}} = \\sum_i x_i^2$ and **bold** text that wraps past the end of one line here.`,
  ).join("\n\n");
  const b = emptyBoard("b1", "纸");
  put(b, { id: "n0", kind: "note", look: "note", md } as never, 40, 40, 520);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 1000, h: 800, settings: ink });
  await idle(h);
  const card = h.page.locator('.card[data-id="n0"]');
  await card.locator(".nbody").dblclick({ position: { x: 40, y: 200 } });
  await h.page.waitForSelector('.card[data-id="n0"] .md-pm');
  await idle(h);
  // every paper image the card's ::before is given while it grows, and its height before and after
  const h0 = await card.evaluate((c: HTMLElement) => {
    const w = window as unknown as { papers: string[] };
    const src = () => getComputedStyle(c, "::before").borderImageSource;
    w.papers = [src()];
    new MutationObserver(() => {
      if (src() !== w.papers[w.papers.length - 1]) w.papers.push(src());
    }).observe(c, { attributes: true, attributeFilter: ["style", "class"] });
    return c.offsetHeight;
  });
  for (let i = 0; i < 8; i++) {
    await h.page.keyboard.type("more words ");
    await h.page.keyboard.press("Enter");
  }
  await until(h, "the Note grew by the new lines", async () => (await card.evaluate((c) => c.offsetHeight)) > h0 + 150);
  const res = await card.evaluate((c: HTMLElement) => ({
    papers: (window as unknown as { papers: string[] }).papers.map((u) => u.slice(0, 120)),
    h: c.offsetHeight,
  }));
  await h.page.context().close();
  check(
    "inkWashPaperKeptWhileEditing",
    res.papers.length === 1 && res.papers[0].startsWith('url("data:image/svg+xml'),
    { h0, ...res },
  );
});

test("inkWashFlashBrush", async () => {
  // clicking a call that is already expanded flashes its line and jumps to its card (actions/flow.ts expandCall)
  const flashOf = async (word: string) => {
    const h = await open({ board: board(), light: true, w: 1300, h: 820, settings: ink });
    await idle(h);
    await h.page
      .locator(".card.ccard")
      .first()
      .locator(".src .call", { hasText: new RegExp(`^${word}$`) })
      .click();
    await until(h, `the ${word} line flashes`, () => h.page.locator(".rowbg.flash").count());
    const r = await h.page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".rowbg.flash")!,
        a = getComputedStyle(row, "::after");
      // the code font's character width, measured here only to check the stroke (the board computes it in ch, unmeasured)
      const s = document.createElement("span");
      s.textContent = "0".repeat(100);
      s.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      row.appendChild(s);
      const ch = s.getBoundingClientRect().width / 100;
      s.remove();
      const anims = document.getAnimations().map((x) => (x as CSSAnimation).animationName);
      return { width: parseFloat(a.width), left: parseFloat(a.left), ch, anims, img: a.backgroundImage.slice(0, 30) };
    });
    if (word === "schedule") await shot(h, "ink-wash-flash", "now");
    await h.page.context().close();
    return r;
  };
  const a = await flashOf("schedule"),
    b = await flashOf("call");
  // seqs, is_prefill = self.scheduler.schedule()  /  token_ids = self.model_runner.call("run", seqs, is_prefill)
  const ra = "seqs, is_prefill = self.scheduler.schedule()".length + 1,
    rb = 'token_ids = self.model_runner.call("run", seqs, is_prefill)'.length + 1;
  check(
    "inkWashFlashBrush",
    Math.abs(a.width - ra * a.ch) < 1 &&
      Math.abs(b.width - rb * b.ch) < 1 &&
      a.left === b.left &&
      a.anims.includes("ink-sweep") &&
      a.img.startsWith('url("data:image/svg+xml'),
    { a, b, ra, rb },
  );
});

test("inkWashCallStrokeStable", async () => {
  const b = board();
  // a second copy of LLMEngine.step: its calls are the same words
  const twin = card("LLMEngine.step");
  put(b, twin, 60, 760, 560);
  const h = await open({ board: b, light: true, w: 1300, h: 1300, settings: ink });
  await idle(h);
  const r = await h.page.evaluate(() => {
    const by = new Map<string, Set<string>>();
    for (const c of document.querySelectorAll<HTMLElement>(".src .call")) {
      const v = [...c.classList].find((k) => /^cv[0-4]$/.test(k)) ?? "none";
      const w = c.textContent ?? "";
      if (!by.has(w)) by.set(w, new Set());
      by.get(w)!.add(`${v} ${getComputedStyle(c).backgroundImage.slice(0, 60)}`);
    }
    return [...by].map(([w, s]) => [w, [...s]] as const);
  });
  await h.page.context().close();
  const kinds = new Set(r.flatMap(([, s]) => s.map((x) => x.split(" ")[0])));
  check("inkWashCallStrokeStable", r.length >= 4 && r.every(([, s]) => s.length === 1) && kinds.size >= 2, r);
});

test("inkWashMotions", async () => {
  const res: Record<string, unknown> = {};
  const h = await open({
    board: board(),
    light: true,
    w: 1300,
    h: 820,
    settings: { ...ink, hideNumbers: true } as never,
  });
  await idle(h);
  // what Ink Wash's own animations (and the menu's transitions) animate
  const props = () =>
    h.page.evaluate(() =>
      document
        .getAnimations()
        .filter(
          (a) =>
            (a as CSSAnimation).animationName?.startsWith("ink-") ||
            (a.effect as KeyframeEffect).target?.classList.contains("ctx"),
        )
        .flatMap((a) =>
          (a.effect as KeyframeEffect)
            .getKeyframes()
            .flatMap((k) => Object.keys(k))
            .filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)),
        ),
    );
  const cheap = (ps: string[]) =>
    ps.every((p) => ["transform", "opacity", "clipPath", "clip-path", "scale", "translate", "--ink-r"].includes(p));
  // the step seals appear on cards already on the board: they stamp in
  await h.post({
    type: "host",
    host: { settings: { ...DEFAULT_SETTINGS, theme: "ink-wash", hideNumbers: false } } as never,
  });
  await h.page.locator(".chead > .step.stamp").first().waitFor();
  res.stampProps = await props();
  res.stamp = await freezeAt(h, 60);
  await shot(h, "ink-wash-motion-stamp", "now");
  keep("ink-wash-motion-stamp");
  await finish(h);
  await until(h, "the stamps are over", async () => !(await h.page.locator(".chead > .step.stamp").count()));
  // the context menu unrolls from the top
  await h.page.locator(".card.ccard .ctitle").first().click({ button: "right" });
  await h.page.locator(".ctx.open").waitFor();
  res.menuProps = await props();
  res.menu = await freezeAt(h, 70);
  await shot(h, "ink-wash-motion-menu", "now");
  keep("ink-wash-motion-menu");
  await finish(h);
  // …and rolls back up when it closes: a copy left where it was (.ctx.closing) runs the close and goes
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
  await h.page.keyboard.press("Escape");
  await until(h, "the menu closed", async () => !(await h.page.locator(".ctx.open").count()));
  await until(h, "the close ran", () => h.page.evaluate(() => !!(window as unknown as { __close?: string[] }).__close));
  res.menuClose = await h.page.evaluate(() => (window as unknown as { __close: string[] }).__close);
  await until(h, "the closing copy is gone", async () => !(await h.page.locator(".ctx").count()));
  await h.page.mouse.click(1200, 30);
  // a deleted Note's ink disperses
  await h.page.locator('.card[data-id="n1"] .chead').click();
  await h.page.locator('.card.sel[data-id="n1"]').waitFor();
  await h.page.keyboard.press("Delete");
  await until(h, "the ghost starts", () => h.page.locator(".card.ghost-out.go").count());
  res.deleteProps = await props();
  res.delete = await freezeAt(h, 220);
  await shot(h, "ink-wash-motion-delete", "now");
  keep("ink-wash-motion-delete");
  await finish(h);
  await until(h, "the ghost is gone", async () => !(await h.page.locator(".card.ghost-out").count()), 3000);
  // jumping to a line: the brush sweeps
  await h.page
    .locator(".card.ccard")
    .first()
    .locator(".src .call", { hasText: /^schedule$/ })
    .click();
  await until(h, "the line flashes", () => h.page.locator(".rowbg.flash").count());
  res.flashProps = await props();
  res.flash = await freezeAt(h, 200);
  await shot(h, "ink-wash-motion-flash", "now");
  keep("ink-wash-motion-flash");
  await finish(h);
  // a toast unrolls and its seal stamps in
  await h.post({ type: "toast", text: "Copied 3 cards" });
  await h.page.locator(".toast").waitFor();
  res.toastProps = await props();
  res.toast = await freezeAt(h, 90);
  await shot(h, "ink-wash-motion-toast", "now");
  keep("ink-wash-motion-toast");
  await h.page.context().close();
  const names = (k: string) => (res[k] as string[]).join(" ");
  check(
    "inkWashMotions",
    names("stamp").includes("ink-stamp") &&
      names("menu").includes("clip-path") &&
      names("menuClose").includes("clip-path") &&
      names("delete").includes("ink-disperse") &&
      names("flash").includes("ink-sweep") &&
      names("toast").includes("ink-toast") &&
      ["stampProps", "menuProps", "deleteProps", "flashProps", "toastProps"].every(
        (k) => (res[k] as string[]).length && cheap(res[k] as string[]),
      ),
    res,
  );
});

test("inkWashBackgroundNoStreaks", async () => {
  for (const lt of [true, false]) {
    const h = await open({ board: board(), light: lt, w: 1400, h: 900, scale: 2, settings: ink });
    await idle(h);
    const scene = await h.page.evaluate(async () => {
      const bg = getComputedStyle(document.querySelector(".board")!).backgroundImage,
        url = bg.match(/url\("([^"]+)"\)/)?.[1] ?? "";
      // the build inlines the scene as a data URI
      if (url.startsWith("data:image/svg+xml,")) return { bg: bg.slice(0, 80), svg: decodeURIComponent(url.slice(19)) };
      return { bg, svg: url ? await (await fetch(url)).text() : "" };
    });
    check(
      "inkWashBackgroundNoStreaks",
      scene.svg.includes("<path") && !/<filter|feTurbulence|feDisplacementMap|feGaussianBlur/.test(scene.svg),
      { light: lt, bg: scene.bg, svg: scene.svg.slice(0, 600) },
    );
    const name = `ink-wash-scene-${lt ? "light" : "dark"}`;
    await shot(h, name);
    keep(name);
    await h.page.context().close();
  }
});

test("inkWashTitleNoSeal", async () => {
  const h = await open({ board: board(), light: true, w: 1300, h: 820, scale: 2, settings: ink });
  await idle(h);
  const mast = await h.page.evaluate(() => {
    const m = document.querySelector(".mast")!;
    return { name: m.textContent, after: getComputedStyle(m, "::after").content };
  });
  check("inkWashTitleNoSeal", mast.name === "nano-vllm · 推理一步" && mast.after === "none", mast);
  const box = (await h.page.locator(".mast").boundingBox())!;
  await h.page.screenshot({
    path: path.join(OUT, "ink-wash-title.png"),
    clip: { x: 0, y: 0, width: Math.min(1300, box.x + box.width + 120), height: box.y + box.height + 30 },
  });
  await h.page.context().close();
});

/** Three Sections, one nested in another, plus a long English title, for the brush frame */
function sectionBoard(): Board {
  const b = board();
  const [step, sch, run] = b.cards;
  b.sections.push({ id: "S1", title: "推理一步", x: 40, y: 100, w: 600, h: 640 });
  b.sections.push({ id: "S2", title: "Scheduler and KV cache allocation", x: 730, y: 70, w: 540, h: 800 });
  b.sections.push({ id: "S3", title: "模型执行", parent: "S2", x: 745, y: 540, w: 510, h: 300 });
  b.place[step.id].section = "S1";
  b.place.n1.section = "S1";
  b.place[sch.id].section = "S2";
  b.place[run.id].section = "S3";
  b.place[step.id].y = 180;
  b.place.n1.y = 510;
  b.place[sch.id].y = 140;
  b.place[run.id].y = 620;
  return b;
}

/** Each Section's frame and title: the brush image (its path, colour), the border, and where the title sits on the top stroke */
const sectionLooks = (h: Host) =>
  h.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".sect[data-sect]")].map((e) => {
      const id = e.dataset.sect!,
        l = document.querySelector<HTMLElement>(`.slabel[data-sect="${id}"]`)!,
        nm = l.querySelector<HTMLElement>(".sname")!,
        svg = e.querySelector<SVGSVGElement>("svg.sbrush"),
        path = svg?.querySelector<SVGPathElement>("path"),
        fr = e.getBoundingClientRect(),
        lr = l.getBoundingClientRect(),
        z = fr.width / e.offsetWidth,
        cs = getComputedStyle(e),
        ls = getComputedStyle(l);
      // the top stroke, in the image's own units (it is drawn 12 px outside the frame): ink across the title, ink right of it
      let across = 0,
        right = 0,
        cols = 0;
      if (path && svg) {
        const p = svg.createSVGPoint(),
          inkAt = (x: number) => {
            for (let y = 6; y <= 18; y += 0.5) {
              p.x = x;
              p.y = y;
              if (path.isPointInFill(p)) return true;
            }
            return false;
          },
          x0 = 13 + (lr.left - fr.left) / z,
          x1 = x0 + lr.width / z;
        for (let x = x0 + 2; x < x1 - 2; x += 2) across += +inkAt(x);
        for (let x = x1 + 24; x < 12 + e.offsetWidth - 20; x += 4, cols++) right += +inkAt(x);
      }
      return {
        id,
        sel: e.classList.contains("sel"),
        brush: !!path && /^M[\d.\s-]/.test(path.getAttribute("d") ?? "") && /Z$/.test(path.getAttribute("d") ?? ""),
        subpaths: (path?.getAttribute("d") ?? "").split("M").length - 1,
        d: path?.getAttribute("d") ?? "",
        fill: path ? getComputedStyle(path).fill : "",
        fillOpacity: path ? getComputedStyle(path).fillOpacity : "",
        filter: svg ? getComputedStyle(svg).filter : "",
        transition: svg ? getComputedStyle(svg).transitionDuration : "",
        border: cs.borderTopColor,
        borderWidth: cs.borderTopWidth,
        across,
        right: cols ? right / cols : 0,
        family: ls.fontFamily,
        size: ls.fontSize,
        color: ls.color,
        // the title's middle against the top stroke, and its left against the frame's (screen px at zoom 1)
        mid: Math.round((lr.top + lr.height / 2 - fr.top) / z),
        left: Math.round((lr.left - fr.left) / z),
        clipped: nm.scrollWidth > nm.clientWidth + 1,
        font: document.fonts.check(`25px "Zhi Mang Xing"`, nm.textContent ?? ""),
        within: lr.right <= fr.right + 1,
      };
    }),
  );

test("inkWashSectionBrushFrame", async () => {
  const res: Record<string, unknown> = {};
  let ok = true;
  for (const lt of [true, false]) {
    const h = await open({ board: sectionBoard(), light: lt, w: 1320, h: 960, scale: 2, settings: ink });
    await idle(h);
    await until(h, "the titles' running script is loaded", () =>
      h.page.evaluate(() => document.fonts.check('25px "Zhi Mang Xing"', "推理一步 Scheduler")),
    );
    await idle(h);
    const before = await sectionLooks(h);
    // select S1 by its title: strokes and title turn vermilion
    await h.page.locator('.slabel[data-sect="S1"] .sname').click();
    await h.page.locator('.sect.sel[data-sect="S1"]').waitFor();
    await idle(h);
    const name = `ink-wash-sections-${lt ? "light" : "dark"}`;
    await shot(h, name);
    keep(name);
    const sel = await sectionLooks(h);
    // deselect: the same path as before (drawn once per size and Section, the same every time)
    await h.page.keyboard.press("Escape");
    await until(h, "deselected", async () => !(await h.page.locator(".sect.sel").count()));
    await idle(h);
    const again = await sectionLooks(h);
    const ink0 = lt ? "rgb(29, 28, 26)" : "rgb(233, 229, 218)",
      zhu = lt ? "rgb(184, 50, 31)" : "rgb(214, 83, 58)";
    const one =
      before.length === 3 &&
      before.every(
        (x) =>
          x.brush &&
          x.subpaths >= 5 &&
          x.fill === ink0 &&
          x.fillOpacity === "0.72" &&
          x.filter === "none" &&
          x.transition.split(",")[0] === "0.18s" &&
          x.border === "rgba(0, 0, 0, 0)" &&
          x.across === 0 &&
          x.right > 0.75 &&
          /^"?Zhi Mang Xing"?/.test(x.family) &&
          x.size === "25px" &&
          Math.abs(x.mid) <= 3 &&
          x.left >= 22 &&
          x.left <= 28 &&
          x.font &&
          x.within,
      ) &&
      sel.every((x) =>
        x.id === "S1" ? x.sel && x.fill === zhu && x.color === zhu : !x.sel && x.fill === ink0 && x.color !== zhu,
      ) &&
      again.every((x, i) => x.d === before[i].d && x.fill === ink0);
    ok &&= one;
    res[lt ? "light" : "dark"] = {
      one,
      before: before.map(({ d, ...x }) => ({ ...x, d: d.length })),
      sel: sel.map((x) => [x.id, x.fill, x.color]),
    };
    if (lt) {
      // resize S1 by its right edge: the frame follows the drag, and the left stroke (its texture keyed by distance) stays as it was
      const e = await h.page.locator('.sect[data-sect="S1"] .sedge[data-edge="e"]').boundingBox();
      const d0 = before.find((x) => x.id === "S1")!.d;
      await h.page.mouse.move(e!.x + e!.width / 2, e!.y + e!.height / 2);
      await h.page.mouse.down();
      for (let i = 1; i <= 10; i++) await h.page.mouse.move(e!.x + e!.width / 2 + i * 8, e!.y + e!.height / 2);
      const mid = await sectionLooks(h);
      await h.page.mouse.up();
      await idle(h);
      const d1 = mid.find((x) => x.id === "S1")!.d;
      // the left stroke (and the stub left of the title): the subpaths that lie wholly within 20 px of the image's left edge
      const lefts = (d: string) =>
        d.split("M").filter(
          (p) =>
            p &&
            p
              .split(/[LZ]/)
              .filter(Boolean)
              .every((q) => Number.parseFloat(q) < 20),
        );
      const resize = { changed: d1 !== d0, leftSame: JSON.stringify(lefts(d1)) === JSON.stringify(lefts(d0)) };
      ok &&= resize.changed && resize.leftSame && lefts(d0).length > 0;
      res.resize = resize;
    }
    await h.page.context().close();
  }
  // Warm Ink: its own border and title, no brush
  const w = await open({ board: sectionBoard(), light: true, w: 1320, h: 960 });
  await idle(w);
  const warm = await sectionLooks(w);
  await w.page.context().close();
  res.warm = warm.map(({ d, ...x }) => x);
  ok &&= warm.every((x) => !x.brush && x.border !== "rgba(0, 0, 0, 0)" && !/Zhi Mang Xing/.test(x.family));
  check("inkWashSectionBrushFrame", ok, res);
});
