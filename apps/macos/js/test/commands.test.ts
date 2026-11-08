import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyBoard, type Board } from "@codeboard/core";
import { createBridge } from "../bridge";
import { nodeNative } from "./node-native";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function shell() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-mac-cmd-"));
  tmps.push(dir);
  const b = emptyBoard("b1", "Test");
  b.cards.push({ id: "n1", kind: "note", md: "# One\n\ntext", look: "note" });
  b.place.n1 = { x: 0, y: 0, w: 380 };
  b.cards.push({ id: "n2", kind: "note", md: "two", look: "text", size: "body" });
  b.place.n2 = { x: 600, y: 0, w: 380 };
  const { cam: _cam, ...file } = b as Board;
  fs.writeFileSync(path.join(dir, "b1.json"), JSON.stringify(file));
  const native = nodeNative();
  const folder = createBridge(native, { timers: false }).folder(dir);
  const open = async () => {
    const s = (await folder.open("b1"))!;
    await s.scene();
    return s;
  };
  return { open, dir, flush: () => folder.flush() };
}
const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "b1.json"), "utf8"));

describe("the app's commands", () => {
  it("a new Note written empty goes; written, it is one undo step with its text", async () => {
    const bridge = await shell().open();
    const id = bridge.cmd.newWriting("note", 100, 100);
    expect(bridge.board().place[id]).toMatchObject({ x: 100, y: 100 });
    bridge.cmd.settleUnwritten(id);
    expect(bridge.board().cards.some((c) => c.id === id)).toBe(false);
    const id2 = bridge.cmd.newWriting("note", 10, 10);
    bridge.cmd.writeNote(id2, "# Hello\n\nworld");
    expect(bridge.board().cards.find((c) => c.id === id2)).toMatchObject({ md: "# Hello\n\nworld" });
    await bridge.undo();
    expect(bridge.board().cards.some((c) => c.id === id2)).toBe(false);
  });

  it("copy, paste, duplicate, arrows, a Section, delete: each an undo step, all saved", async () => {
    const sh = shell(),
      dir = sh.dir;
    const bridge = await sh.open();
    const flush = sh.flush;
    expect(bridge.cmd.copy(["n1", "n2"])).toBe(2);
    const pasted = bridge.cmd.paste();
    expect(pasted.length).toBe(2);
    expect(bridge.board().place[pasted[0]]).toMatchObject({ x: 36, y: 36 });
    const dup = bridge.cmd.duplicate(["n1"]);
    expect(bridge.board().place[dup[0]]).toMatchObject({ x: 48, y: 48 });
    const l = bridge.cmd.addLink({ card: "n1" }, { card: "n2" });
    expect(bridge.board().links.map((k) => k.id)).toEqual([l]);
    const g = bridge.cmd.newSection(["n1", "n2"], {
      n1: { x: 0, y: 0, w: 380, h: 100 },
      n2: { x: 600, y: 0, w: 380, h: 100 },
    });
    expect(bridge.board().sections[0]).toMatchObject({ id: g, x: -22, y: -34, w: 1024 });
    expect(bridge.board().place.n1.section).toBe(g);
    bridge.cmd.renameSection(g!, "Intro");
    expect(bridge.board().sections[0].title).toBe("Intro");
    // deleting n2 takes the arrow with it
    bridge.cmd.delete(["n2"], [], []);
    expect(bridge.board().links.length).toBe(0);
    await flush();
    expect(read(dir).cards.length).toBe(4);
    for (let i = 0; i < 6; i++) await bridge.undo();
    expect(bridge.board().cards.length).toBe(2);
    expect(bridge.board().sections.length).toBe(0);
  });

  it("a resize is one gesture: live while dragging, one undo step at the end", async () => {
    const bridge = await shell().open();
    bridge.beginDrag();
    bridge.resize("n1", 400, null);
    bridge.resize("n1", 500, 200);
    // the width alone: the height stays (not dropped to the content's)
    bridge.resize("n1", 520, "keep");
    // core's rule: a Note no narrower than 160, a height no lower than 64
    bridge.resize("n1", 10, 10);
    expect(bridge.board().place.n1).toMatchObject({ w: 160, h: 64 });
    bridge.resize("n1", 520, 200);
    const ch = await bridge.endDrag([]);
    expect(ch.cards.map((c) => [c.id, c.w, c.h, c.fixed])).toEqual([["n1", 520, 200, true]]);
    // a locked card keeps its size
    bridge.beginDrag();
    bridge.board().place.n2.locked = true;
    bridge.resize("n2", 900, null);
    await bridge.endDrag([]);
    expect(bridge.board().place.n2.w).toBe(380);
    await bridge.undo();
    expect(bridge.board().place.n1).toMatchObject({ w: 380 });
    expect(bridge.cmd.textOf("n1")).toEqual({ kind: "note", text: "# One\n\ntext", look: "note" });
    expect(bridge.cmd.titles()).toEqual([
      { id: "n1", title: "One" },
      { id: "n2", title: "two" },
    ]);
  });

  it("the text handed over while editing is written as it comes, one undo step with the edit's end", async () => {
    const sh = shell(),
      dir = sh.dir;
    const bridge = await sh.open();
    const flush = sh.flush;
    bridge.cmd.writeNote("n1", "# One\n\ntext a");
    bridge.cmd.writeNote("n1", "# One\n\ntext ab");
    bridge.cmd.writeNote("n1", "# One\n\ntext abc");
    await flush();
    expect(read(dir).cards[0].md).toBe("# One\n\ntext abc");
    await bridge.undo();
    expect(bridge.cmd.textOf("n1")?.text).toBe("# One\n\ntext");
    expect((await bridge.redo()).cards[0].id).toBe("n1");
    expect(bridge.cmd.textOf("n1")?.text).toBe("# One\n\ntext abc");
  });

  it("new, pasted and dropped cards join the Section they lie in by core's rule; a new Section fits its cards", async () => {
    const bridge = await shell().open();
    const g = bridge.cmd.newSection(["n1"], { n1: { x: 0, y: 0, w: 380, h: 100 } });
    const s = bridge.board().sections.find((k) => k.id === g)!;
    // the board's Fit Content margins (core's SECTION_PAD: 22 at the sides, 34 above, 22 below)
    expect([s.x, s.y, s.w, s.h]).toEqual([-22, -34, 424, 156]);
    // more than a third of a new card inside the frame: it joins (core's homeFor), one outside does not
    const inside = bridge.cmd.newWriting("note", 10, 10, "in");
    const outside = bridge.cmd.newWriting("note", 2000, 2000, "out");
    expect(bridge.board().place[inside].section).toBe(g);
    expect(bridge.board().place[outside].section).toBeUndefined();
    bridge.beginDrag();
    await bridge.endDrag([{ id: outside, x: 20, y: 20, w: 380, h: 60 }]);
    expect(bridge.board().place[outside].section).toBe(g);
  });

  it("an image goes to assets/ and becomes an Image card no wider than a new card", async () => {
    const sh = shell();
    const bridge = await sh.open();
    const png = `data:image/png;base64,${Buffer.from("not really a png").toString("base64")}`;
    const id = await bridge.cmd.newImage("shot.png", png, 900, 50, 60);
    const c = bridge.board().cards.find((k) => k.id === id)!;
    expect(c.kind).toBe("image");
    expect(fs.existsSync(path.join(sh.dir, "assets", (c as { src: string }).src))).toBe(true);
    expect(bridge.board().place[id]).toMatchObject({ x: 50, y: 60, w: 381 });
  });

  it("Turn into Board stores the new board and leaves a sub-board card; undo takes it back", async () => {
    const sh = shell();
    const bridge = await sh.open();
    const frame = await bridge.cmd.turnIntoBoard(["n1", "n2"], "Pair", {
      n1: { x: 0, y: 0, w: 380, h: 120 },
      n2: { x: 600, y: 0, w: 380, h: 40 },
    });
    expect(frame).toBeTruthy();
    const card = bridge.board().cards.find((k) => k.id === frame) as { kind: string; board: string };
    expect(card.kind).toBe("board");
    expect(bridge.board().cards.map((k) => k.kind)).toEqual(["board"]);
    await sh.flush();
    const child = JSON.parse(fs.readFileSync(path.join(sh.dir, `${card.board}.json`), "utf8"));
    expect(child.name).toBe("Pair");
    expect(child.cards.map((k: { id: string }) => k.id).sort()).toEqual(["n1", "n2"]);
    await bridge.undo();
    expect(
      bridge
        .board()
        .cards.map((k) => k.id)
        .sort(),
    ).toEqual(["n1", "n2"]);
    // the child goes once Storage has checked it is still as made (asked by the undo, answered later)
    await vi.waitFor(() => expect(fs.existsSync(path.join(sh.dir, `${card.board}.json`))).toBe(false));
  });

  it("a new sub-board is an empty board of its own; a Section folds and opens again", async () => {
    const sh = shell();
    const bridge = await sh.open();
    const id = (await bridge.cmd.newSubboard("Inside", 10, 20)) as string;
    const card = bridge.board().cards.find((k) => k.id === id) as { kind: string; board: string };
    expect(card.kind).toBe("board");
    await sh.flush();
    expect(JSON.parse(fs.readFileSync(path.join(sh.dir, `${card.board}.json`), "utf8")).cards).toEqual([]);
    const g = bridge.cmd.newSection(["n1"], { n1: { x: 0, y: 0, w: 380, h: 100 } }) as string;
    const open = { x: -22, y: -34, w: 424, h: 156 };
    bridge.cmd.foldSection(g, true, open);
    expect(bridge.board().sections.find((k) => k.id === g)!.collapsed).toBe(true);
    bridge.cmd.foldSection(g, false, open);
    const s = bridge.board().sections.find((k) => k.id === g)!;
    expect([s.collapsed, s.x, s.y, s.w, s.h]).toEqual([undefined, -22, -34, 424, 156]);
  });

  it("stickers and text sidenotes come, change and go through core", async () => {
    const bridge = await shell().open();
    const k = bridge.cmd.addSticker({ pack: "emoji", name: "star" }, 5, 6);
    expect(bridge.board().stickers.find((s) => s.id === k.id)?.at).toMatchObject({ kind: "canvas", x: 5, y: 6 });
    bridge.cmd.deleteStickers([k.id]);
    expect(bridge.board().stickers).toEqual([]);
    // a question: fresh until written (written empty it was never asked); answered shows as done in the scene
    const q0 = bridge.cmd.newQuestion(1, 2);
    bridge.cmd.writeQuestion(q0, "  ");
    expect(bridge.board().stickers.find((s) => s.id === q0)).toBeUndefined();
    const q = bridge.cmd.newQuestion(1, 2);
    bridge.cmd.writeQuestion(q, "Why here?");
    bridge.cmd.setAnswered(q, true);
    const ch = await bridge.changes();
    expect(ch.stickers.find((s) => s.id === q)?.q).toEqual({ md: "Why here?", done: true });
    bridge.cmd.detachSticker(q, 40, 50);
    bridge.cmd.setStickerSize(q, 40);
    expect(bridge.board().stickers.find((s) => s.id === q)?.at).toMatchObject({ kind: "canvas", x: 40, y: 50, size: 40 });
    bridge.cmd.deleteStickers([q]);
    const n = bridge.cmd.addSidenote("n1", "why");
    bridge.cmd.writeSidenote(n, "because");
    expect(bridge.board().sidenotes.find((s) => s.id === n)).toMatchObject({ at: { card: "n1" }, md: "because" });
    expect(bridge.cmd.sidenotesOf("n1")).toEqual([{ id: n, md: "because" }]);
    bridge.cmd.deleteSidenote(n);
    expect(bridge.board().sidenotes).toEqual([]);
  });
});
