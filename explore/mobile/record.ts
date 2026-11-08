// Builds the static data of the mobile viewer: runs the real host (startHost on the Node Workspace) over a folder whose
// .codeboard/ holds the boards, opens each board as the VS Code panel would and keeps what the host sends it (the init with
// highlighted code, then skeletons, board refs, shared cards). Usage: node record.mjs <boards dir> <out dir>
import * as fs from "node:fs";
import * as path from "node:path";
import { Emitter, cardKey, putSummary, secKey, summarySig, type BoardToHost, type HostToBoard } from "@codeboard/core";
import { startHost, type BoardView, type HostEnv } from "@codeboard/host";
import { nodeWorkspace } from "@codeboard/host/testing";

const [src, out, sumFile] = process.argv.slice(2);
// the sample boards carry no zoomed-out summaries (persona's own boards do, once written): the demo takes #130's
const sums: Record<string, Record<string, { kind: string; title?: string; md: string }>> = sumFile
  ? JSON.parse(fs.readFileSync(sumFile, "utf8"))
  : {};
const root = fs.mkdtempSync("/tmp/cbm-ws-");
fs.mkdirSync(path.join(root, ".codeboard"), { recursive: true });
for (const f of fs.readdirSync(src)) {
  const p = path.join(src, f);
  if (fs.statSync(p).isDirectory()) fs.cpSync(p, path.join(root, ".codeboard", f), { recursive: true });
  else if (f.endsWith(".json")) fs.copyFileSync(p, path.join(root, ".codeboard", f));
}
const ws = nodeWorkspace(root);
const state = new Map<string, unknown>();
ws.storage = {
  dir: () => path.join(root, "_storage"),
  globalDir: () => path.join(root, "_global"),
  get: <T,>(k: string) => state.get(k) as T | undefined,
  set: async (k, v) => void state.set(k, v),
};
const got = new Map<string, HostToBoard[]>();
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
  postMessage(m: HostToBoard) {
    this.msgs.push(structuredClone(m));
  }
  reveal() {}
  async focus() {}
  dispose() {
    this.gone.fire();
  }
  resourceUrl() {
    return "assets";
  }
}
const views: View[] = [];
const env: HostEnv = {
  globalState: { get: () => undefined, set: async () => {} },
  openView: () => {
    const v = new View();
    views.push(v);
    return v;
  },
};
const host = startHost(ws, env, { mediaDir: path.resolve("../../packages/board/dist") });
await host.ready;
const metas = await host.store.list();
fs.mkdirSync(out, { recursive: true });
const settle = () => new Promise((r) => setTimeout(r, 400));
for (const m of metas) {
  const p = await host.hub.show(m.id);
  if (!p) continue;
  const v = p.view as View;
  v.message.fire({ type: "ready" });
  for (let i = 0; i < 50 && !v.msgs.some((x) => x.type === "init"); i++) await settle();
  // the skeletons of its sub-board cards and the rest arrive just after the init
  await settle();
  const init = v.msgs.find((x) => x.type === "init");
  if (init?.type === "init")
    for (const [id, x] of Object.entries(sums[m.id] ?? {})) {
      if (typeof x !== "object" || !x.md) continue;
      const key = x.kind === "section" ? secKey(id) : cardKey(id);
      const sig = summarySig(init.board, key);
      if (sig) putSummary(init.board, key, { text: x.md, ...(x.title && x.kind !== "section" ? { title: x.title } : {}), at: Date.now(), sig });
    }
  const kept = v.msgs.filter((x) => ["init", "skeletons", "boardRefs", "shared", "sharedInfo", "views"].includes(x.type));
  got.set(m.id, kept);
  fs.writeFileSync(path.join(out, `${m.id}.json`), JSON.stringify(kept));
  v.dispose();
  console.log(m.id, m.name, kept.map((x) => x.type).join(","));
}
const assets = path.join(root, ".codeboard", "assets");
if (fs.existsSync(assets)) fs.cpSync(assets, path.join(out, "assets"), { recursive: true });
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(metas));
host.dispose();
await host.flush();
process.exit(0);
