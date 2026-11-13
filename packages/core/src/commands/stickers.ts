// Stickers: placing one, its colour, its size, unpinning it
import { uid, type IconRef, type Sticker, type StickerAt } from "../model";
import type { CommandEnv } from "./env";

/** A sticker placed at `at`; its colour is kept only when it isn't the icon's own (def). Its id */
export function addSticker(
  env: CommandEnv,
  icon: IconRef,
  at: StickerAt,
  color: { pick?: string; def?: string },
): string {
  const id = uid("k");
  const st: Sticker = { id, icon, color: color.pick && color.pick !== color.def ? color.pick : undefined, at };
  env.edit((b) => {
    b.stickers.push(st);
  });
  return id;
}

/** A sticker's colour; its icon's own (def) is not stored */
export function setStickerColor(env: CommandEnv, id: string, color: string | undefined, def: string | undefined) {
  env.edit((b) => {
    const s = b.stickers.find((k) => k.id === id);
    if (s) s.color = color && color !== def ? color : undefined;
  });
}

/** A sticker unpinned from what it is on: it stays where it is drawn (`at`, the shell's world position), on the canvas */
export function detachSticker(env: CommandEnv, id: string, at: { x: number; y: number }) {
  env.edit((b) => {
    const k = b.stickers.find((q) => q.id === id);
    if (k?.at.kind === "canvas") k.at = { kind: "canvas", x: Math.round(at.x), y: Math.round(at.y), size: k.at.size };
  });
}

/** A canvas sticker's size */
export function setStickerSize(env: CommandEnv, id: string, size: number) {
  env.edit((b) => {
    const k = b.stickers.find((q) => q.id === id);
    if (k?.at.kind === "canvas") k.at.size = size;
  });
}
