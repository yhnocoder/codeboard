// When versions are re-checked: an unsaved edit that is carded ("+ uncommitted") and then reverted without saving is noticed, because
// editing a file on a board re-checks the versions. It used to wait for some file to be saved
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
import { WS, nodeWorkspace } from "./node-workspace";
import { sleep, startTreeSitter } from "./helpers";

const W = nodeWorkspace();
const dir = fs.mkdtempSync("/tmp/codeboard-watch-");
const store = new Storage(nodeFs, { dir: () => dir });
const seqAbs = path.join(WS, "nanovllm/engine/sequence.py");
let checks = 0;
const panels = { refreshStale: async () => { checks++; }, get: () => undefined, staleChanged: () => undefined } as unknown as BoardHost;
let off: Disposable, typed: CodeCard;

beforeAll(async () => {
  useWorkspace(W);
  await startTreeSitter();
  const text = fs.readFileSync(seqAbs, "utf8") + "\n\ndef added_here():\n    return 1\n";
  W.open.set(seqAbs, text);
  typed = (await cardForFileSym(seqAbs, analysisOf("python", text).symbols.find((x) => x.qual === "added_here")!))!.card as CodeCard;
  const b = emptyBoard("bW", "Watch");
  b.cards.push(typed); b.place[typed.id] = { x: 0, y: 0, w: 500 };
  await store.save(b);
  off = watchVersions(panels, store);
  await sleep(800);
});
afterAll(() => { off.dispose(); W.open.clear(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("version re-checks", () => {
  it("notice a reverted unsaved edit without a save, once; editing other files doesn't re-check", async () => {
    const seg = typed.segments[0];
    expect(seg.version).toMatchObject({ kind: "git", uncommitted: true });
    const before = checks;
    W.open.set(seqAbs, fs.readFileSync(seqAbs, "utf8")); // File: Revert File
    W.fire.edit.fire(seqAbs);
    await sleep(900);
    W.fire.edit.fire(path.join(WS, "nanovllm/llm.py")); // a file no board uses
    await sleep(900);
    expect(checks).toBe(before + 1);
    expect((await staleFor([seg]))[seg.id]?.state).toBe("lost");
  });
});
