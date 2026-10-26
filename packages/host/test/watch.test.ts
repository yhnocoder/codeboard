// When versions are re-checked: editing or saving a file on a board re-checks that file only (N6: typing pauses used to re-check every
// segment of every open board); an unsaved edit that is reverted is noticed without a save
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBoard, type CodeCard, type Disposable } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { analysisOf } from "../src/analysis";
import { cardForFileSym } from "../src/cards";
import type { BoardHost } from "../src/boards";
import { staleFor } from "../src/versions";
import { watchVersions } from "../src/watch";
import { useWorkspace } from "../src/ws";
import { recentLog } from "../src/log";
import { WS, nodeWorkspace } from "./node-workspace";
import { card, sleep, startTreeSitter } from "./helpers";

const W = nodeWorkspace();
const dir = fs.mkdtempSync("/tmp/codeboard-watch-");
const store = new Storage(nodeFs, { dir: () => dir });
const seqAbs = path.join(WS, "nanovllm/engine/sequence.py"), schAbs = path.join(WS, "nanovllm/engine/scheduler.py"), llmAbs = path.join(WS, "nanovllm/engine/llm_engine.py");
/** what the watcher asked the boards to re-check: one entry per call, the paths sorted (undefined = everything) */
const rechecks: (string[] | undefined)[] = [];
const panels = { refreshStale: async (paths?: ReadonlySet<string>) => { rechecks.push(paths && [...paths].sort()); }, get: () => undefined, staleChanged: () => undefined } as unknown as BoardHost;
let off: Disposable, typed: CodeCard;

beforeAll(async () => {
  useWorkspace(W);
  await startTreeSitter();
  // a function typed but not saved ("+ uncommitted") and a committed one, on one board
  const text = fs.readFileSync(seqAbs, "utf8") + "\n\ndef added_here():\n    return 1\n";
  W.open.set(seqAbs, text);
  typed = (await cardForFileSym(seqAbs, analysisOf("python", text).symbols.find((x) => x.qual === "added_here")!))!.card as CodeCard;
  const sch = (await card(schAbs, "Scheduler.schedule")).card;
  const b = emptyBoard("bW", "Watch");
  b.cards.push(typed, sch); b.place[typed.id] = { x: 0, y: 0, w: 500 }; b.place[sch.id] = { x: 600, y: 0, w: 500 };
  await store.save(b);
  off = watchVersions(panels, store);
  await sleep(800);
});
afterAll(() => { off.dispose(); W.open.clear(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("version re-checks", () => {
  it("re-check only the edited file, once per pause, and not for files no board uses", async () => {
    rechecks.length = 0;
    W.fire.edit.fire(schAbs); W.fire.edit.fire(schAbs);
    W.fire.edit.fire(llmAbs); // a file no board uses
    await sleep(900);
    expect(rechecks).toEqual([[schAbs]]);
  });
  it("collect the files edited within one pause into one re-check", async () => {
    rechecks.length = 0;
    W.fire.edit.fire(schAbs);
    W.fire.save.fire(seqAbs);
    await sleep(900);
    expect(rechecks).toEqual([[seqAbs, schAbs].sort()]);
  });
  it("re-check a file changed outside the editor", async () => {
    rechecks.length = 0;
    W.fire.change.fire(schAbs);
    await sleep(900);
    expect(rechecks).toEqual([[schAbs]]);
  });
  it("notice a reverted unsaved edit without a save: the card's code is gone", async () => {
    const seg = typed.segments[0];
    expect(seg.version).toMatchObject({ kind: "git", uncommitted: true });
    rechecks.length = 0;
    W.open.set(seqAbs, fs.readFileSync(seqAbs, "utf8")); // File: Revert File
    W.fire.edit.fire(seqAbs);
    await sleep(900);
    expect(rechecks).toEqual([[seqAbs]]);
    expect((await staleFor([seg]))[seg.id]?.state).toBe("lost");
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
      refreshStale: async () => {}, get: () => undefined,
      staleChanged: (id: string) => { if (id === "bBad") throw new Error("sidebar is gone"); counted.push(id); },
    } as unknown as BoardHost;
    const w = watchVersions(failing, st);
    try {
      const logged = () => recentLog().find((l) => l.includes("[warn]") && l.includes("bBad") && l.includes("sidebar is gone"));
      for (let i = 0; i < 100 && !(logged() && counted.includes("bOk")); i++) await sleep(20);
      expect(logged()).toMatch(/versions: could not count new versions on closed board bBad: sidebar is gone/);
      expect(counted).toContain("bOk");
    } finally { w.dispose(); fs.rmSync(d2, { recursive: true, force: true }); }
  });
});
