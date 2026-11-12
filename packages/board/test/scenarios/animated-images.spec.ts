// Animated images in a Note (GIFs, SVGs animated by their own CSS / SMIL), on the real host with the pictures in its assets/:
//   animGifSnapshot           a GIF stands still on its first frame (its snapshot), drawn over the hidden <img>, and keeps still;
//                             its control bar stays hidden until the image is hovered
//   animGifHoverBar           hovering the GIF fades in a capsule over the bottom of the image (inside it, the card's size
//                             unchanged) that fades out again when the pointer leaves; its buttons step and play (selecting the
//                             image), dragging its scrubber stands the image on that frame (also dragged off the image), Home /
//                             End go to the first / last frame and ← → step without nudging; zoomed out under 50% it hides;
//                             deselecting saves the frame it stopped on as {frame=N}, one undo step, which the next view starts on
//   animLoopAlwaysPlays       the bar's loop button saves {loop=true}: the GIF plays after deselecting, with an "Always playing"
//                             badge on hover; turning it off saves the frame it stopped on; reduced motion never starts it
//   animSvgInline             an SVG animated by CSS keyframes and SMIL is drawn inline (shadow root), cleaned (no script,
//                             handlers or outside references), paused on its step (data-steps), stepped by its bar, and its
//                             colours follow the board's light / dark theme; a still SVG stays an <img>
//   animBarFollowsTheme       the bar's glass is the theme's own (Ink Wash: its tooltip colours in light, its surface in dark)
//   animImageCardHoverBar     an image card's GIF stands on the card's stored frame; hovering shows the same bar, selecting the
//                             card keeps it (scrub, Home / End, ← →, Space; ↑ ↓ still nudge the card; hidden zoomed out);
//                             deselecting stores the frame on the card (one undo step); the loop button stores loop and the GIF
//                             plays unselected with the badge; an HTML snapshot taken while it plays has the plain <img>
//   animImageCardSvg          an image card's animated SVG is drawn inline and paused, stepped by its bar, the step stored;
//                             standing still, nothing in it is a compositor layer (its CSS animations frozen into its style)
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type ImageCard, type NoteCard } from "@codeboard/core";
import { gif } from "@codeboard/host/testing";
import { put, shot, type Host } from "../harness";
import { test, check, until, idle, hold, hostBoards } from "../fixtures";
import { layerScales, snapshotsOf, type TraceEvent } from "../probes";
import { GIF_MIN_DELAY } from "../../src/state/timing";

const N = 24,
  W = 240,
  H = 150,
  BAR_Y = 134;
/** A tiled matrix walk in 24 frames: two 4×4 grids whose current tile (left) and column (right) move on, cells done tinted, and a
 *  progress bar (accent) of 8(f + 1) px along y = 130..137, which tells the frame shown */
const GIF = gif(
  W,
  H,
  [
    [255, 255, 255],
    [31, 30, 27],
    [193, 95, 60],
    [241, 217, 204],
    [201, 197, 187],
  ],
  Array.from({ length: N }, (_, f) => (x: number, y: number) => {
    if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) return 1;
    if (y >= 130 && y < 138) return x >= 20 && x < 20 + (f + 1) * 8 ? 2 : x >= 20 && x < 20 + N * 8 ? 4 : 0;
    const grid = (gx: number, fill: (c: number, r: number) => number) => {
      const cx = x - gx,
        cy = y - 20;
      if (cx < 0 || cy < 0 || cx > 96 || cy > 96) return -1;
      if (cx % 24 === 0 || cy % 24 === 0) return 1;
      return fill(Math.floor(cx / 24), Math.floor(cy / 24));
    };
    const cell = f % 16;
    const m = grid(20, (c, r) => (r * 4 + c === cell ? 4 : r * 4 + c < cell ? 3 : 0));
    if (m >= 0) return m;
    const n = grid(124, (c) => (c === f % 4 ? 4 : 0));
    return n >= 0 ? n : 0;
  }),
  GIF_MIN_DELAY,
);
const GIF_FILE = "0123456789abcdef-240x150.gif";

