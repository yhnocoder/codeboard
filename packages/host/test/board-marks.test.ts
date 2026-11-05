// Board Marks: another board's Mark changed from a board or the sidebar, and the board list (with the Marks) pushed again
import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyBoard, type Board, type HostToBoard, type InputOpts } from "@codeboard/core";
import { Storage } from "../src/storage/boards";
import { nodeFs } from "../src/storage/nodefs";
import { BoardHub } from "../src/hub";
import { makeHandler } from "../src/handlers";
import { editSealPrompt } from "../src/seals";
import type { HostEnv } from "../src/env";
import { nodeWorkspace } from "./node-workspace";
import { stubView, MEDIA } from "./helpers";
import { HostContext } from "../src/context";

const W = nodeWorkspace();
const mem = new Map<string, unknown>();
W.storage = {
  ...W.storage,
  get: <T>(k: string) => mem.get(k) as T,
  set: async (k, v) => {
    mem.set(k, v);
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
const dir = fs.mkdtempSync("/tmp/codeboard-marks-");
const store = new Storage(nodeFs, { dir: () => dir });
let cx: HostContext, hub: BoardHub;
const off: { dispose(): void }[] = [];

/** pmpp ⊃ Convolution, Compute architecture and scheduling */
function frameTo(b: Board, sub: string) {
  b.cards.push({ id: `f-${sub}`, kind: "board", board: sub });
  b.place[`f-${sub}`] = { x: 0, y: b.cards.length * 300, w: 400 };
}
beforeAll(async () => {
  cx = new HostContext(W);
  const pmpp = emptyBoard("pmpp", "pmpp");
  frameTo(pmpp, "conv");
  frameTo(pmpp, "comp");
  await store.save(pmpp);
  await store.save({ ...emptyBoard("conv", "Convolution"), seal: { text: "CNN" } });
  await store.save(emptyBoard("comp", "Compute architecture and scheduling"));
  hub = new BoardHub(cx, env, store, (h) => makeHandler(cx, h, MEDIA));
  // as startHost wires it: the board list goes to every board when it changes
  off.push(store.onDidChange(() => void hub.pushBoards()));
});
afterAll(() => {
  for (const d of off) d.dispose();
  hub.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

const boardsPushed = (v: ReturnType<typeof stubView>) =>
  v.posted.filter((m): m is Extract<HostToBoard, { type: "boards" }> => m.type === "boards");

describe("board marks", () => {
  it("lists each board's Mark with the boards", async () => {
    const metas = await hub.metas();
    expect(metas.find((m) => m.id === "conv")?.seal).toEqual({ text: "CNN" });
    expect(metas.find((m) => m.id === "comp")?.seal).toBeUndefined();
  });

  it("writes a closed board's Mark asked for by another board, and pushes the boards with it", async () => {
    const p = (await hub.show("pmpp"))!;
    p.ready = true;
    const v = views[0];
    await hub.handler(p, { type: "setSeal", board: "comp", seal: { text: "CompArch", color: "ink" } });
    expect((await store.load("comp"))?.seal).toEqual({ text: "CompArch", color: "ink" });
    const file = JSON.parse(fs.readFileSync(store.fileOf("comp")!, "utf8"));
    expect(file.seal).toEqual({ text: "CompArch", color: "ink" });
    await vi.waitFor(
      () =>
        expect(
          boardsPushed(v)
            .at(-1)
            ?.boards.find((m) => m.id === "comp")?.seal,
        ).toEqual(file.seal),
      { timeout: 5000, interval: 5 },
    );
    // back to the defaults: the field goes from the file
    await hub.handler(p, { type: "setSeal", board: "comp", seal: null });
    expect((await store.load("comp"))?.seal).toBeUndefined();
  });

  it("hands an open board's Mark to that board instead of writing its file", async () => {
    const p = (await hub.show("pmpp"))!;
    const q = (await hub.show("conv"))!;
    q.ready = true;
    const v = views.find((x) => x.view === q.view)!;
    await hub.handler(p, { type: "setSeal", board: "conv", seal: { text: "Conv" } });
    expect(v.posted.at(-1)).toEqual({ type: "setSeal", seal: { text: "Conv" } });
    expect((await store.load("conv"))?.seal).toEqual({ text: "CNN" });
  });

  it("refuses a Mark that breaks the limits", async () => {
    const p = (await hub.show("pmpp"))!;
    await expect(
      hub.handler(p, { type: "setSeal", board: "comp", seal: { text: "far too long a mark" } }),
    ).rejects.toThrow(/Invalid mark/);
    expect((await store.load("comp"))?.seal).toBeUndefined();
  });

  it("asks for the text and colour in the editor's own boxes from the sidebar, warning about a clash in the book", async () => {
    hub.get("conv")?.view.dispose();
    const asked: InputOpts[] = [];
    const ui = W.ui;
    W.ui = {
      ...ui,
      input: async (o) => {
        asked.push(o);
        return " Mem & Data ";
      },
      pick: async (items) => items.find((x) => x.label === "Use Default"),
    };
    try {
      await editSealPrompt(hub, "comp");
    } finally {
      W.ui = ui;
    }
    expect(asked[0].value).toBe("CAS");
    expect(asked[0].check?.("CNN")).toEqual({ message: "“Convolution” also uses CNN", warn: true });
    expect(asked[0].check?.("abcdefghijklmn")?.warn).toBeUndefined();
    expect(asked[0].check?.("Mem&Data")).toBeUndefined();
    // the default colour is not stored
    expect((await store.load("comp"))?.seal).toEqual({ text: "Mem&Data" });
  });
});
