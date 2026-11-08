// The tile pyramid's geometry, which the phone app reads back from each board's manifest.json: square tiles of TILE device px
// at DPR, levels at zoom 1, 1/2, 1/4 … until the board fits in 2 × 2 tiles, each shot of the page covering SHOT × SHOT tiles
import type { Rect } from "@codeboard/core";

export const TILE = 512;
export const DPR = 2;
/** A tile's edge in CSS px */
export const CSS_TILE = TILE / DPR;
/** Tiles per shot edge: the page's viewport is SHOT tiles square */
const SHOT = 4;
export const VIEW = CSS_TILE * SHOT;
/** Margin around what the board covers, world px */
export const PAD = 60;
/** WebP quality */
export const QUALITY = 75;
/** A tile whose every channel is within this of the board's paper colour is left out (the app paints the paper) */
const PLAIN = 6;

export type Level = { z: number; cols: number; rows: number };
export type Shot = { cam: { x: number; y: number; z: number }; tiles: { col: number; row: number; clip: Rect }[] };

/** What the tiles cover: the board's extent with a margin, on whole world px */
export function tileWorld(r: Rect): Rect {
  const x = Math.floor(r.x - PAD),
    y = Math.floor(r.y - PAD);
  return { x, y, w: Math.ceil(r.x + r.w + PAD) - x, h: Math.ceil(r.y + r.h + PAD) - y };
}

/** The levels: zoom 1, then halved until the whole board fits in 2 × 2 tiles */
export function levels(world: Rect): Level[] {
  const out: Level[] = [];
  for (let z = 1; ; z /= 2) {
    out.push({ z, cols: Math.ceil((world.w * z * DPR) / TILE), rows: Math.ceil((world.h * z * DPR) / TILE) });
    if (world.w * z * DPR <= TILE * 2 && world.h * z * DPR <= TILE * 2) return out;
  }
}

/** The shots of a level: the camera for each, and its tiles, each with its clip of the shot in device px */
export function shots(world: Rect, L: Level): Shot[] {
  const out: Shot[] = [];
  const wide = world.w * L.z * DPR,
    high = world.h * L.z * DPR;
  for (let sy = 0; sy < L.rows; sy += SHOT)
    for (let sx = 0; sx < L.cols; sx += SHOT) {
      const tiles: Shot["tiles"] = [];
      for (let row = sy; row < Math.min(L.rows, sy + SHOT); row++)
        for (let col = sx; col < Math.min(L.cols, sx + SHOT); col++)
          tiles.push({
            col,
            row,
            clip: {
              x: (col - sx) * TILE,
              y: (row - sy) * TILE,
              w: Math.min(TILE, Math.ceil(wide - col * TILE)),
              h: Math.min(TILE, Math.ceil(high - row * TILE)),
            },
          });
      out.push({ cam: { x: -(world.x * L.z + sx * CSS_TILE), y: -(world.y * L.z + sy * CSS_TILE), z: L.z }, tiles });
    }
  return out;
}

/** "#rrggbb" → [r, g, b] */
export const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The clip of a raw image (width px wide, `channels` bytes a pixel) is nothing but the paper colour */
export function isPlain(raw: Uint8Array, width: number, channels: number, clip: Rect, paper: number[]): boolean {
  for (let y = clip.y; y < clip.y + clip.h; y++) {
    let i = (y * width + clip.x) * channels;
    for (let x = 0; x < clip.w; x++, i += channels)
      if (
        Math.abs(raw[i] - paper[0]) > PLAIN ||
        Math.abs(raw[i + 1] - paper[1]) > PLAIN ||
        Math.abs(raw[i + 2] - paper[2]) > PLAIN
      )
        return false;
  }
  return true;
}
