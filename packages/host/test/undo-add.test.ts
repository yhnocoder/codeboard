import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { makeActions } from "../src/actions";
import { BoardPanel, type BoardHost } from "../src/boards";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";
import { startTreeSitter, stubView } from "./helpers";

const W = nodeWorkspace();
const dir = fs.mkdtempSync("/tmp/codeboard-undoadd-");
const store = new Storage(nodeFs, { dir: () => dir });
let open: BoardPanel | undefined;
const panels = {
  store,
  target: "bU",
  get: (id: string) => (id === "bU" ? open : undefined),
  all: () => (open ? [open] : []),
  setTarget: () => undefined,
  show: async () => open,
} as unknown as BoardHost;
// each notice waits until the user clicks: hold them and click Undo later
const notices: ((r: string | undefined) => void)[] = [];
// the other messages (Removed from …) are recorded: the closed board's undo shows one once its file is written
const infos: string[] = [];
W.ui.info = ((msg: string) =>
  msg.startsWith("Added")
    ? new Promise((r) => notices.push(r as (r: string | undefined) => void))
    : (infos.push(msg), Promise.resolve(undefined))) as typeof W.ui.info;
const quals = async () =>
  ((await store.load("bU"))?.cards ?? []).map((c) => (c.kind === "code" ? c.segments[0].symbol?.qual : c.id));
const sched = path.join(WS, "nanovllm/engine/scheduler.py");

beforeAll(async () => {
  useWorkspace(W);
  await startTreeSitter();
  await store.save(emptyBoard("bU", "Undo Add"));
  const acts = makeActions(panels, store);
  await acts["codeboard.addSymbol"](sched, "Scheduler.postprocess"); // board closed: written to the file
  await acts["codeboard.addSymbol"](sched, "Scheduler.schedule");
  // later work on the board (saved while it was open)
  const later = (await store.load("bU"))!;
  later.cards.push({ id: "nLater", kind: "note", md: "later work", look: "note" });
  later.place.nLater = { x: 0, y: 900, w: 200 };
  await store.save(later);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Undo on an add notice", () => {
  it("removes only that card when the board is closed; later work stays", async () => {
    expect(notices).toHaveLength(2);
    notices[0]("Undo");
    await vi.waitFor(() => expect(infos).toContain("Removed from “Undo Add”"), { timeout: 10000, interval: 5 });
    expect(await quals()).toEqual(["Scheduler.schedule", "nLater"]);
  });
  it("asks the board to remove that card when the board is open (its own undo step), without rewriting the file", async () => {
    const { view, posted } = stubView({ visible: false, active: false });
    open = new BoardPanel("bU", view, panels);
    open.ready = true;
    open.board = store.peek("bU");
    const id = (await store.load("bU"))!.cards[0].id;
    notices[1]("Undo");
    await vi.waitFor(
      () => expect(posted.find((m) => m.type === "undoAdd")).toMatchObject({ type: "undoAdd", cards: [id] }),
      { timeout: 10000, interval: 5 },
    );
    expect((await store.load("bU"))!.cards).toHaveLength(2);
  });
});
