// CodeBoard's questions go to a dialog on the board they come from (its requests, a palette command while it is the active editor), and
// to VS Code's own input box / quick pick otherwise (the sidebar, a code editor)
import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyBoard, type HostToBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { BoardHub } from "../src/hub";
import { makeHandler } from "../src/handlers";
import { makeActions } from "../src/actions";
import { prompts } from "../src/prompts";
import type { HostEnv } from "../src/env";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { stubView } from "./helpers";

type Ask = Extract<HostToBoard, { type: "ask" }>;
const W = nodeWorkspace();
const vscodeAsked: string[] = [];
W.ui = { ...W.ui, input: async (o) => { vscodeAsked.push(o.prompt); return "From VS Code"; }, pick: async (items) => { vscodeAsked.push("pick"); return items[0]; } };
const views: ReturnType<typeof stubView>[] = [];
const env: HostEnv = {
  globalState: { get: () => undefined, set: async () => undefined },
  openView: () => { const v = stubView(); views.push(v); return v.view; },
};
const dir = fs.mkdtempSync("/tmp/codeboard-prompts-");
const store = new Storage(nodeFs, { dir: () => dir });
let hub: BoardHub;
const asks = () => views[0].posted.filter((m): m is Ask => m.type === "ask");
const answer = (id: number, value: string | number | null) => hub.handler(hub.get("bP")!, { type: "answer", id, value });
/** The next question posted to the board (after the board is given the keyboard) */
const nextAsk = (n: number) => vi.waitFor(() => { expect(asks().length).toBe(n); return asks().at(-1)!; });
const order: string[] = [];

beforeAll(async () => {
  useWorkspace(W);
  await store.save(emptyBoard("bP", "Prompts"));
  hub = new BoardHub(env, store);
  hub.handler = makeHandler(hub);
  const p = (await hub.show("bP"))!;
  p.ready = true;
  p.view.focus = async () => { order.push("focus"); };
  const post = p.view.postMessage;
  p.view.postMessage = (m) => { if (m.type === "ask") order.push("ask"); post(m); };
});
afterAll(() => { hub.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("prompts", () => {
  it("asks in a board dialog and resolves with the board's answer", async () => {
    const p = hub.get("bP")!;
    const typed = prompts(p).input({ title: "Capture Run", prompt: "Run a Python entry once", ok: "Run", value: "a.py" });
    const a = await nextAsk(1);
    expect(a.ask).toEqual({ kind: "text", title: "Capture Run", text: "Run a Python entry once", value: "a.py", placeholder: undefined, ok: "Run", password: undefined });
    await answer(a.id, "b.py --steps 2");
    expect(await typed).toBe("b.py --steps 2");

    const picked = prompts(p).pick([{ label: "$(layout) One", k: 1 }, { label: "Two", description: "$(folder) here", k: 2 }], { placeHolder: "Which?" });
    const b = await nextAsk(2);
    expect(b.ask).toEqual({ kind: "pick", title: "Which?", items: [{ label: "One", description: undefined, detail: undefined }, { label: "Two", description: "here", detail: undefined }] });
    await answer(b.id, 1);
    expect((await picked)?.k).toBe(2);
    expect(vscodeAsked).toEqual([]);
  });

  it("gives the board the keyboard first when it does not have it, then shows the dialog", async () => {
    const p = hub.get("bP")!;
    order.length = 0;
    await hub.handler(p, { type: "focus", has: false });
    const r = prompts(p).input({ prompt: "Name" });
    const a = await nextAsk(3);
    expect(order).toEqual(["focus", "ask"]);
    await answer(a.id, null);
    expect(await r).toBeUndefined();
    await hub.handler(p, { type: "focus", has: true });
    const r2 = prompts(p).input({ prompt: "Name" });
    await answer((await nextAsk(4)).id, null);
    await r2;
    expect(order).toEqual(["focus", "ask", "ask"]);
  });

  it("Rename Board from the palette over the board asks the board; from the sidebar it asks VS Code", async () => {
    const actions = makeActions(hub, store);
    const n = asks().length;
    const fromPalette = actions["codeboard.renameBoard"]();
    const a = await nextAsk(n + 1);
    expect(a.ask).toMatchObject({ kind: "text", title: "Rename Board", value: "Prompts", ok: "Rename" });
    await answer(a.id, "Renamed");
    await fromPalette;
    expect((await store.load("bP"))?.name).toBe("Renamed");

    await actions["codeboard.renameBoard"]({ kind: "board", id: "bP" });
    expect(asks().length).toBe(n + 1);
    expect(vscodeAsked).toEqual(["Rename board"]);
    expect((await store.load("bP"))?.name).toBe("From VS Code");
  });

  it("an open question is cancelled when the board closes", async () => {
    const r = prompts(hub.get("bP")!).input({ prompt: "Name" });
    await nextAsk(asks().length);
    views[0].dispose.fire();
    expect(await r).toBeUndefined();
  });
});
