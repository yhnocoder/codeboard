import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyBoard, type CodeCard, type Disposable } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { analysisOf } from "../src/analysis";
import { cardForFileSym } from "../src/cards";
import type { BoardHost } from "../src/boards";
import { staleFor } from "../src/versions";
import { RECHECK_PAUSE, watchVersions } from "../src/watch";
import { useWorkspace } from "../src/ws";
import { recentLog } from "../src/log";
import { WS, nodeWorkspace } from "./node-workspace";
import { card, startTreeSitter } from "./helpers";

const W = nodeWorkspace();
const dir = fs.mkdtempSync("/tmp/codeboard-watch-");
const store = new Storage(nodeFs, { dir: () => dir });
const seqAbs = path.join(WS, "nanovllm/engine/sequence.py"),
  schAbs = path.join(WS, "nanovllm/engine/scheduler.py"),
  llmAbs = path.join(WS, "nanovllm/engine/llm_engine.py"),
  bmAbs = path.join(WS, "nanovllm/engine/block_manager.py");
/** what the watcher asked the boards to re-check: one entry per call, the paths sorted (undefined = everything) */
const rechecks: (string[] | undefined)[] = [];
const panels = {
  refreshStale: async (paths?: ReadonlySet<string>) => {
    rechecks.push(paths && [...paths].sort());
  },
  get: () => undefined,
  staleChanged: () => undefined,
} as unknown as BoardHost;
let off: Disposable & { ready: Promise<void> }, typed: CodeCard;

beforeAll(async () => {
  useWorkspace(W);
  await startTreeSitter();
  // a function typed but not saved ("+ uncommitted") and a committed one, on one board
  const text = fs.readFileSync(seqAbs, "utf8") + "\n\ndef added_here():\n    return 1\n";
  W.open.set(seqAbs, text);
  typed = (await cardForFileSym(seqAbs, analysisOf("python", text).symbols.find((x) => x.qual === "added_here")!))!
    .card as CodeCard;
  const sch = (await card(schAbs, "Scheduler.schedule")).card;
  const b = emptyBoard("bW", "Watch");
  b.cards.push(typed, sch);
  b.place[typed.id] = { x: 0, y: 0, w: 500 };
  b.place[sch.id] = { x: 600, y: 0, w: 500 };
  await store.save(b);
  off = watchVersions(panels, store);
  await off.ready;
});
afterAll(() => {
  off.dispose();
  W.open.clear();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Fire events on a fake clock and let the pause run out: nothing is re-checked a moment before the end of the pause, then exactly
 * what the watcher collected, and no other re-check is left waiting
 */
function onePause(fire: () => void) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    rechecks.length = 0;
    fire();
    vi.advanceTimersByTime(RECHECK_PAUSE - 1);
    expect(rechecks).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
}

describe("version re-checks", () => {
  it("re-check only the edited file, once per pause, and not for files no board uses", async () => {
    onePause(() => {
      W.fire.edit.fire(schAbs);
      W.fire.edit.fire(schAbs);
      W.fire.edit.fire(llmAbs); // a file no board uses
    });
    expect(rechecks).toEqual([[schAbs]]);
  });
  it("collect the files edited within one pause into one re-check", async () => {
    onePause(() => {
      W.fire.edit.fire(schAbs);
      W.fire.save.fire(seqAbs);
    });
    expect(rechecks).toEqual([[seqAbs, schAbs].sort()]);
  });
  it("notice a reverted unsaved edit without a save: the card's code is gone", async () => {
    const seg = typed.segments[0];
    expect(seg.version).toMatchObject({ kind: "git", uncommitted: true });
    W.open.set(seqAbs, fs.readFileSync(seqAbs, "utf8")); // File: Revert File
    onePause(() => W.fire.edit.fire(seqAbs));
    expect(rechecks).toEqual([[seqAbs]]);
    expect((await staleFor([seg]))[seg.id]?.state).toBe("lost");
  });
  it("a file newly on a board is re-checked once its watch is in place: a change made before then fires nothing", async () => {
    const b = (await store.load("bW"))!;
    const bm = (await card(bmAbs, "BlockManager.allocate")).card;
    b.cards.push(bm);
    b.place[bm.id] = { x: 0, y: 600, w: 500 };
    rechecks.length = 0;
    await store.save(b);
    await vi.waitFor(() => expect(rechecks.flat()).toContain(bmAbs), { timeout: 5000 });
  });
});

// The test workspace's watch() never sees the disk, like an editor whose watcher starts the watch late (VS Code starts it only once
// the watches asked for before it have started): the file's change still has to arrive
describe("files changed outside the editor", () => {
  const ext = fs.mkdtempSync("/tmp/codeboard-watch-ext-");
  const modAbs = path.join(ext, "mod.py");
  const boards = fs.mkdtempSync("/tmp/codeboard-watch-ext-boards-");
  const st = new Storage(nodeFs, { dir: () => boards });
  const seen: string[] = [];
  const host = {
    refreshStale: async (paths?: ReadonlySet<string>) => {
      seen.push(...(paths ?? []));
    },
    get: () => undefined,
    staleChanged: () => undefined,
  } as unknown as BoardHost;
  let w: Disposable & { ready: Promise<void> };
  beforeAll(async () => {
    fs.writeFileSync(modAbs, "def f():\n    return 1\n");
    w = watchVersions(host, st);
    await w.ready;
  });
  afterAll(() => {
    w.dispose();
    for (const d of [ext, boards]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("a change right after the card is saved is re-checked from the disk, however late the editor's watcher starts", async () => {
    const b = emptyBoard("bX", "Outside");
    const c = (await card(modAbs, "f")).card;
    b.cards.push(c);
    b.place[c.id] = { x: 0, y: 0, w: 500 };
    expect(c.segments[0].src).toEqual({ kind: "external", root: ext });
    await st.save(b);
    // the re-check made once the watch is in place
    await vi.waitFor(() => expect(seen).toContain(modAbs), { timeout: 5000 });
    seen.length = 0;
    fs.writeFileSync(modAbs, "def f():\n    return 2\n");
    await vi.waitFor(() => expect(seen).toContain(modAbs), { timeout: 5000 });
  });
  it("a save that renames a new file over the old one is re-checked too", async () => {
    seen.length = 0;
    fs.writeFileSync(modAbs + ".tmp", "def f():\n    return 3\n");
    fs.renameSync(modAbs + ".tmp", modAbs);
    await vi.waitFor(() => expect(seen).toContain(modAbs), { timeout: 5000 });
  });
});

describe("new-version counts for closed boards", () => {
  it("a failure on one board is logged with its id, and the other boards are still counted", async () => {
    const d2 = fs.mkdtempSync("/tmp/codeboard-watch-fail-");
    const st = new Storage(nodeFs, { dir: () => d2 });
    await st.save(emptyBoard("bBad", "Bad"));
    await st.save(emptyBoard("bOk", "Ok"));
    const counted: string[] = [];
    const failing = {
      refreshStale: async () => {},
      get: () => undefined,
      staleChanged: (id: string) => {
        if (id === "bBad") throw new Error("sidebar is gone");
        counted.push(id);
      },
    } as unknown as BoardHost;
    const w = watchVersions(failing, st);
    try {
      await w.ready;
      const logged = () =>
        recentLog().find((l) => l.includes("[warn]") && l.includes("bBad") && l.includes("sidebar is gone"));
      expect(logged()).toMatch(/versions: could not count new versions on closed board bBad: sidebar is gone/);
      expect(counted).toContain("bOk");
    } finally {
      w.dispose();
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });
});
