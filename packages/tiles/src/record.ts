// What the host sends each board when it opens: the real host (startHost) over a copy of the board folder, every board opened as
// an editor panel would open it. The messages it keeps are everything the board draws from: the board, its highlighted code,
// its sub-boards' skeletons, the shared cards' state
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Emitter, type BoardMeta, type BoardToHost, type HostToBoard } from "@codeboard/core";
import { startHost, type BoardView, type HostEnv } from "@codeboard/host";
import { boardsWorkspace } from "./workspace";

export type Recording = { metas: BoardMeta[]; messages: Map<string, HostToBoard[]> };

/** The kinds of message a still picture draws from */
const KEPT = new Set(["init", "skeletons", "boardRefs", "shared", "sharedInfo", "views"]);
/** After a board's init, the host pushes what follows (skeletons, shared cards, references) debounced (hub.ts PUSH_PAUSE,
 *  120 ms): the recording ends once no board got a message for this long */
const QUIET = 400;
/** A board that never gets its init fails the build instead of hanging it */
const INIT_LIMIT = 60_000;

class View implements BoardView {
  title = "";
  visible = true;
  active = true;
  msgs: HostToBoard[] = [];
  readonly message = new Emitter<BoardToHost>();
  onMessage = this.message.event;
  onDidActivate = new Emitter<void>().event;
  private gone = new Emitter<void>();
  onDidDispose = this.gone.event;
  constructor(private heard: () => void) {}
  postMessage(m: HostToBoard) {
    this.msgs.push(structuredClone(m));
    this.heard();
  }
  reveal() {}
  async focus() {}
  dispose() {
    this.gone.fire();
  }
  // the board's images: the renderer serves the board folder's assets/ next to its page
  resourceUrl() {
    return "assets";
  }
}

/** Records every board of `boardsDir` (a .codeboard folder); mediaDir = the built board (the host inlines its fonts in exports) */
export async function recordBoards(boardsDir: string, mediaDir: string): Promise<Recording> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-tiles-"));
  const root = path.join(tmp, "ws");
  // a copy: the host upgrades old files and keeps its caches next to them, and the folder it reads must not change
  fs.cpSync(boardsDir, path.join(root, ".codeboard"), { recursive: true });
  let last = Date.now();
  const views: View[] = [];
  const env: HostEnv = {
    globalState: { get: () => undefined, set: async () => {} },
    openView: () => {
      const v = new View(() => {
        last = Date.now();
      });
      views.push(v);
      return v;
    },
  };
  const host = startHost(boardsWorkspace(root, path.join(tmp, "storage")), env, { mediaDir });
  try {
    await host.ready;
    const metas = await host.store.list();
    const opened: { id: string; view: View }[] = [];
    for (const m of metas) {
      const p = await host.hub.show(m.id, { preserveFocus: true });
      if (!p) continue;
      const view = p.view as View;
      view.message.fire({ type: "ready" });
      opened.push({ id: m.id, view });
    }
    const t0 = Date.now();
    await new Promise<void>((done, fail) => {
      const tick = () => {
        const waiting = opened.filter((o) => !o.view.msgs.some((x) => x.type === "init"));
        if (!waiting.length && Date.now() - last >= QUIET) return done();
        if (Date.now() - t0 > INIT_LIMIT) return fail(new Error(`no init for ${waiting.map((o) => o.id).join(", ")}`));
        setTimeout(tick, 50);
      };
      tick();
    });
    const messages = new Map(opened.map((o) => [o.id, o.view.msgs.filter((x) => KEPT.has(x.type))]));
    return { metas: metas.filter((m) => messages.has(m.id)), messages };
  } finally {
    for (const v of views) v.dispose();
    host.dispose();
    await host.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
