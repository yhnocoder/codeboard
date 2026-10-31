import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyBoard, type Board, type BoardRefs, type HostToBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { BoardHub } from "../src/hub";
import { makeHandler } from "../src/handlers";
import type { HostEnv } from "../src/env";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { stubView } from "./helpers";

const W = nodeWorkspace();
const wsState = new Map<string, unknown>(),
  globalState = new Map<string, unknown>();
W.storage = {
  ...W.storage,
  get: <T>(k: string) => wsState.get(k) as T,
  set: async (k, v) => {
    wsState.set(k, v);
  },
};
const views: ReturnType<typeof stubView>[] = [];
const env: HostEnv = {
  globalState: {
    get: <T>(k: string) => globalState.get(k) as T,
    set: async (k, v) => {
      globalState.set(k, v);
    },
  },
  openView: () => {
    const v = stubView();
    views.push(v);
    return v.view;
  },
};
const dir = fs.mkdtempSync("/tmp/codeboard-refs-");
const store = new Storage(nodeFs, { dir: () => dir });
let hub: BoardHub;

function board(
  id: string,
  name: string,
  notes: { id: string; md: string; section?: string }[],
  sections: { id: string; title: string }[] = [],
): Board {
  const b = emptyBoard(id, name);
  for (const s of sections) b.sections.push({ ...s, x: 0, y: 0, w: 400, h: 400 });
  notes.forEach((n, i) => {
    b.cards.push({ id: n.id, kind: "note", md: n.md, look: "note" });
    b.place[n.id] = { x: 0, y: i * 200, w: 300, section: n.section };
  });
  return b;
}
const pushes = (v: ReturnType<typeof stubView>) =>
  v.posted.filter((m): m is Extract<HostToBoard, { type: "boardRefs" }> => m.type === "boardRefs");

beforeAll(async () => {
  useWorkspace(W);
  await store.save(board("bA", "Alpha", [{ id: "a1", md: "# Alpha card" }]));
  await store.save(
    board(
      "bB",
      "Beta",
      [
        { id: "b1", md: "# Tiling", section: "s1" },
        { id: "b2", md: "no heading" },
      ],
      [{ id: "s1", title: "Shared memory" }],
    ),
  );
  await store.save(board("bC", "Gamma", [{ id: "c1", md: "## Roofline" }]));
  globalState.set("codeboard.opened", { bB: 1, bC: 2 });
  hub = new BoardHub(env, store);
  hub.handler = makeHandler(hub);
});
afterAll(() => {
  hub.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cross-board refs", () => {
  it("lists the other boards' titled cards with their Section, most recently opened board first, without the asking board", async () => {
    const p = (await hub.show("bA"))!;
    p.ready = true;
    const r = (await hub.handler(p, { type: "boardRefs", req: 1 })) as BoardRefs;
    expect(r.boards.map((b) => b.name)).toEqual(["Gamma", "Beta"]);
    expect(r.boards[1].refs).toEqual([{ id: "b1", t: "Tiling", k: "note", s: "Shared memory" }]);
    expect(r.recent).toEqual([]);
  });
  it("pushes the new list to a board that asked when another board saves, and nothing when it did not change", async () => {
    const v = views[0];
    const before = pushes(v).length;
    await store.update("bC", (b) => {
      b.cards.push({ id: "c2", kind: "note", md: "# Occupancy", look: "note" });
      b.place.c2 = { x: 0, y: 400, w: 300 };
    });
    await vi.waitFor(() => expect(pushes(v).length).toBe(before + 1), { timeout: 5000, interval: 5 });
    expect(
      pushes(v)
        .at(-1)!
        .refs.boards[0].refs.map((r) => r.t),
    ).toEqual(["Roofline", "Occupancy"]);
    // a save that changes no title: no push
    await store.update("bC", (b) => {
      b.place.c2.x = 50;
    });
    hub.refreshBoardRefs(true);
    expect(pushes(v).length).toBe(before + 1);
  });
  it("remembers the last three picked refs in the workspace, newest first, and pushes them", async () => {
    const p = hub.get("bA")!;
    for (const [b, id] of [
      ["bB", "b1"],
      ["bC", "c1"],
      ["bA", "a1"],
      ["bC", "c2"],
      ["bB", "b1"],
    ])
      await hub.handler(p, { type: "refPicked", b, id });
    expect(wsState.get("codeboard.refRecent")).toEqual([
      { b: "bB", id: "b1" },
      { b: "bC", id: "c2" },
      { b: "bA", id: "a1" },
    ]);
    hub.refreshBoardRefs(true);
    expect(pushes(views[0]).at(-1)!.refs.recent).toHaveLength(3);
  });
});
