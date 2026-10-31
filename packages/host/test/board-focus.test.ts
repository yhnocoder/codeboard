// The board's "focus" messages drive the editor's key context for the board's own keys
import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { BoardHub } from "../src/hub";
import { makeHandler } from "../src/handlers";
import type { HostEnv } from "../src/env";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { stubView } from "./helpers";

const W = nodeWorkspace();
const keyContext: boolean[] = [];
W.ui = {
  ...W.ui,
  boardFocusKey: async (on) => {
    keyContext.push(on);
  },
};
const views: ReturnType<typeof stubView>[] = [];
const env: HostEnv = {
  globalState: { get: () => undefined, set: async () => undefined },
  openView: () => {
    const v = stubView();
    views.push(v);
    return v.view;
  },
};
const dir = fs.mkdtempSync("/tmp/codeboard-focus-");
const store = new Storage(nodeFs, { dir: () => dir });
let hub: BoardHub;
const focus = (has: boolean) => hub.handler(hub.get("bF")!, { type: "focus", has });

beforeAll(async () => {
  useWorkspace(W);
  await store.save(emptyBoard("bF", "F"));
  hub = new BoardHub(env, store);
  hub.handler = makeHandler(hub);
  (await hub.show("bF"))!.ready = true;
});
afterAll(() => {
  hub.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("board focus", () => {
  it("sets the key context when a board gets or loses the keyboard", async () => {
    await focus(true);
    await focus(false);
    expect(keyContext).toEqual([true, false]);
  });
});
