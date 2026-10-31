// Host performance: opening a board (highlighting + version status for all snippets) and the version check after HEAD changes, measured on a copy of nano-vllm.
// --switch: entering a sub-board and going back (BoardHub.switchBoard through the enterBoard / leaveBoard handlers) on a store of --boards boards instead.
// Usage: node packages/host/test/run-perf-host.mjs [--cards 240] [--runs 3] [--switch [--boards 30]]
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { analyze, initAnalysis } from "@codeboard/analysis";
import { emptyBoard, uid, type Board, type Segment } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { BoardHub } from "../src/hub";
import { makeHandler } from "../src/handlers";
import { stubView } from "./helpers";
import { startAnalysis } from "../src/analysis";
import { boardSegments, staleFor } from "../src/versions";
import { viewsFor } from "../src/views";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";

useWorkspace(nodeWorkspace());

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg("cards", "240"), RUNS = +arg("runs", "3"), BOARDS = +arg("boards", "30");
const REPO = path.resolve(__dirname, ".."); // bundled into test-out/
const git = (...a: string[]) => execFileSync("git", a, { cwd: WS, encoding: "utf8" }).trim();

const funcs = new Map<string, Segment[]>();
/** n commit-pinned snippets: every function in nano-vllm (from the skip-th on), repeated if too few */
function segments(commit: string, n: number, skip = 0): Segment[] {
  let all = funcs.get(commit);
  if (!all) {
    all = [];
    const files = git("ls-tree", "-r", "--name-only", commit, "nanovllm").split("\n").filter((f) => f.endsWith(".py"));
    for (const f of files) {
      const text = git("show", `${commit}:${f}`);
      const lines = text.split("\n");
      for (const s of analyze("python", text).symbols) if (s.kind === "def") all.push({ id: uid("s"), src: { kind: "repo", repo: "" }, path: f, lang: "python", start: s.start, end: s.end, text: lines.slice(s.start - 1, s.end), version: { kind: "git", commit }, symbol: { qual: s.qual, kind: "function" } });
    }
    funcs.set(commit, all);
  }
  const out: Segment[] = [];
  for (let i = 0; out.length < n; i++) out.push({ ...all[(skip + i) % all.length], id: uid("s") });
  return out;
}

const CARDS = 20;
const codeCards = (b: Board, segs: Segment[]) => segs.forEach((seg, k) => { const id = `c${k}`; b.cards.push({ id, kind: "code", segments: [seg] }); b.place[id] = { x: k * 700, y: 0, w: 640 }; });
/** A parent board with a frame per child board, each board with 20 code cards (each child other functions, every other child pinned to an older commit); the store on disk like a real project's */
async function boardStore(commit: string, older: string) {
  const dir = fs.mkdtempSync("/tmp/codeboard-perf-boards-");
  const store = new Storage(nodeFs, { dir: () => dir });
  const top = emptyBoard("bTop", "Top"), kids: Board[] = [];
  codeCards(top, segments(commit, CARDS));
  for (let i = 0; i < BOARDS; i++) {
    const b = emptyBoard(`bK${i}`, `Child ${i}`);
    codeCards(b, segments(i % 2 ? older : commit, CARDS, (i + 1) * CARDS));
    kids.push(b);
    top.cards.push({ id: `f${i}`, kind: "board", board: b.id }); top.place[`f${i}`] = { x: i * 600, y: 0, w: 560, h: 360 };
  }
  await store.save(top);
  for (const b of kids) await store.save(b);
  await store.flush();
  return { dir, store: new Storage(nodeFs, { dir: () => dir }) }; // a fresh store reads the files back, as after a window reload
}

async function time<T>(f: () => Promise<T>) { const t = performance.now(); const r = await f(); return [performance.now() - t, r] as const; }

void (async () => {
  if (!fs.existsSync(WS)) execFileSync("git", ["clone", "-q", path.join(REPO, "examples/nano-vllm"), WS]);
  await initAnalysis();
  await startAnalysis();
  const head = git("rev-parse", "HEAD");
  const old = git("rev-parse", "HEAD~6"); // predates the chunked prefill refactor: scheduler and block_manager both changed
  // --switch: entering a sub-board and going back instead. shown = until the new board's init is posted, filled = until every
  // snippet on it has its view and version status, done = until the handler returns (what hub.ts logs as "slow")
  if (process.argv.includes("--switch")) {
    const { dir, store } = await boardStore(head, old);
    const env = { globalState: { get: () => undefined, set: async () => {} }, openView: () => stubView().view };
    const hub = new BoardHub(env, store);
    hub.handler = makeHandler(hub);
    const v = stubView();
    const p = hub.attach("bTop", v.view);
    await p.init();
    const until = (ok: (from: number) => boolean, from: number, t0: number) => new Promise<number>((res) => {
      const tick = () => (ok(from) ? res(performance.now() - t0) : setImmediate(tick));
      tick();
    });
    const has = (from: number, to: string) => {
      const b = store.peek(to);
      if (!b) return false;
      const ms = v.posted.slice(from), views = new Set<string>(), stale = new Set<string>();
      for (const m of ms) {
        if (m.type === "init" || m.type === "views") for (const k of Object.keys(m.views)) views.add(k);
        if (m.type === "init" || m.type === "stale") for (const k of Object.keys(m.stale)) stale.add(k);
      }
      return ms.some((m) => m.type === "init") && boardSegments(b).every((s) => views.has(s.id) && stale.has(s.id));
    };
    const send = async (m: Parameters<typeof hub.handler>[1], to: string) => {
      const from = v.posted.length, t0 = performance.now();
      const [shown, filled] = await Promise.all([until((f) => v.posted.slice(f).some((x) => x.type === "init"), from, t0), until((f) => has(f, to), from, t0), hub.handler(p, m)]);
      return { shown: Math.round(shown), filled: Math.round(filled), done: Math.round(performance.now() - t0) };
    };
    for (let r = 0; r < Math.min(RUNS, BOARDS); r++) {
      const enter = await send({ type: "enterBoard", id: `bK${r}`, frame: `f${r}`, cam: { x: 0, y: 0, z: 1 } }, `bK${r}`);
      const leave = await send({ type: "leaveBoard" }, "bTop");
      console.log(JSON.stringify({ boards: BOARDS + 1, enter, leave }));
    }
    hub.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  for (let r = 0; r < RUNS; r++) {
    // A fresh process per run would be fairest (caches); approximated here with fresh snippets (new ids)
    const atHead = segments(head, N), atOld = segments(old, N);
    const [coldCheck] = r === 0 ? await time(() => staleFor(atOld)) : [0];
    const [open] = await time(() => Promise.all([viewsFor(atHead), staleFor(atHead)]));
    const [check] = await time(() => staleFor(atHead));
    const [openOld] = await time(() => Promise.all([viewsFor(atOld), staleFor(atOld)]));
    const [checkOld, st] = await time(() => staleFor(atOld));
    const changed = Object.values(st).filter((s) => s.state !== "ok").length;
    console.log(JSON.stringify({ segs: N, coldCheckOld: Math.round(coldCheck), openAtHead: Math.round(open), checkAtHead: Math.round(check), openOld: Math.round(openOld), checkOld: Math.round(checkOld), notOk: changed }));
  }
})();