/** Eight steps of 0.5 s: a box hops along (CSS), a dot pulses (SMIL); colours from the board's theme with fallbacks */
const SVG_ANIM = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="320" height="120" viewBox="0 0 320 120" data-steps="8" onload="window.__svgRan=1">
<script>window.__svgRan = 1</script>
<style>@import url(https://example.com/x.css);
.bg{fill:var(--surface,#fff)} .ink{fill:var(--ink,#1f1e1b)} .cell{fill:none;stroke:var(--ink-3,#8f8a80);stroke-width:1.5}
.lbl{font:600 14px sans-serif;fill:var(--ink-2,#5d5a53)}
.hop{animation:hop 4s steps(8,end) infinite}
@keyframes hop{from{transform:translateX(0)}to{transform:translateX(320px)}}
</style>
<rect class="bg" width="320" height="120"/>
<text class="lbl" x="6" y="28">tile walk</text>
${Array.from({ length: 8 }, (_, i) => `<rect class="cell" x="${i * 40 + 1}" y="41" width="38" height="38"/>`).join("")}
<rect class="ink hop" x="4" y="44" width="32" height="32" rx="4"/>
<circle cx="300" cy="20" r="6" fill="#c15f3c"><animate attributeName="r" values="6;12;6" dur="4s" repeatCount="indefinite"/></circle>
<set attributeName="href" to="javascript:alert(1)"/>
<image href="https://example.com/x.png" width="10" height="10"/>
</svg>`;
const SVG_ANIM_FILE = "1123456789abcdef-320x120.svg";
/** One step of SVG_ANIM (4 s in 8 steps) */
const SVG_STEP_MS = 500;
const SVG_STILL = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#5aa469"/></svg>`;
const SVG_STILL_FILE = "2123456789abcdef-80x40.svg";

function board(md: string): Board {
  const b = emptyBoard("b1", "anim");
  b.cam = { x: 0, y: 0, z: 1 };
  put(b, { id: "n1", kind: "note", md, look: "note" } as NoteCard, 80, 60, 460);
  return b;
}
async function animHost(md: string, o: { light?: boolean } = {}) {
  return (await openAnim(board(md), o)).h;
}
/** The board on the real host with the pictures in its assets/; Export's save dialog writes into a temp file (exported: what was
 *  written, once it is) */
async function openAnim(b: Board, o: { light?: boolean; theme?: string } = {}) {
  const run = await hostBoards([b], {
    page: { light: o.light ?? true, w: 1100, h: 760, settings: { theme: o.theme ?? "warm-ink" } },
  });
  const dir = run.host.store.assetsDir(),
    saved = path.join(run.host.store.dir(), "export.html");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, GIF_FILE), GIF);
  fs.writeFileSync(path.join(dir, SVG_ANIM_FILE), SVG_ANIM);
  fs.writeFileSync(path.join(dir, SVG_STILL_FILE), SVG_STILL);
  run.ws.ui = { ...run.ws.ui, saveDialog: async () => saved };
  const h = await run.open(b.id);
  await idle(h);
  return { h, exported: () => (fs.existsSync(saved) ? fs.readFileSync(saved, "utf8") : undefined) };
}
const noteMd = (h: Host) => (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;

/** What the GIF's overlay shows: the frame whose bar is drawn (from the canvas's pixels), and whether the <img> is hidden. in: the
 *  element the image is in (a Note's body, an image card's box) */
const gifShown = (h: Host, inside = ".card .nbody") =>
  h.page.evaluate(
    ([y, inside]) => {
      const host = document.querySelector<HTMLElement>(`${inside} .md-anim`);
      const cv = host?.shadowRoot?.querySelector("canvas");
      const img = document.querySelector<HTMLImageElement>(`${inside} img`);
      if (!cv || !cv.width) return { frame: -1, hidden: false, over: false };
      const d = cv.getContext("2d", { willReadFrequently: true })!.getImageData(0, y, cv.width, 1).data;
      let n = 0;
      for (let i = 0; i < cv.width; i++) if (d[i * 4] > 150 && d[i * 4 + 1] < 140) n++;
      const a = host!.getBoundingClientRect(),
        b = img!.getBoundingClientRect();
      return {
        frame: n ? Math.round(n / 8) - 1 : -1,
        hidden: getComputedStyle(img!).opacity === "0",
        over: Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1,
      };
    },
    [BAR_Y, inside] as const,
  );
/** The control bar over the image in `inside`: shown (faded in, taking the pointer), its frame number, loop button, scrubbing */
const bar = (h: Host, inside = ".card .nbody") =>
  h.page.evaluate((inside) => {
    const b = document.querySelector<HTMLElement>(`${inside} .md-anim .animbar`);
    if (!b) return null;
    const cs = getComputedStyle(b);
    return {
      shown: b.classList.contains("on") && cs.opacity === "1" && cs.pointerEvents === "auto",
      gone: !b.classList.contains("on") && cs.opacity === "0",
      fno: b.querySelector<HTMLElement>(".fno")?.dataset.n ?? "",
      loop: b.querySelector(".loop")?.getAttribute("aria-pressed"),
      held: !!b.querySelector(".scrub.held"),
      bg: cs.backgroundColor,
    };
  }, inside);
const barShown = (h: Host, inside?: string) =>
  until(h, "the bar fades in", async () => {
    const b = await bar(h, inside);
    return b?.shown ? b : null;
  });
const barGone = (h: Host, inside?: string) =>
  until(h, "the bar fades out", async () => {
    const b = await bar(h, inside);
    return b?.gone ? b : null;
  });
const btn = (h: Host, label: string, inside = ".card .nbody") =>
  h.page.locator(`${inside} .animbar [aria-label="${label}"]`);
/** Waits until the GIF in `inside` shows frame f (from 0) */
const onFrame = (h: Host, f: number, what: string, inside?: string) =>
  until(h, what, async () => ((await gifShown(h, inside)).frame === f ? true : null)).catch(() => false);
const imgBox = (h: Host) => h.page.locator(".card .nbody img").first().boundingBox();
const center = (b: { x: number; y: number; width: number; height: number }) =>
  [b.x + b.width / 2, b.y + b.height / 2] as const;

test("animGifSnapshot", async () => {
  const h = await animHost(`Tiles\n\n![](assets/${GIF_FILE} "Fig 1: tiles")\n\nAfter.`);
  const a = await until(h, "the GIF is drawn over its image", async () => {
    const s = await gifShown(h);
    return s.frame >= 0 ? s : null;
  }).catch(() => null);
  await hold(h, GIF_MIN_DELAY * 4, "a playing GIF would have moved on by several frames");
  const b = await gifShown(h);
  check("anim-gif-snapshot-drawn", !!a && a.hidden && a.over, a);
  check("anim-gif-snapshot-first-frame", a?.frame === 0 && b.frame === 0, { a, b });
  check("anim-gif-bar-hidden-unhovered", (await bar(h))?.gone === true, await bar(h));
  await shot(h, "105-gif-snapshot");
});

/** A far Note makes the board big enough to zoom out below 50%: on a small board the zoom floor is 50% (core summaryMinZoom),
 *  where the bar still shows */
const farNote = (b: Board) => {
  put(b, { id: "far", kind: "note", md: "Far away", look: "note" } as NoteCard, 3000, 2000, 200);
  return b;
};

test("animGifHoverBar", async () => {
  const MD = `Tiles\n\n![](assets/${GIF_FILE} "Fig 1: tiles")\n\nAfter.`;
  const { h } = await openAnim(farNote(board(MD)));
  const pg = h.page;
  await until(h, "the GIF is drawn", async () => ((await gifShown(h)).frame >= 0 ? true : null));
  const card0 = await pg.locator('.card[data-id="n1"]').boundingBox();
  const box = (await imgBox(h))!;

  // hovering fades the bar in over the bottom of the image, inside it; leaving fades it out
  await pg.mouse.move(...center(box));
  const b0 = await barShown(h).catch(() => null);
  const bb = await pg.locator(".card .nbody .animbar").boundingBox();
  const card1 = await pg.locator('.card[data-id="n1"]').boundingBox();
  check("anim-bar-shows-on-hover", b0?.fno === `1/${N}` && b0.loop === "false", b0);
  check(
    "anim-bar-floats-over-image-bottom",
    !!bb &&
      Math.abs(bb.y + bb.height - (box.y + box.height - 8)) < 2 &&
      Math.abs(bb.x + bb.width / 2 - (box.x + box.width / 2)) < 2 &&
      bb.width <= box.width &&
      card0?.height === card1?.height,
    { bb, box, card0, card1 },
  );
  await shot(h, "102-gif-hover-bar");
  await pg.mouse.move(900, 700);
  const g0 = await barGone(h).catch(() => null);
  check("anim-bar-hides-on-leave", !!g0 && h.board().cards.length === 2, g0);

  // its buttons select the image (its Note the one card selected) and step / play it
  await pg.mouse.move(...center(box));
  await barShown(h);
  await btn(h, "Next Frame").click();
  await btn(h, "Next Frame").click();
  const n2 = await onFrame(h, 2, "Next Frame twice shows frame 3");
  await btn(h, "Previous Frame").click();
  const p1 = await onFrame(h, 1, "Previous Frame shows frame 2");
  check(
    "anim-bar-steps-and-selects",
    n2 && p1 && (await bar(h))?.fno === `2/${N}` && (await pg.locator(".card.sel").count()) === 1,
    await bar(h),
  );
  check("anim-bar-click-not-editing", (await pg.locator(".nbody[contenteditable]").count()) === 0);
  await btn(h, "Play").click();
  const plays = await until(h, "Play plays", async () => ((await gifShown(h)).frame > 2 ? true : null)).catch(
    () => false,
  );
  await btn(h, "Pause").click();
  const q1 = (await gifShown(h)).frame;
  await hold(h, GIF_MIN_DELAY * 3, "a paused GIF stays on its frame");
  const q2 = (await gifShown(h)).frame;
  check("anim-bar-plays-and-pauses", plays && q1 === q2 && q1 > 1, { plays, q1, q2 });

  // dragging the scrubber stands the image on the frame under the pointer, held even off the image
  const sc = (await pg.locator(".card .nbody .animbar .scrub").boundingBox())!;
  const cy = sc.y + sc.height / 2;
  await pg.mouse.move(sc.x + 1, cy);
  await pg.mouse.down();
  const s0 = await onFrame(h, 0, "pressing the scrubber's start shows frame 1");
  await pg.mouse.move(sc.x + (sc.width * 10) / (N - 1), cy, { steps: 4 });
  const s10 = await onFrame(h, 10, "dragging to 10/23 of the scrubber shows frame 11");
  const mid = await bar(h);
  await shot(h, "102-gif-scrub", "now");
  await pg.mouse.move(sc.x + sc.width + 40, box.y + box.height + 80, { steps: 3 });
  const sEnd = await onFrame(h, N - 1, "past the end, off the image, shows the last frame");
  const off = await bar(h);
  await pg.mouse.up();
  check(
    "anim-bar-scrub-drags-frame",
    s0 && s10 && sEnd && mid?.fno === `11/${N}` && !!mid.held && !!off?.shown && off.held,
    { s0, s10, sEnd, mid, off },
  );
  check(
    "anim-bar-scrub-not-dragging-card",
    h.board().place.n1.x === 80 && h.board().place.n1.y === 60,
    h.board().place.n1,
  );

  // the keys of the selected image: Home / End, ← →; the bar stays while it is selected, the pointer away
  await pg.keyboard.press("Home");
  const home = await onFrame(h, 0, "Home shows the first frame");
  await pg.keyboard.press("End");
  const end = await onFrame(h, N - 1, "End shows the last frame");
  await pg.keyboard.press("ArrowLeft");
  await pg.keyboard.press("ArrowLeft");
  const left = await onFrame(h, N - 3, "← ← steps back two frames");
  await pg.keyboard.press("ArrowRight");
  const right = await onFrame(h, N - 2, "→ steps on one");
  check("anim-keys-home-end-arrows", home && end && left && right, await gifShown(h));
  check("anim-arrows-do-not-nudge", h.board().place.n1.x === 80, h.board().place.n1);
  check("anim-bar-stays-while-selected", (await bar(h))?.shown === true, await bar(h));

  // zoomed out under 50% (four steps of ×0.8) the bar hides; back in it returns
  for (let i = 0; i < 4; i++) await pg.keyboard.press("ControlOrMeta+Minus");
  await idle(h);
  const small = await bar(h);
  for (let i = 0; i < 4; i++) await pg.keyboard.press("ControlOrMeta+Equal");
  await idle(h);
  const back = await bar(h);
  check("anim-bar-hides-zoomed-out", !!small?.gone && !!back?.shown, small, back);

  // deselect: the frame it stopped on is its snapshot, saved in the Markdown as one undo step
  await pg.mouse.click(900, 700);
  const saved = `![](assets/${GIF_FILE} "Fig 1: tiles"){frame=${N - 1}}`;
  const md = await until(h, "the frame is saved", () => (noteMd(h).includes(saved) ? noteMd(h) : null)).catch(() =>
    noteMd(h),
  );
  const gone = await barGone(h).catch(() => null);
  check("anim-deselect-saves-frame", md.includes(saved) && !!gone, md);
  const again = await onFrame(h, N - 2, "the redrawn GIF stands on the saved frame");
  check("anim-saved-frame-shown", again, await gifShown(h));
  await pg.keyboard.press("ControlOrMeta+z");
  const undone = await until(h, "undo takes the frame back", () => (noteMd(h) === MD ? true : null)).catch(() => false);
  const first = await onFrame(h, 0, "after undo the GIF stands on its first frame again");
  check("anim-deselect-one-undo-step", undone && first, noteMd(h));
});

test("animLoopAlwaysPlays", async () => {
  const h = await animHost(`![](assets/${GIF_FILE})`);
  await until(h, "the GIF is drawn", async () => ((await gifShown(h)).frame >= 0 ? true : null));
  const box = (await imgBox(h))!;
  await h.page.mouse.move(...center(box));
  await barShown(h);
  await btn(h, "Always Play").click();
  const md = await until(h, "loop is saved", () => (noteMd(h).includes("{loop=true}") ? noteMd(h) : null)).catch(() =>
    noteMd(h),
  );
  check("anim-loop-saved", md === `![](assets/${GIF_FILE}){loop=true}`, md);
  await h.page.mouse.click(900, 700);
  await barGone(h);
  const f0 = (await gifShown(h)).frame;
  const plays = await until(h, "an always-playing GIF moves on unselected", async () =>
    (await gifShown(h)).frame !== f0 ? true : null,
  ).catch(() => false);
  check("anim-loop-plays-unselected", plays, f0, await gifShown(h));
  await h.page.mouse.move(...center(box));
  const badge = await until(h, "the always-play badge shows on hover", () =>
    h.page.evaluate(() => {
      const b = document.querySelector(".md-anim")?.shadowRoot?.querySelector<HTMLElement>(".b");
      return b && getComputedStyle(b).opacity === "1" ? b.textContent : null;
    }),
  ).catch(() => null);
  const lb = await barShown(h).catch(() => null);
  check("anim-loop-badge-on-hover", badge === "Always playing" && lb?.loop === "true", badge, lb);
  await shot(h, "105-loop-badge", "now");

  // turning it off stands it on the frame it is on, saved with it
  await btn(h, "Always Play").click();
  const off = await until(h, "loop off is saved", () => (noteMd(h).includes("loop") ? null : noteMd(h))).catch(() =>
    noteMd(h),
  );
  check("anim-loop-off-saves-frame", /^!\[\]\(assets\/[^)]+\)(\{frame=\d+\})?$/.test(off), off);

  // reduced motion: an always-playing image does not start by itself
  await h.page.emulateMedia({ reducedMotion: "reduce" });
  await barShown(h);
  await btn(h, "Always Play").click();
  await until(h, "loop is saved again", () => (noteMd(h).includes("loop=true}") ? true : null));
  await h.page.mouse.click(900, 700);
  await barGone(h);
  const r0 = (await gifShown(h)).frame;
  await hold(h, GIF_MIN_DELAY * 4, "an always-playing GIF would move on, but not under reduced motion");
  const r1 = (await gifShown(h)).frame;
  check("anim-reduced-motion-no-autoplay", r0 >= 0 && r0 === r1, { r0, r1 });
});

test("animSvgInline", async () => {
  const h = await animHost(
    `Steps\n\n![](assets/${SVG_ANIM_FILE} "Fig 2: hops")\n\nStill: ![](assets/${SVG_STILL_FILE})`,
  );
  const inner = () =>
    h.page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".card .nbody .md-anim");
      const root = host?.shadowRoot?.querySelector<HTMLElement>(".v")?.shadowRoot;
      const svg = root?.querySelector("svg");
      if (!root || !svg) return null;
      const anims = root.getAnimations();
      const box = svg.querySelector<SVGRectElement>("rect.hop")!;
      const img = document.querySelector<HTMLImageElement>(".card .nbody img")!;
      const a = host!.getBoundingClientRect(),
        b = img.getBoundingClientRect();
      return {
        // standing still, its CSS animation is frozen into the box's style and cancelled (md/anim.ts freeze)
        frozen: anims.length === 0 && svg.animationsPaused(),
        smil: Math.round(svg.getCurrentTime() * 1000),
        x: Math.round(new DOMMatrix(getComputedStyle(box).transform).m41),
        fill: getComputedStyle(box).fill,
        ink: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim(),
        script: !!root.querySelector("script") || svg.hasAttribute("onload") || !!(window as any).__svgRan,
        outside: [...root.querySelectorAll("image, set")].map((e) => e.outerHTML),
        css: root.querySelector("svg style")?.textContent ?? "",
        over: Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1,
        radius: getComputedStyle(host!).borderRadius,
        clip: getComputedStyle(host!).overflow,
      };
    });
  const s = await until(h, "the SVG is drawn inline", inner).catch(() => null);
  check("anim-svg-inline", !!s && s.over, s);
  check(
    "anim-svg-cleaned",
    !!s && !s.script && s.outside.every((o) => !/https?:|href/.test(o)) && !/@import/.test(s.css),
    s,
  );
  // step 1 of 8 (0.5 s each), stood on 60% into it: 300 ms
  check("anim-svg-paused-on-step", !!s && s.frozen && s.smil === 300 && s.x === 0, s);
  check("anim-svg-clipped-to-corners", !!s && s.clip === "hidden" && s.radius !== "0px", s);
  const still = await h.page.evaluate(() => document.querySelectorAll(".card .nbody .md-anim").length);
  check("anim-svg-still-stays-img", still === 1, still);

  const box = (await imgBox(h))!;
  await h.page.mouse.move(...center(box));
  const st = await barShown(h).catch(() => null);
  check("anim-svg-bar-steps", st?.fno === "1/8", st);
  for (let i = 0; i < 3; i++) await btn(h, "Next Frame").click();
  const s4 = await until(h, "the SVG stands on step 4", async () => {
    const v = await inner();
    return v?.x === 120 ? v : null;
  }).catch(() => null);
  check("anim-svg-bar-seeks", !!s4 && s4.frozen && s4.smil === 1800 && (await bar(h))?.fno === "4/8", s4);
  await shot(h, "104-svg-bar-light");
  check("anim-svg-follows-theme-light", !!s4 && s4.fill === hexRgb(s4.ink), s4);
  await h.page.evaluate(() => document.body.classList.replace("vscode-light", "vscode-dark"));
  const dark = await until(h, "the theme turns dark", async () => {
    const v = await inner();
    return v && v.ink !== s4?.ink ? v : null;
  }).catch(() => null);
  check("anim-svg-follows-theme-dark", !!dark && dark.fill === hexRgb(dark.ink) && dark.fill !== s4?.fill, dark, s4);
  await shot(h, "104-svg-bar-dark");
});

