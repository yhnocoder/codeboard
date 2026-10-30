import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyBoard, type Board } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { BoardHub } from "../src/hub";
import type { HostEnv } from "../src/env";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";
import { card, startTreeSitter, stubView } from "./helpers";

const W = nodeWorkspace();
const wsState = new Map<string, unknown>(), globalState = new Map<string, unknown>();
W.storage = { ...W.storage, get: <T>(k: string) => wsState.get(k) as T, set: async (k, v) => { wsState.set(k, v); } };
const views: (ReturnType<typeof stubView> & { id: string; place: unknown })[] = [];
const env: HostEnv = {
  globalState: { get: <T>(k: string) => globalState.get(k) as T, set: async (k, v) => { globalState.set(k, v); } },
  openView: (id, _title, place) => { const v = stubView(); views.push({ ...v, id, place }); return v.view; },
};
const dir = fs.mkdtempSync("/tmp/codeboard-hub-");
const store = new Storage(nodeFs, { dir: () => dir });
let hub: BoardHub;

beforeAll(async () => {
  useWorkspace(W);
  await startTreeSitter();
  await store.save(emptyBoard("bA", "A")); await store.save(emptyBoard("bB", "B"));
  hub = new BoardHub(env, store);
});
afterAll(() => { hub.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("BoardHub", () => {
  it("opens a view through HostEnv, makes it the target and remembers the open boards and the target in the workspace", async () => {
    const p = await hub.show("bA", { side: true });
    expect(views.map((v) => [v.id, v.place])).toEqual([["bA", { side: true }]]);
    expect(hub.get("bA")).toBe(p);
    expect(hub.target).toBe("bA");
    expect(wsState.get("codeboard.target")).toBe("bA");
    expect(wsState.get("codeboard.open")).toEqual(["bA"]);
    expect(await hub.show("bA")).toBe(p); // already open: revealed, no second view
    expect(views).toHaveLength(1);
  });
  it("makes the activated view the target", async () => {
    await hub.show("bB", { preserveFocus: true });
    expect(hub.target).toBe("bA");
    views[1].activate.fire();
    expect(hub.target).toBe("bB");
  });
  it("keeps when each board was last opened in the cross-workspace state", () => {
    const before = Date.now();
    hub.opened("bA");
    expect(hub.lastOpened("bA")).toBeGreaterThanOrEqual(before);
    expect(hub.lastOpened("bA")).toBeLessThanOrEqual(Date.now());
    expect(Object.keys(globalState.get("codeboard.opened") as object)).toEqual(["bA"]);
  });
  it("forgets a closed view and restores an open board that has no view yet after a reload", async () => {
    views[1].dispose.fire();
    expect(hub.get("bB")).toBeUndefined();
    expect(wsState.get("codeboard.open")).toEqual(["bA"]);
    wsState.set("codeboard.open", ["bA", "bB"]);
    expect(await hub.restoreId("bA")).toBe("bB"); // bA already has a view
    expect(await hub.restoreId("gone")).toBe("bB");
    expect(await hub.restoreId("bB")).toBe("bB");
  });
  it("hands the view's messages to the handler and replies to requests", async () => {
    const seen: string[] = [];
    hub.handler = async (_p, m) => { seen.push(m.type); return { ok: 1 } as never; };
    const p = hub.get("bA")!;
    p.ready = true;
    views[0].message.fire({ type: "skeletons", req: 7, ids: [] });
    await vi.waitFor(() => expect(views[0].posted.find((m) => m.type === "reply")).toEqual({ type: "reply", req: 7, data: { ok: 1 } }), { timeout: 10000, interval: 1 });
    expect(seen).toEqual(["skeletons"]);
  });
});

describe("version re-check after a file change", () => {
  const schAbs = path.join(WS, "nanovllm/engine/scheduler.py"), seqAbs = path.join(WS, "nanovllm/engine/sequence.py"), llmAbs = path.join(WS, "nanovllm/engine/llm_engine.py");
  const read: string[] = [];
  let A: Board, B: Board;
  beforeAll(async () => {
    // board A holds scheduler.py and sequence.py, board B holds llm_engine.py
    const a1 = (await card(schAbs, "Scheduler.schedule")).card, a2 = (await card(seqAbs, "Sequence.__init__")).card, b1 = (await card(llmAbs, "LLMEngine.step")).card;
    A = { ...emptyBoard("bA", "A"), cards: [a1, a2], place: { [a1.id]: { x: 0, y: 0, w: 500 }, [a2.id]: { x: 600, y: 0, w: 500 } } };
    B = { ...emptyBoard("bB", "B"), cards: [b1], place: { [b1.id]: { x: 0, y: 0, w: 500 } } };
    const pa = hub.get("bA")!;
    pa.board = A; pa.ready = true;
    const pb = await hub.show("bB");
    pb!.board = B; pb!.ready = true;
    await Promise.all([pa.refreshStale(), pb!.refreshStale()]);
    // every file the version check reads from here on (readText asks the workspace for unsaved text first)
    const unsaved = W.files.unsavedText;
    W.files.unsavedText = (abs) => { read.push(abs); return unsaved(abs); };
  });

  it("re-reads only the changed file, only on the board that holds it, keeping the other segments' results", async () => {
    const pa = hub.get("bA")!, pb = hub.get("bB")!;
    const seqSeg = A.cards[1].kind === "code" ? A.cards[1].segments[0].id : "";
    pa.stale = { ...pa.stale, [seqSeg]: { state: "uncommitted" } }; // a result that only a re-check of sequence.py would replace
    const postedB = views.at(-1)!.posted.length;
    read.length = 0;
    await hub.refreshStale(new Set([schAbs]));
    expect([...new Set(read)]).toEqual([schAbs]);
    expect(pa.stale[seqSeg]).toEqual({ state: "uncommitted" });
    expect(views.at(-1)!.posted.length).toBe(postedB);
    expect(Object.keys(pb.stale)).toHaveLength(1);
  });
  it("re-checks everything without paths (HEAD changed)", async () => {
    read.length = 0;
    await hub.refreshStale();
    expect([...new Set(read)].sort()).toEqual([llmAbs, schAbs, seqAbs].sort());
  });
});

describe("opening a board", () => {
  const blockAbs = path.join(WS, "nanovllm/engine/block_manager.py");
  afterAll(() => { W.open.delete(blockAbs); });
  it("posts the board with its highlighting before the version status, then the status; a re-check runs after it", async () => {
    const c = (await card(blockAbs, "BlockManager.allocate")).card;
    const seg = c.segments[0];
    // an unsaved edit inside the function: the version check says "uncommitted"
    const text = fs.readFileSync(blockAbs, "utf8").split("\n");
    text[seg.start] += "  # edited";
    W.open.set(blockAbs, text.join("\n"));
    await store.save({ ...emptyBoard("bV", "V"), cards: [c], place: { [c.id]: { x: 0, y: 0, w: 500 } } });
    const p = (await hub.show("bV"))!, posted = views.at(-1)!.posted;
    await p.init();
    const init = posted.find((m) => m.type === "init");
    expect(init?.type === "init" && init.views[seg.id]?.html.length).toBe(seg.text.length);
    expect(init?.type === "init" && init.stale).toEqual({});
    await p.refreshStale();
    expect(p.stale[seg.id]).toEqual({ state: "uncommitted" });
    const after = posted.slice(posted.indexOf(init!) + 1).filter((m) => m.type === "stale");
    expect(after).toEqual([{ type: "stale", stale: { [seg.id]: { state: "uncommitted" } } }]); // the re-check found nothing new: posted once
  });
});
