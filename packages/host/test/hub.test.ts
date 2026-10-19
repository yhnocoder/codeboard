// Board coordination without an editor: BoardHub keeps the open boards through HostEnv (views, cross-workspace state) and the
// workspace's own storage
import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { BoardHub } from "../src/hub";
import type { HostEnv } from "../src/env";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { startTreeSitter, stubView } from "./helpers";

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
    hub.opened("bA");
    expect(hub.lastOpened("bA")).toBeGreaterThan(Date.now() - 1000);
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
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(["skeletons"]);
    expect(views[0].posted.find((m) => m.type === "reply")).toEqual({ type: "reply", req: 7, data: { ok: 1 } });
  });
});