test("animBarFollowsTheme", async () => {
  const { h } = await openAnim(board(`Tiles\n\n![](assets/${GIF_FILE} "Fig 1: tiles")\n\nAfter.`), {
    theme: "ink-wash",
  });
  await until(h, "the GIF is drawn", async () => ((await gifShown(h)).frame >= 0 ? true : null));
  /** The glass the theme asks for: its tooltip colour (light) or surface (dark), at the bar's opacity */
  const want = (dark: boolean) =>
    h.page.evaluate((dark) => {
      const probe = document.createElement("i");
      probe.style.color = `color-mix(in srgb, var(${dark ? "--surface" : "--tip-bg"}) ${dark ? 80 : 78}%, transparent)`;
      document.querySelector(".card .nbody")!.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }, dark);
  await h.page.mouse.move(...center((await imgBox(h))!));
  const lt = await barShown(h).catch(() => null);
  const wl = await want(false);
  await shot(h, "107-bar-ink-wash-light");
  await h.page.evaluate(() => document.body.classList.replace("vscode-light", "vscode-dark"));
  const dk = await until(h, "the bar's glass turns dark", async () => {
    const b = await bar(h);
    return b?.shown && b.bg !== lt?.bg ? b : null;
  }).catch(() => null);
  const wd = await want(true);
  await shot(h, "107-bar-ink-wash-dark");
  check("anim-bar-theme-glass", !!lt && lt.bg === wl && !!dk && dk.bg === wd && wl !== wd, { lt, wl, dk, wd });
});

