// What a board's picture depends on, as one hash: an unchanged hash means the tiles drawn last time are still right. That is
// the renderer (the built board and the tile renderer's own page and code) and what the host gave the board to draw: its
// file, its highlighted code, its sub-boards' skeletons, the shared cards, and the images those name. Nothing else: an
// unrelated CodeBoard commit, or another board's edit, draws nothing again
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HostToBoard } from "@codeboard/core";

const sha = () => createHash("sha256");

/** Every file under dir (its path and its bytes), in a fixed order */
export function dirHash(dir: string): string {
  const h = sha();
  const files = (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort();
  for (const f of files)
    h.update(f)
      .update("\0")
      .update(fs.readFileSync(path.join(dir, f)))
      .update("\0");
  return h.digest("hex");
}

/** The renderer: the built board (dir) and the tile renderer's own hash (its page, code and settings, fixed at its build) */
export const rendererHash = (boardDist: string, own: string) =>
  sha().update(own).update(dirHash(boardDist)).digest("hex");

/**
 * A board's messages as the renderer gives them to it, and as its hash reads them: in the init the camera at the origin (the
 * renderer moves it; where someone last looked draws nothing), no welcome-back hint (it counts days since the board was opened,
 * and a still picture shows none), and of the workspace's board list only the boards it names (a sub-board card shows its
 * board's name, a [[ref]] its board's name and seal), with nothing but those: another board's edit, or a board added to the
 * workspace, must not draw this one again
 */
export function drawn(msgs: HostToBoard[]): HostToBoard[] {
  const rest = JSON.stringify(msgs.map((m) => (m.type === "init" ? { ...m, boards: [] } : m)));
  return msgs.map((m) => {
    if (m.type !== "init") return m;
    const { welcome: _, ...init } = m;
    const boards = m.boards
      .filter((b) => rest.includes(JSON.stringify(b.id)))
      .map((b) => ({ id: b.id, name: b.name, cards: 0, ...(b.seal ? { seal: b.seal } : {}) }));
    return { ...init, board: { ...m.board, cam: { x: 0, y: 0, z: 1 } }, boards };
  });
}

/** The image files a recording names (assets/<name>), sorted */
export const assetsNamed = (json: string) => [...new Set(json.match(/assets\/[\w.-]+/g) ?? [])].sort();

/**
 * A board's picture: the renderer and the board's messages as drawn. asset(name) reads an image of the board folder
 * (assets/<name>), undefined when it is not there. 16 hex digits, as the zip names carry it
 */
export function pictureHash(
  renderer: string,
  msgs: HostToBoard[],
  asset: (name: string) => Uint8Array | undefined,
): string {
  const json = JSON.stringify(drawn(msgs));
  const h = sha().update(renderer).update(json);
  for (const a of assetsNamed(json)) {
    const bytes = asset(a.slice("assets/".length));
    h.update(a).update("\0");
    if (bytes) h.update(bytes);
  }
  return h.digest("hex").slice(0, 16);
}
