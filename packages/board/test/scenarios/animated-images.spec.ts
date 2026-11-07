// Animated images in a Note (GIFs, SVGs animated by their own CSS / SMIL), on the real host with the pictures in its assets/:
//   animGifSnapshot           a GIF stands still on its first frame (its snapshot), drawn over the hidden <img>, and keeps still
//   animGifFilmstrip          clicking the GIF selects it: a filmstrip of its frames floats under it (over the caption, the card's
//                             size unchanged); a still jumps there, Space plays and pauses, ← → step; deselecting saves the frame
//                             it stopped on as {frame=N}, which the next view starts on; zoomed out under 50% the strip hides
//   animLoopAlwaysPlays       the strip's loop button saves {loop=true}: the GIF plays after deselecting, with an "Always playing"
//                             badge on hover; turning it off saves the frame it stopped on; reduced motion never starts it
//   animSvgInline             an SVG animated by CSS keyframes and SMIL is drawn inline (shadow root), cleaned (no script,
//                             handlers or outside references), paused on its step (data-steps), stepped by its filmstrip, and its
//                             colours follow the board's light / dark theme; a still SVG stays an <img>
//   animImageCardFilmstrip    an image card's GIF stands on the card's stored frame; selecting the card opens the same filmstrip
//                             under the image (thumbs, ← →, Space, hidden zoomed out); deselecting stores the frame on the card;
//                             the loop button stores loop and the GIF plays unselected with the badge; an HTML snapshot taken
//                             while it plays has the plain <img>
//   animImageCardSvg          an image card's animated SVG is drawn inline and paused, stepped by its filmstrip, the step stored;
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
async function openAnim(b: Board, o: { light?: boolean } = {}) {
  const run = await hostBoards([b], {
    page: { light: o.light ?? true, w: 1100, h: 760, settings: { theme: "warm-ink" } },
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
const strip = (h: Host) =>
  h.page.evaluate(() => {
    const s = document.querySelector<HTMLElement>(".animstrip");
    if (!s) return null;
    return {
      thumbs: s.querySelectorAll(".thumbs > *").length,
      on: [...s.querySelectorAll(".thumbs > *")].findIndex((t) => t.classList.contains("on")),
      fno: s.querySelector(".fno")?.textContent ?? "",
      loop: s.querySelector(".loop")?.getAttribute("aria-pressed"),
    };
  });
const imgBox = (h: Host) => h.page.locator(".card .nbody img").first().boundingBox();

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
  await shot(h, "105-gif-snapshot");
});

/** A far Note makes the board big enough to zoom out below 50%: on a small board the zoom floor is 50% (core summaryMinZoom),
 *  where the filmstrip still shows */
const farNote = (b: Board) => {
  put(b, { id: "far", kind: "note", md: "Far away", look: "note" } as NoteCard, 3000, 2000, 200);
  return b;
};

test("animGifFilmstrip", async () => {
  const { h } = await openAnim(farNote(board(`Tiles\n\n![](assets/${GIF_FILE} "Fig 1: tiles")\n\nAfter.`)));
  await until(h, "the GIF is drawn", async () => ((await gifShown(h)).frame >= 0 ? true : null));
  const card0 = await h.page.locator('.card[data-id="n1"]').boundingBox();
  const box = (await imgBox(h))!;
  await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const s0 = await until(h, "the filmstrip opens", () => strip(h)).catch(() => null);
  const sb = await h.page.locator(".animstrip").boundingBox();
  const card1 = await h.page.locator('.card[data-id="n1"]').boundingBox();
  check("anim-strip-shows-frames", s0?.thumbs === N && s0.fno === `1/${N}` && s0.on === 0, s0);
  check(
    "anim-strip-floats-under-image",
    !!sb && Math.abs(sb.y - (box.y + box.height) - 8) < 2 && card0?.height === card1?.height,
    { sb, box, card0, card1 },
  );
  check("anim-click-image-not-editing", (await h.page.locator(".nbody[contenteditable]").count()) === 0);
  await shot(h, "102-gif-filmstrip");

  await h.page.locator(".animstrip .thumbs > *").nth(9).click();
  const at10 = await until(h, "the GIF shows frame 10", async () => {
    const g = await gifShown(h);
    return g.frame === 9 ? g : null;
  }).catch(() => null);
  check("anim-thumb-jumps-to-frame", !!at10 && (await strip(h))?.fno === `10/${N}`, at10, await strip(h));
  await h.page.keyboard.press("ArrowRight");
  const r = await until(h, "→ steps to frame 11", async () => ((await gifShown(h)).frame === 10 ? true : null)).catch(
    () => false,
  );
  await h.page.keyboard.press("ArrowLeft");
  await h.page.keyboard.press("ArrowLeft");
  const l = await until(h, "← ← steps to frame 9", async () => ((await gifShown(h)).frame === 8 ? true : null)).catch(
    () => false,
  );
  check("anim-arrows-step", r && l, await gifShown(h));
  check("anim-arrows-do-not-nudge", h.board().place.n1.x === 80, h.board().place.n1);

  await h.page.keyboard.press(" ");
  const moved = await until(h, "Space plays", async () => ((await gifShown(h)).frame > 9 ? true : null)).catch(
    () => false,
  );
  await h.page.keyboard.press(" ");
  const p1 = (await gifShown(h)).frame;
  await hold(h, GIF_MIN_DELAY * 3, "a paused GIF stays on its frame");
  const p2 = (await gifShown(h)).frame;
  check("anim-space-plays-and-pauses", moved && p1 === p2 && p1 > 8, { moved, p1, p2 });

  // zoomed out under 50% (four steps of ×0.8) the strip hides; back in it returns
  for (let i = 0; i < 4; i++) await h.page.keyboard.press("ControlOrMeta+Minus");
  await idle(h);
  const small = await strip(h);
  for (let i = 0; i < 4; i++) await h.page.keyboard.press("ControlOrMeta+Equal");
  await idle(h);
  const back = await strip(h);
  check("anim-strip-hides-zoomed-out", small === null && back !== null, small, back);

  // deselect: the frame it stopped on is its snapshot, saved in the Markdown
  await h.page.mouse.click(900, 700);
  const md = await until(h, "the frame is saved", () => (/\{frame=\d+\}/.test(noteMd(h)) ? noteMd(h) : null)).catch(
    () => noteMd(h),
  );
  check(
    "anim-deselect-saves-frame",
    md.includes(`![](assets/${GIF_FILE} "Fig 1: tiles"){frame=${p2 + 1}}`) && (await strip(h)) === null,
    md,
  );
  const again = await until(h, "the redrawn GIF stands on the saved frame", async () => {
    const g = await gifShown(h);
    return g.frame === p2 ? g : null;
  }).catch(() => null);
  check("anim-saved-frame-shown", !!again, await gifShown(h));
});

test("animLoopAlwaysPlays", async () => {
  const h = await animHost(`![](assets/${GIF_FILE})`);
  await until(h, "the GIF is drawn", async () => ((await gifShown(h)).frame >= 0 ? true : null));
  const box = (await imgBox(h))!;
  await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until(h, "the filmstrip opens", () => strip(h));
  await h.page.locator(".animstrip .loop").click();
  const md = await until(h, "loop is saved", () => (noteMd(h).includes("{loop=true}") ? noteMd(h) : null)).catch(() =>
    noteMd(h),
  );
  check("anim-loop-saved", md === `![](assets/${GIF_FILE}){loop=true}`, md);
  await h.page.mouse.click(900, 700);
  await until(h, "the strip closes", async () => ((await strip(h)) === null ? true : null));
  const f0 = (await gifShown(h)).frame;
  const plays = await until(h, "an always-playing GIF moves on unselected", async () =>
    (await gifShown(h)).frame !== f0 ? true : null,
  ).catch(() => false);
  check("anim-loop-plays-unselected", plays, f0, await gifShown(h));
  await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const badge = await until(h, "the always-play badge shows on hover", () =>
    h.page.evaluate(() => {
      const b = document.querySelector(".md-anim")?.shadowRoot?.querySelector<HTMLElement>(".b");
      return b && getComputedStyle(b).opacity === "1" ? b.textContent : null;
    }),
  ).catch(() => null);
  check("anim-loop-badge-on-hover", badge === "Always playing", badge);
  await shot(h, "105-loop-badge", "now");

  // turning it off stands it on the frame it is on, saved with it
  await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until(h, "the filmstrip opens", () => strip(h));
  await h.page.locator(".animstrip .loop").click();
  const off = await until(h, "loop off is saved", () => (noteMd(h).includes("loop") ? null : noteMd(h))).catch(() =>
    noteMd(h),
  );
  check("anim-loop-off-saves-frame", /^!\[\]\(assets\/[^)]+\)(\{frame=\d+\})?$/.test(off), off);

  // reduced motion: an always-playing image does not start by itself
  await h.page.emulateMedia({ reducedMotion: "reduce" });
  await until(h, "the filmstrip is back", () => strip(h));
  await h.page.locator(".animstrip .loop").click();
  await until(h, "loop is saved again", () => (noteMd(h).includes("loop=true}") ? true : null));
  await h.page.mouse.click(900, 700);
  await until(h, "the strip closes", async () => ((await strip(h)) === null ? true : null));
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
  await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const st = await until(h, "the filmstrip opens", () => strip(h)).catch(() => null);
  check("anim-svg-strip-steps", st?.thumbs === 8 && st.fno === "1/8", st);
  const thumb = await h.page.evaluate(() => {
    const t = document.querySelectorAll<HTMLElement>(".animstrip .thumbs > *")[3];
    const r = t?.shadowRoot?.querySelector<SVGRectElement>("rect.hop");
    return r ? Math.round(new DOMMatrix(getComputedStyle(r).transform).m41) : null;
  });
  check("anim-svg-thumb-frozen-on-its-step", thumb === 120, thumb);
  await h.page.locator(".animstrip .thumbs > *").nth(3).click();
  const s4 = await until(h, "the SVG stands on step 4", async () => {
    const v = await inner();
    return v?.x === 120 ? v : null;
  }).catch(() => null);
  check("anim-svg-thumb-seeks", !!s4 && s4.frozen && s4.smil === 1800 && (await strip(h))?.fno === "4/8", s4);
  await shot(h, "104-svg-filmstrip-light");
  check("anim-svg-follows-theme-light", !!s4 && s4.fill === hexRgb(s4.ink), s4);
  await h.page.evaluate(() => document.body.classList.replace("vscode-light", "vscode-dark"));
  const dark = await until(h, "the theme turns dark", async () => {
    const v = await inner();
    return v && v.ink !== s4?.ink ? v : null;
  }).catch(() => null);
  check("anim-svg-follows-theme-dark", !!dark && dark.fill === hexRgb(dark.ink) && dark.fill !== s4?.fill, dark, s4);
  await shot(h, "104-svg-filmstrip-dark");
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

test("animImageCardFilmstrip", async () => {
  const { h, exported } = await openAnim(farNote(cardBoard({ src: GIF_FILE, frame: 6 })));
  const pg = h.page;
  const a = await until(h, "the card's GIF is drawn", async () => {
    const s = await gifShown(h, CARD);
    return s.frame >= 0 ? s : null;
  }).catch(() => null);
  await hold(h, GIF_MIN_DELAY * 4, "a playing GIF would have moved on by several frames");
  const b = await gifShown(h, CARD);
  check("anim-card-stands-on-stored-frame", !!a && a.hidden && a.over && a.frame === 5 && b.frame === 5, { a, b });

  // selecting the card opens the filmstrip under its image
  const box = (await pg.locator(CARD).boundingBox())!;
  await pg.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const s0 = await until(h, "the filmstrip opens", () => strip(h)).catch(() => null);
  const sb = await pg.locator(".animstrip").boundingBox();
  check("anim-card-strip-shows-frames", s0?.thumbs === N && s0.fno === `6/${N}` && s0.on === 5, s0);
  check(
    "anim-card-strip-under-image",
    !!sb &&
      Math.abs(sb.y - (box.y + box.height) - 8) < 2 &&
      Math.abs(sb.x + sb.width / 2 - (box.x + box.width / 2)) < 2,
    { sb, box },
  );
  await shot(h, "106-card-gif-filmstrip");

  await pg.locator(".animstrip .thumbs > *").nth(9).click();
  const at10 = await until(h, "the GIF shows frame 10", async () =>
    (await gifShown(h, CARD)).frame === 9 ? true : null,
  ).catch(() => false);
  await pg.keyboard.press("ArrowRight");
  const r = await until(h, "→ steps to frame 11", async () =>
    (await gifShown(h, CARD)).frame === 10 ? true : null,
  ).catch(() => false);
  check("anim-card-thumb-and-arrows", at10 && r && h.board().place.i1.x === 120, await gifShown(h, CARD));
  await pg.keyboard.press(" ");
  const moved = await until(h, "Space plays", async () => ((await gifShown(h, CARD)).frame > 10 ? true : null)).catch(
    () => false,
  );
  await pg.keyboard.press(" ");
  const p1 = (await gifShown(h, CARD)).frame;
  await hold(h, GIF_MIN_DELAY * 3, "a paused GIF stays on its frame");
  const p2 = (await gifShown(h, CARD)).frame;
  check("anim-card-space-plays-and-pauses", moved && p1 === p2, { moved, p1, p2 });

  for (let i = 0; i < 4; i++) await pg.keyboard.press("ControlOrMeta+Minus");
  await idle(h);
  const small = await strip(h);
  for (let i = 0; i < 4; i++) await pg.keyboard.press("ControlOrMeta+Equal");
  await idle(h);
  check("anim-card-strip-hides-zoomed-out", small === null && (await strip(h)) !== null, small);

  // deselecting stores the frame it stopped on on the card
  await pg.mouse.click(900, 700);
  const f = await until(h, "the frame is saved", () => (imageCard(h).frame !== 6 ? imageCard(h).frame : null)).catch(
    () => imageCard(h).frame,
  );
  check("anim-card-deselect-saves-frame", f === p2 + 1 && (await strip(h)) === null, { f, p2 });

  // the loop button: always plays, unselected, with the badge on hover; stored as loop on the card
  await pg.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until(h, "the filmstrip opens", () => strip(h));
  await pg.locator(".animstrip .loop").click();
  const loop = await until(h, "loop is saved", () => imageCard(h).loop ?? null).catch(() => false);
  await pg.mouse.click(700, 450);
  await until(h, "the strip closes", async () => ((await strip(h)) === null ? true : null));
  const f0 = (await gifShown(h, CARD)).frame;
  const plays = await until(h, "the always-playing card moves on unselected", async () =>
    (await gifShown(h, CARD)).frame !== f0 ? true : null,
  ).catch(() => false);
  check("anim-card-loop-plays-unselected", loop === true && plays, { loop, f0 });
  await pg.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const badge = await until(h, "the always-play badge shows on hover", () =>
    pg.evaluate((q) => {
      const b = document.querySelector(`${q} .md-anim`)?.shadowRoot?.querySelector<HTMLElement>(".b");
      return b && getComputedStyle(b).opacity === "1" ? b.textContent : null;
    }, CARD),
  ).catch(() => null);
  check("anim-card-loop-badge-on-hover", badge === "Always playing", badge);
  await shot(h, "106-card-loop-badge", "now");

  // an HTML snapshot taken while it plays has the plain picture, without the overlay
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
      !/md-animsrc/.test(imgs[0]),
    imgs.map((i) => i.slice(0, 120)),
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
  await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const st = await until(h, "the filmstrip opens", () => strip(h)).catch(() => null);
  check("anim-card-svg-strip-steps", st?.thumbs === 8 && st.fno === "1/8", st);
  await h.page.locator(".animstrip .thumbs > *").nth(3).click();
  const s4 = await until(h, "the SVG stands on step 4", async () => {
    const v = await inner();
    return v?.x === 120 ? v : null;
  }).catch(() => null);
  await shot(h, "106-card-svg-filmstrip");
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
