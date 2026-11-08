// The bundle's entry (build.mjs → bridge.js): the one bridge of the process on the shell's `native`, published as `CodeBoard` with
// JSON strings at the boundary. Every call names its boards folder (dir) and, for a board, its id; async methods take a request
// number first and resolve through native.emit("reply", {req, ok, json}) so the shell never waits on a Promise.
import "./prelude";
import { createBridge } from "./bridge";
import type { Native } from "./native";

declare const native: Native;
declare const wasmDir: string;

const bridge = createBridge(native, { wasmDir });
const str = (x: unknown) => JSON.stringify(x ?? null);
const settle = (req: number, p: Promise<unknown>) =>
  p.then(
    (r) => native.emit("reply", str({ req, ok: true, json: str(r) })),
    (e: Error) => native.emit("reply", str({ req, ok: false, error: e?.message ?? String(e) })),
  );
const session = (dir: string, id: string) => {
  const s = bridge.folder(dir).sessions.get(id);
  if (!s) throw new Error(`board ${id} is not open`);
  return s;
};

(globalThis as unknown as { CodeBoard: unknown }).CodeBoard = {
  list: (req: number, dir: string) => settle(req, bridge.folder(dir).list()),
  /** The board's scene; opening it again gives the scene as it is now */
  open: (req: number, dir: string, id: string) =>
    settle(
      req,
      bridge
        .folder(dir)
        .open(id)
        .then((s) => s?.scene() ?? null),
    ),
  changes: (req: number, dir: string, id: string) => settle(req, session(dir, id).changes()),
  undo: (req: number, dir: string, id: string) => settle(req, session(dir, id).undo()),
  redo: (req: number, dir: string, id: string) => settle(req, session(dir, id).redo()),
  endDrag: (req: number, dir: string, id: string, moves: string) =>
    settle(req, session(dir, id).endDrag(JSON.parse(moves))),
  /** Unsaved changes written: a folder's, or every folder's */
  flush: (req: number, dir?: string) => settle(req, dir ? bridge.folder(dir).flush() : bridge.flushAll()),
  /** The last window on the folder closed */
  closeFolder: (req: number, dir: string) => settle(req, bridge.folder(dir).close()),
  route: (dir: string, id: string, rects: string, only?: string, modes?: string) =>
    str(
      session(dir, id).route(
        JSON.parse(rects),
        only ? JSON.parse(only) : undefined,
        modes ? JSON.parse(modes) : undefined,
      ),
    ),
  beginDrag: (dir: string, id: string) => session(dir, id).beginDrag(),
  drag: (dir: string, id: string, moves: string) => session(dir, id).drag(JSON.parse(moves)),
  cam: (dir: string, id: string, x: number, y: number, z: number) => session(dir, id).cam({ x, y, z }),
  timer: (id: number) => bridge.timer(id),
  fsChanged: (id: number, abs: string) => bridge.fsChanged(id, abs),
  /** The gate: n edits on the board, each moving one card by a pixel (there and back, so the board ends as it was and nothing is
   *  written); the time of each in ms */
  benchEdit: (dir: string, id: string, n: number) => {
    const times: number[] = [];
    const s = session(dir, id);
    const ids = Object.keys(s.board().place);
    for (let i = 0; i < n - (n % 2); i++) {
      const card = ids[(i >> 1) % ids.length];
      const t0 = native.now();
      s.mutate((bb) => {
        bb.place[card].x += i % 2 ? -1 : 1;
      });
      times.push(native.now() - t0);
    }
    return str(times);
  },
};
