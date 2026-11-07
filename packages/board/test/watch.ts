// watch(): the motion probes around one action of a scenario (probes.ts judges what it records). The page's clock (Playwright's)
// is paused and the document timeline frozen (CDP Animation.setPlaybackRate 0), so nothing moves by itself; each frame then moves
// the clock and every Web Animation and CSS transition on by one frame's time, and is read and screenshot. The frames are the same
// on every machine however busy it is: what the probes count (cells that flash, boxes that move or jump, text shown twice, an
// element gone for a frame) does not depend on how fast the frames came.
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import { check, pauseClock, until, type Host } from "./fixtures";
import { OUT } from "./harness";
import {
  flashHits,
  gridOf,
  handoffHits,
  jumpHits,
  pageSample,
  twiceHits,
  vanishHits,
  type Box,
  type Grid,
  type Role,
  type Sample,
} from "./probes";

/** One frame's time: Playwright's clock runs requestAnimationFrame callbacks every 16 ms */
const FRAME_MS = 16;
/** A box that moved is masked for the flash rule with this much around it (CSS px): an arrow's head, a shadow */
const MOVE_MARGIN = 8;

export type WatchOptions = {
  /** how many frames to record after the action (the frame before it is frame 0, the first one painted after it frame 1) */
  frames?: number;
  /** what may move: followed keys (card:<id>, sect:<id>, link:<id>, chrome:<selector>#<i>) or patterns of them; "all" for a
   *  camera move. They may move, smoothly (no jump); anything else must stay where it was before the action */
  moves?: "all" | (string | RegExp)[];
  /** what the pointer moves (a dragged card and its arrows): it may move in steps as large as the pointer's */
  free?: (string | RegExp)[];
  /** selectors that must be shown in every frame they were shown in before the action */
  keep?: string[];
  /** selectors that animate by design (a selection ring fading, a menu opening, a crossfade): not judged for flashes, their text
   *  not read for the same words shown twice */
  ignore?: string[];
  /** more elements in the world to follow (a card's lines: `.card[data-id="k1"] .src > .l`), keyed el:<selector>#<i> */
  follow?: string[];
  /** chrome followed in CSS px (the breadcrumb, the toolbars); the board's cards, Sections and arrows always are */
  chrome?: string[];
  /** which probes judge: flashes (pixels), jumps (boxes), vanish (keep), twice (text); all by default */
  judge?: Partial<Record<"flash" | "jump" | "vanish" | "twice", boolean>>;
  /** the page area screenshot (CSS px), the whole viewport by default */
  clip?: Box;
};

export type Recording = {
  samples: Sample[];
  grids: Grid[];
  hits: {
    flash: ReturnType<typeof flashHits>;
    jump: ReturnType<typeof jumpHits>;
    handoff: ReturnType<typeof handoffHits>;
    vanish: ReturnType<typeof vanishHits>;
    twice: ReturnType<typeof twiceHits>;
  };
};

const matches = (l: readonly (string | RegExp)[] | undefined, key: string) =>
  (l ?? []).some((m) => (typeof m === "string" ? m === key : m.test(key)));
const roleOf =
  (o: WatchOptions) =>
  (key: string): Role =>
    matches(o.free, key) ? "free" : o.moves === "all" || matches(o.moves || [], key) ? "moves" : "still";

/** Screen boxes (CSS px) of what moved between two samples, for the flash rule: a box that moved covers both its places; one
 *  that only grew or shrank covers the band it gained or lost */
function moveMasks(a: Sample, b: Sample, clip: Box): Box[] {
  // the camera moved: everything in the world moved, words sliding over cells look like flashes. Not judged for flashes (the
  // jump probe judges the world's boxes in world units then)
  if (a.z !== b.z || a.o[0] !== b.o[0] || a.o[1] !== b.o[1]) return [{ x: 0, y: 0, w: clip.w, h: clip.h }];
  const out: Box[] = [];
  const scr = (s: Sample, key: string, r: number[]): Box =>
    key.startsWith("chrome:")
      ? { x: r[0] - clip.x, y: r[1] - clip.y, w: r[2], h: r[3] }
      : { x: s.o[0] + r[0] * s.z - clip.x, y: s.o[1] + r[1] * s.z - clip.y, w: r[2] * s.z, h: r[3] * s.z };
  for (const key of Object.keys(b.rects)) {
    const ra = a.rects[key],
      rb = b.rects[key];
    if (!ra) {
      out.push(scr(b, key, rb));
      continue;
    }
    const p = scr(a, key, ra),
      q = scr(b, key, rb);
    if (Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5) {
      if (Math.abs(p.w - q.w) >= 0.5)
        out.push({ x: Math.min(p.x + p.w, q.x + q.w), y: p.y, w: Math.abs(p.w - q.w), h: Math.max(p.h, q.h) });
      if (Math.abs(p.h - q.h) >= 0.5)
        out.push({ x: p.x, y: Math.min(p.y + p.h, q.y + q.h), w: Math.max(p.w, q.w), h: Math.abs(p.h - q.h) });
      continue;
    }
    const x = Math.min(p.x, q.x),
      y = Math.min(p.y, q.y);
    out.push({ x, y, w: Math.max(p.x + p.w, q.x + q.w) - x, h: Math.max(p.y + p.h, q.y + q.h) - y });
  }
  for (const key of Object.keys(a.rects)) if (!b.rects[key]) out.push(scr(a, key, a.rects[key]));
  return out.map((m) => ({
    x: m.x - MOVE_MARGIN,
    y: m.y - MOVE_MARGIN,
    w: m.w + 2 * MOVE_MARGIN,
    h: m.h + 2 * MOVE_MARGIN,
  }));
}