/** A board with one image card (cards/Card.tsx), its playback as given */
function cardBoard(c: Partial<ImageCard> & { src: string }): Board {
  const b = emptyBoard("b1", "anim");
  b.cam = { x: 0, y: 0, z: 1 };
  put(b, { id: "i1", kind: "image", ...c } as ImageCard, 120, 80, W);
  return b;
}
const CARD = '.card[data-id="i1"] .imgb';
const imageCard = (h: Host) => h.board().cards.find((c) => c.id === "i1") as ImageCard;

test("animImageCardHoverBar", async () => {
  const { h, exported } = await openAnim(farNote(cardBoard({ src: GIF_FILE, frame: 6 })));
  const pg = h.page;
  const a = await until(h, "the card's GIF is drawn", async () => {
    const s = await gifShown(h, CARD);
    return s.frame >= 0 ? s : null;
  }).catch(() => null);
  await hold(h, GIF_MIN_DELAY * 4, "a playing GIF would have moved on by several frames");
  const b = await gifShown(h, CARD);
  check("anim-card-stands-on-stored-frame", !!a && a.hidden && a.over && a.frame === 5 && b.frame === 5, { a, b });

  // hovering the card shows the bar over the bottom of its image
  const box = (await pg.locator(CARD).boundingBox())!;
  await pg.mouse.move(...center(box));
  const b0 = await barShown(h, CARD).catch(() => null);
  const bb = await pg.locator(`${CARD} .animbar`).boundingBox();
  check(
    "anim-card-bar-over-image",
    b0?.fno === `6/${N}` &&
      !!bb &&
      Math.abs(bb.y + bb.height - (box.y + box.height - 8)) < 2 &&
      Math.abs(bb.x + bb.width / 2 - (box.x + box.width / 2)) < 2,
    { b0, bb, box },
  );
  await shot(h, "106-card-gif-hover-bar", "now");

  // selecting the card selects its image: scrub, Home / End, ← →, Space; ↑ ↓ still nudge the card
  await pg.mouse.click(...center(box));
  await until(h, "the card is selected", async () =>
    (await pg.locator('.card.sel[data-id="i1"]').count()) ? true : null,
  );
  const sc = (await pg.locator(`${CARD} .animbar .scrub`).boundingBox())!;
  const cy = sc.y + sc.height / 2;
  await pg.mouse.move(sc.x + (sc.width * 9) / (N - 1), cy);
  await pg.mouse.down();
  const s9 = await onFrame(h, 9, "pressing 9/23 into the scrubber shows frame 10", CARD);
  await pg.mouse.move(sc.x + (sc.width * 14) / (N - 1), cy, { steps: 3 });
  const s14 = await onFrame(h, 14, "dragging to 14/23 shows frame 15", CARD);
  await pg.mouse.up();
  check(
    "anim-card-scrub",
    s9 && s14 && h.board().place.i1.x === 120 && h.board().place.i1.y === 80,
    h.board().place.i1,
  );
  await pg.keyboard.press("End");
  const end = await onFrame(h, N - 1, "End shows the last frame", CARD);
  await pg.keyboard.press("Home");
  const home = await onFrame(h, 0, "Home shows the first frame", CARD);
  await pg.keyboard.press("ArrowRight");
  await pg.keyboard.press("ArrowRight");
  const r = await onFrame(h, 2, "→ → steps to frame 3", CARD);
  await pg.keyboard.press("ArrowLeft");
  const l = await onFrame(h, 1, "← steps back to frame 2", CARD);
  check("anim-card-keys", end && home && r && l && h.board().place.i1.x === 120, await gifShown(h, CARD));
  await pg.keyboard.press("ArrowDown");
  const down = await until(h, "↓ nudges the card", () =>
    h.board().place.i1.y > 80 ? h.board().place.i1.y : null,
  ).catch(() => null);
  await pg.keyboard.press("ArrowUp");
  const up = await until(h, "↑ nudges it back", () => (h.board().place.i1.y === 80 ? true : null)).catch(() => false);
  check("anim-card-up-down-nudge", !!down && up && (await gifShown(h, CARD)).frame === 1, { down, up });
  await pg.keyboard.press(" ");
  const moved = await until(h, "Space plays", async () => ((await gifShown(h, CARD)).frame > 1 ? true : null)).catch(
    () => false,
  );
  await pg.keyboard.press(" ");
  const p1 = (await gifShown(h, CARD)).frame;
  await hold(h, GIF_MIN_DELAY * 3, "a paused GIF stays on its frame");
  const p2 = (await gifShown(h, CARD)).frame;
  check("anim-card-space-plays-and-pauses", moved && p1 === p2, { moved, p1, p2 });

  for (let i = 0; i < 4; i++) await pg.keyboard.press("ControlOrMeta+Minus");
  await idle(h);
  const small = await bar(h, CARD);
  for (let i = 0; i < 4; i++) await pg.keyboard.press("ControlOrMeta+Equal");
  await idle(h);
  check("anim-card-bar-hides-zoomed-out", !!small?.gone && !!(await bar(h, CARD))?.shown, small);

  // deselecting stores the frame it stopped on on the card, one undo step
  await pg.mouse.click(900, 700);
  const f = await until(h, "the frame is saved", () => (imageCard(h).frame !== 6 ? imageCard(h).frame : null)).catch(
    () => imageCard(h).frame,
  );
  const gone = await barGone(h, CARD).catch(() => null);
  check("anim-card-deselect-saves-frame", f === p2 + 1 && !!gone, { f, p2 });
  await pg.keyboard.press("ControlOrMeta+z");
  const undone = await until(h, "undo gives the card its frame back", () =>
    imageCard(h).frame === 6 ? true : null,
  ).catch(() => false);
  check(
    "anim-card-deselect-one-undo-step",
    undone && (await onFrame(h, 5, "the GIF stands on frame 6 again", CARD)),
    imageCard(h),
  );

  // the loop button: always plays, unselected, with the badge on hover; stored as loop on the card
  await pg.mouse.move(...center(box));
  await barShown(h, CARD);
  await btn(h, "Always Play", CARD).click();
  const loop = await until(h, "loop is saved", () => imageCard(h).loop ?? null).catch(() => false);
  await pg.mouse.click(700, 450);
  await barGone(h, CARD);
  const f0 = (await gifShown(h, CARD)).frame;
  const plays = await until(h, "the always-playing card moves on unselected", async () =>
    (await gifShown(h, CARD)).frame !== f0 ? true : null,
  ).catch(() => false);
  check("anim-card-loop-plays-unselected", loop === true && plays, { loop, f0 });
  await pg.mouse.move(...center(box));
  const badge = await until(h, "the always-play badge shows on hover", () =>
    pg.evaluate((q) => {
      const b = document.querySelector(`${q} .md-anim`)?.shadowRoot?.querySelector<HTMLElement>(".b");
      return b && getComputedStyle(b).opacity === "1" ? b.textContent : null;
    }, CARD),
  ).catch(() => null);
  check("anim-card-loop-badge-on-hover", badge === "Always playing", badge);
  await shot(h, "106-card-loop-badge", "now");

  // an HTML snapshot taken while it plays has the plain picture, without the overlay or its bar
  await pg.locator('.bbar [aria-label="More"]').click();
  await pg.locator(".ctx:not(.closing) button", { hasText: "Export…" }).click();
  await pg.locator(".xdlg").waitFor();
  await pg.locator(".xdlg .seg button", { hasText: "HTML Snapshot" }).click();
  await pg.locator(".xdlg .seg button", { hasText: "Whole Board" }).click();
  await pg.locator(".xdlg button.def").click();
  // the whole file: read while the host is still writing it, it is cut short
  const html =
    (await until(
      h,
      "the snapshot is written",
      () => (exported()?.trimEnd().endsWith("</html>") ? exported() : null),
      20000,
    ).catch(() => exported() ?? "")) ?? "";
  const imgs = html.match(/<img\b[^>]*>/g) ?? [];
  check(
    "anim-card-export-plain-img",
    plays &&
      imgs.length === 1 &&
      /src="data:image\/gif;base64,/.test(imgs[0]) &&
      !/class="[^"]*md-anim/.test(html) &&
      !/class="[^"]*animbar/.test(html) &&
      !/md-animsrc/.test(imgs[0]),
    imgs.map((i) => i.replace(/base64,[^"]*/, "base64,…")),
  );
});

test("animImageCardSvg", async () => {
  const { h } = await openAnim(cardBoard({ src: SVG_ANIM_FILE }));
  const inner = () =>
    h.page.evaluate((q) => {
      const root = document.querySelector(`${q} .md-anim`)?.shadowRoot?.querySelector(".v")?.shadowRoot;
      const svg = root?.querySelector("svg");
      if (!root || !svg) return null;
      const anims = root.getAnimations();
      const r = svg.querySelector<SVGRectElement>("rect.hop")!;
      return {
        paused: anims.length === 0 && svg.animationsPaused(),
        x: Math.round(new DOMMatrix(getComputedStyle(r).transform).m41),
        script: !!root.querySelector("script") || svg.hasAttribute("onload") || !!(window as any).__svgRan,
      };
    }, CARD);
  const s = await until(h, "the card's SVG is drawn inline", inner).catch(() => null);
  check("anim-card-svg-inline-paused", !!s && s.paused && s.x === 0 && !s.script, s);
  // Standing still, nothing inside the SVG is a compositor layer: a paused CSS animation of a transform kept its box one,
  // rastered at the scale it was first drawn at whatever the zoom (2.9-4.9x the scale shown on a real board)
  const inside = await svgLayers(h);
  check("anim-card-svg-still-no-layers", inside.length === 0, inside);
  const box = (await h.page.locator(CARD).boundingBox())!;
  await h.page.mouse.click(...center(box));
  const st = await barShown(h, CARD).catch(() => null);
  check("anim-card-svg-bar-steps", st?.fno === "1/8", st);
  for (let i = 0; i < 3; i++) await btn(h, "Next Frame", CARD).click();
  const s4 = await until(h, "the SVG stands on step 4", async () => {
    const v = await inner();
    return v?.x === 120 ? v : null;
  }).catch(() => null);
  await shot(h, "106-card-svg-bar");
  // Space plays it (its animation running again from the step it stood on) and pauses it: frozen again where it stopped
  await h.page.keyboard.press(" ");
  const ran = await until(h, "Space plays the SVG", async () => {
    const v = await inner();
    return v && v.x !== 120 ? v : null;
  }).catch(() => null);
  await h.page.keyboard.press(" ");
  const p1 = await until(h, "Space pauses the SVG", inner).catch(() => null);
  await hold(h, SVG_STEP_MS, "a paused SVG stays on its step: playing, it would have moved on by one");
  const p2 = await inner();
  check(
    "anim-card-svg-plays-and-freezes",
    !!ran && !ran.paused && !!p1?.paused && !!p2 && p2.x === p1.x && (await svgLayers(h)).length === 0,
    { ran, p1, p2 },
  );
  await h.page.mouse.click(900, 700);
  const f = await until(h, "the step is saved", () => imageCard(h).frame ?? null).catch(() => null);
  check("anim-card-svg-step-saved", !!s4 && !!f && f === Math.round(p2!.x / 40) + 1, { s4, f, p2 });
});

/** The compositor layers drawn from inside the animated SVG (its hopping box), from the layer tree of the frames drawn next */
async function svgLayers(h: Host) {
  const cdp = await h.page.context().newCDPSession(h.page);
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", (e) => events.push(...(e.value as TraceEvent[])));
  await cdp.send("Tracing.start", {
    categories: "disabled-by-default-devtools.timeline.layers",
    transferMode: "ReportEvents",
  } as never);
  await idle(h);
  const ended = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  await ended;
  await cdp.detach();
  const last = snapshotsOf(events).at(-1)?.s;
  return last
    ? layerScales(last)
        .filter((l) => /class='ink hop'/.test(l.name))
        .map((l) => `${l.name} raster ${l.raster}`)
    : ["no snapshot"];
}

function hexRgb(c: string) {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}
