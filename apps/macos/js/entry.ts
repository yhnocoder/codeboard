// The bundle's entry (build.mjs → bridge.js): the bridge on the shell's `native`, published as `CodeBoard` with JSON strings at
// the boundary. Async methods resolve through native.emit("reply", {req, ok, json}) so the shell never waits on a Promise.
import { createBridge } from "./bridge";
import type { Native } from "./native";

declare const native: Native;

const bridge = createBridge(native);
const str = (x: unknown) => JSON.stringify(x ?? null);
const settle = (req: number, p: Promise<unknown>) =>
  p.then(
    (r) => native.emit("reply", str({ req, ok: true, json: str(r) })),
    (e: Error) => native.emit("reply", str({ req, ok: false, error: e?.message ?? String(e) })),
  );

(globalThis as unknown as { CodeBoard: unknown }).CodeBoard = {
  init: (dir: string, stateFile: string) => bridge.init(dir, stateFile),
  list: (req: number) => settle(req, bridge.list()),
  open: (req: number, id: string) => settle(req, bridge.open(id)),
  changes: (req: number) => settle(req, bridge.changes()),
  undo: (req: number) => settle(req, bridge.undo()),
  redo: (req: number) => settle(req, bridge.redo()),
  endDrag: (req: number) => settle(req, bridge.endDrag()),
  flush: (req: number) => settle(req, bridge.flush()),
  route: (rects: string, only?: string) => str(bridge.route(JSON.parse(rects), only ? JSON.parse(only) : undefined)),
  beginDrag: () => bridge.beginDrag(),
  drag: (moves: string) => bridge.drag(JSON.parse(moves)),
  cam: (x: number, y: number, z: number) => bridge.cam({ x, y, z }),
  timer: (id: number) => bridge.timer(id),
  fsChanged: (id: number, abs: string) => bridge.fsChanged(id, abs),
  /** The gate: n edits on the board, each moving one card by a pixel; the time of each in ms */
  benchEdit: (n: number) => {
    const times: number[] = [];
    const b = bridge.board();
    const ids = Object.keys(b.place);
    for (let i = 0; i < n; i++) {
      const id = ids[i % ids.length];
      const t0 = native.now();
      bridge.mutate((bb) => {
        bb.place[id].x += 1;
      });
      times.push(native.now() - t0);
    }
    return str(times);
  },
};