/**
 * Runs `act` (a click, a key, a drag's moves: whatever it does happens with time stopped) and records `frames` frames after it,
 * then judges them as `name`: a failed check per kind of hit ("<name> flash", "<name> moved card", "<name> jumped link",
 * "<name> handoff", "<name> vanish .crumbs", "<name> twice"), one passing check if none. On a failure the frames are
 * written to test-out/harness/watch-<name>/. The clock is left running again and the timeline at its own speed; the board then
 * finishes whatever is left of its motions on its own (idle() waits for it)
 */
export async function watch(h: Host, name: string, o: WatchOptions, act: () => Promise<unknown>): Promise<Recording> {
  const page = h.page;
  const vp = page.viewportSize()!;
  const clip = o.clip ?? { x: 0, y: 0, w: vp.width, h: vp.height };
  const judge = { flash: true, jump: true, vanish: true, twice: true, ...o.judge };
  const opts = {
    keep: o.keep ?? [],
    ignore: o.ignore ?? [],
    chrome: o.chrome ?? [".crumbs", ".over"],
    follow: o.follow ?? [],
    texts: judge.twice,
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  const dpr = await page.evaluate(() => devicePixelRatio || 1);
  // the caret blinks on the browser's own timer: hidden while watched, as page.screenshot hides it
  const caret = await page.addStyleTag({ content: "*, *::before, *::after { caret-color: transparent !important; }" });
  await page.clock.install();
  await pauseClock(page);
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
  const samples: Sample[] = [],
    grids: Grid[] = [],
    pngs: Buffer[] = [];
  // the host's answers land in the frame they were asked in: the messages the board sent are answered (window.__inflight,
  // harness.ts) and the answers handled before the frame is read, so a request does not land a frame early or late by luck
  const answered = () =>
    until(h, "the board's messages to the host answered", () =>
      page.evaluate(async () => {
        await new Promise((r) => {
          const c = new MessageChannel();
          c.port1.onmessage = r;
          c.port2.postMessage(0);
        });
        return (window as unknown as { __inflight: number }).__inflight === 0;
      }),
    );
  const frame = async () => {
    // CDP's own capture, its PNG made for speed (a frame costs ~5x less than page.screenshot's), at 1 px per CSS px
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      optimizeForSpeed: true,
      clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 / dpr },
    });
    const png = Buffer.from(data, "base64");

    samples.push(await page.evaluate(pageSample, opts));

    if (judge.flash) {
      const img = PNG.sync.read(png);
      grids.push(gridOf(img.data, img.width, img.height));
      pngs.push(png);
    }
  };
  try {
    await frame();
    await act();
    for (let i = 0; i < (o.frames ?? 20); i++) {
      // a frame as the browser makes one: the tasks before it (the host's answers), then every animation one frame on (the
      // ones that reach their end finished, their events and promises as in a real frame) and the requestAnimationFrame
      // callbacks, then the paint. So the frame right after the action already has what the board does in its first rAF
      await answered();
      await page.evaluate((dt) => {
        for (const a of document.getAnimations()) {
          if (a.playState !== "running" || a.currentTime === null) continue;
          a.currentTime = +a.currentTime + dt * a.playbackRate;
        }
      }, FRAME_MS);
      await page.clock.runFor(FRAME_MS);
      await frame();
    }
  } finally {
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 }).catch(() => {});
    await caret.evaluate((e) => e.remove()).catch(() => {});
    await cdp.detach().catch(() => {});
    await page.clock.resume().catch(() => {});
  }
  const masks = samples.map((s, f) => [
    ...s.masks.map((m) => ({ ...m, x: m.x - clip.x, y: m.y - clip.y })),
    ...(f ? moveMasks(samples[f - 1], s, clip) : []),
  ]);
  const hits = {
    flash: judge.flash ? flashHits(grids, masks) : [],
    jump: judge.jump ? jumpHits(samples, roleOf(o)) : [],
    handoff: judge.jump && judge.twice ? handoffHits(samples) : [],
    vanish: judge.vanish ? vanishHits(samples) : [],
    twice: judge.twice ? twiceHits(samples) : [],
  };
  const failed = Object.values(hits).some((l) => l.length);
  if (failed && pngs.length) {
    const dir = path.join(OUT, `watch-${name}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    pngs.forEach((p, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(2, "0")}.png`), p));
  }
  // one check per kind of hit, named by what and where (the frames are the same on every run, the ids of what an action makes
  // are not: a key is named by its kind, card or link…), so tiers.json `known` can name one
  const fails = new Map<string, { why: string; hits: unknown[] }>();
  const fail = (k: string, why: string, x: unknown) => {
    const f = fails.get(k) ?? { why, hits: [] };
    f.hits.push(x);
    fails.set(k, f);
  };
  for (const x of hits.flash) fail(`${name} flash`, "shown, gone and back within a few frames", x);
  for (const x of hits.jump)
    fail(`${name} ${x.kind} ${x.key.split(":")[0]}`, x.kind === "moved" ? "moved and should stay" : "jumped", x);
  for (const x of hits.handoff) fail(`${name} handoff`, "words taken over by a copy at another size", x);
  for (const x of hits.vanish) fail(`${name} vanish ${x.sel}`, "gone for a frame", x);
  for (const x of hits.twice) fail(`${name} twice`, "the same words shown twice over each other", x);
  for (const [k, f] of fails) check(k, false, `${f.why}: ${f.hits.length}`, f.hits.slice(0, 5));
  if (!failed) check(`${name} no flash, jump or doubled words`, true, `${samples.length - 1} frames`);
  return { samples, grids, hits };
}
