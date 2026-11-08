// The board as a still picture (BoardOptions.still; state/still.ts): what a renderer that photographs it (the phone viewer's
// tiles) asks of it. It moves the camera and is told once everything in view is drawn, and it reads what the board covers
// and where its sub-board cards are from the board's own model, not from the page's elements
import { SUMMARY, bounds, type Rect } from "@codeboard/core";
import { state, rectOf } from "./state/store";
import { cam, setCam, view, zoomFloor } from "./state/camera";
import { frames, visibleCards } from "./state/sections";
import { offscreen } from "./state/offscreen";
import { farAway } from "./state/cull";
import { summaryLayout, summarySettled } from "./state/summary";
import { mdPendingInView } from "./md/lazy";
import { boardExtent } from "./actions/common";

export type StillCam = { x: number; y: number; z: number };
export type StillLayout = {
  id: string;
  name: string;
  /** What the board covers at any zoom, in world px: its cards, its Sections with their title strips, what is drawn around the
   *  cards, and its summary columns as last measured (view minZoom first to have them measured) */
  world: Rect;
  /** Its sub-board cards: where each is, in world px, and the board it opens */
  subs: { rect: Rect; board: string }[];
  /** The smallest zoom someone zooming out reaches in this viewport (the summary level shows there); a still picture can be
   *  drawn further out */
  minZoom: number;
  /** The board's paper colour, #rrggbb */
  bg: string;
};
export type StillBoard = {
  /** Sets the camera (at most the board's largest zoom; once the board is loaded) and resolves with it once everything in view
   *  is drawn: the fonts, the summary level switched and measured, the Notes' Markdown, the cards' content and the images.
   *  Rejects with what is still missing after `limit` ms */
  view(c: StillCam, limit?: number): Promise<StillCam>;
  /** The board shown, or null before one is */
  layout(): StillLayout | null;
};

const inView = (r: Rect) => {
  const v = view();
  const l = r.x * cam.z + cam.x,
    t = r.y * cam.z + cam.y;
  return l + r.w * cam.z > 0 && l < v.w && t + r.h * cam.z > 0 && t < v.h;
};

/** Why the view is not drawn yet, or "" when it is */
function missing(): string {
  if (!state.loaded) return "the board";
  if (document.fonts.status !== "loaded") return "fonts";
  if (!summarySettled()) return "the summary level";
  if (mdPendingInView()) return "Markdown";
  for (const c of visibleCards()) if ((offscreen(c.id) || farAway(c.id)) && inView(rectOf(c))) return `card ${c.id}`;
  const box = document.getElementById("board")?.getBoundingClientRect();
  if (box)
    for (const img of document.querySelectorAll<HTMLImageElement>("#board .world img")) {
      if (img.complete || img.closest(".gone")) continue;
      const r = img.getBoundingClientRect();
      if (r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom)
        return `image ${img.src}`;
    }
  return "";
}

/** Sets the camera once the board is loaded (an init sets its own) and resolves on the second frame in a row with nothing
 *  missing (what one frame measured is laid out by the next) */
function show(c: StillCam, limit: number): Promise<void> {
  return new Promise((done, fail) => {
    const t0 = performance.now();
    let set = false,
      calm = 0;
    const step = () => {
      if (state.loaded && !set) {
        setCam(c.x, c.y, c.z);
        set = true;
        calm = 0;
      }
      const why = set ? missing() : "the board";
      calm = why ? 0 : calm + 1;
      if (calm >= 2) return done();
      if (performance.now() - t0 > limit) return fail(new Error(`not drawn after ${limit} ms: ${why}`));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

const hex = (css: string) => {
  const [r, g, b] = (css.match(/\d+(\.\d+)?/g) ?? ["255", "255", "255"]).map(Number);
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
};

export const stillBoard: StillBoard = {
  async view(c, limit = 20_000) {
    await show(c, limit);
    return { x: cam.x, y: cam.y, z: cam.z };
  },
  layout() {
    if (!state.loaded) return null;
    const strips = [...frames().values()].map((f) => ({
      x: f.x,
      y: f.y - SUMMARY.strip,
      w: f.w,
      h: f.h + SUMMARY.strip,
    }));
    const world = bounds([
      ...[boardExtent()].filter((r): r is Rect => !!r),
      ...strips,
      ...(summaryLayout()?.cols ?? []),
    ]) ?? { x: 0, y: 0, w: 0, h: 0 };
    const subs = visibleCards().flatMap((c) => (c.kind === "board" ? [{ rect: rectOf(c), board: c.board }] : []));
    const el = document.getElementById("board");
    return {
      id: state.board.id,
      name: state.board.name,
      world,
      subs,
      minZoom: zoomFloor(),
      bg: hex(el ? getComputedStyle(el).backgroundColor : ""),
    };
  },
};
