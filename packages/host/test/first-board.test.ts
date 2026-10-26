// In a workspace without a board, commands that run at once (Alt+B and Open Board pressed together) use the same new board: each used
// to find no board and create its own "New Board", so the card went into one and the other was shown empty
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { makeActions } from "../src/actions";
import type { BoardHost } from "../src/boards";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";
import { startTreeSitter } from "./helpers";

const W = nodeWorkspace();
const dir = fs.mkdtempSync("/tmp/codeboard-firstboard-");
const store = new Storage(nodeFs, { dir: () => dir });
const shown: string[] = [];
let target: string | undefined;
const panels = { store, get target() { return target; }, get: () => undefined, all: () => [], setTarget: (id: string) => { target = id; }, show: async (id: string) => { shown.push(id); return undefined; } } as unknown as BoardHost;
W.ui.info = (async () => undefined) as typeof W.ui.info;

beforeAll(async () => { useWorkspace(W); await startTreeSitter(); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the first board of a workspace", () => {
  // Both ask for the target board in the same tick, as Alt+B and Open Board did once the extension had activated
  it("is one board when two commands ask for it at once", async () => {
    const acts = makeActions(panels, store);
    await Promise.all([acts["codeboard.openBoard"](), acts["codeboard.openBoard"]()]);
    const boards = await store.list();
    expect(boards.map((b) => b.name)).toEqual(["New Board"]);
    expect(shown).toEqual([boards[0].id, boards[0].id]);
  });
  it("then gets the card added next", async () => {
    const acts = makeActions(panels, store);
    await acts["codeboard.addSymbol"](path.join(WS, "nanovllm/engine/scheduler.py"), "Scheduler.schedule");
    const boards = await store.list();
    expect(boards).toHaveLength(1);
    expect((await store.load(boards[0].id))!.cards.map((c) => (c.kind === "code" ? c.segments[0].symbol?.qual : c.id))).toEqual(["Scheduler.schedule"]);
  });
});
