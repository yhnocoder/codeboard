import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { createRequire } from "node:module";
import * as path from "node:path";
import { blockSig, type Board, type Card, emptyBoard } from "@codeboard/core";
import { createBridge } from "../bridge";
import { installGlobals, type Native } from "../native";
import { nodeNative } from "./node-native";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-mac-"));
  tmps.push(d);
  return d;
}

/** A board file written the way the extension writes it, with n Note and Code cards in a grid and an arrow between the first two */
function writeBoard(dir: string, n: number, id = "b1"): Board {
  const b = emptyBoard(id, "Test");
  for (let i = 0; i < n; i++) {
    const cid = `c${i}`;
    const card: Card =
      i % 2
        ? { id: cid, kind: "note", md: `# Note ${i}\n\nSome **text** here.`, look: "note" }
        : {
            id: cid,
            kind: "code",
            segments: [
              {
                id: `s${i}`,
                src: { kind: "free" },
                path: "",
                lang: "python",
                start: 1,
                end: 3,
                text: ["def f(x):", "    return x + 1", "f(2)"],
                version: { kind: "none" },
              },
            ],
          };
    b.cards.push(card);
    b.place[cid] = { x: (i % 16) * 440, y: Math.floor(i / 16) * 320, w: 380 };
  }
  if (n >= 2) b.links.push({ id: "l1", from: { card: "c0", seg: "s0", line: 2 }, to: { card: "c1" } });
  const { cam: _cam, ...file } = b;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(file, null, 1));
  return b;
}

/** The tree-sitter grammars in one folder, as the app's Resources has them */
function wasmDir() {
  const d = tmpDir();
  const req = createRequire(import.meta.url);
  for (const f of ["tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-rust.wasm"])
    fs.copyFileSync(req.resolve(`@vscode/tree-sitter-wasm/wasm/${f}`), path.join(d, f));
  fs.copyFileSync(
    req.resolve("@yhnocoder/tree-sitter-cuda/tree-sitter-cuda.wasm"),
    path.join(d, "tree-sitter-cuda.wasm"),
  );
  return d;
}

function shell(dir: string, wasm?: string) {
  const native = nodeNative();
  const bridge = createBridge(native, { timers: false, wasmDir: wasm });
  bridge.init(dir);
  return { native, bridge };
}
const at = (id: string, x: number, y: number) => ({ id, x, y, w: 380, h: 160 });

const readFile = (dir: string, id = "b1") => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));

describe("bridge", () => {
  it("lists, opens and builds a scene with coloured code and routed arrows", async () => {
    const dir = tmpDir();
    writeBoard(dir, 4);
    const { bridge } = shell(dir);
    const list = await bridge.list();
    expect(list.map((m) => [m.id, m.cards])).toEqual([["b1", 4]]);
    const sc = await bridge.open("b1");
    expect(sc?.cards.length).toBe(4);
    const code = sc!.cards.find((c) => c.kind === "code")!;
    expect(code.h).toBe(36 + 6 + 3 * 20 + 8);
    expect(code.segments![0].lines[0].toks.some(([t, cls]) => t.trim() === "def" && cls === "kw")).toBe(true);
    const rects = Object.fromEntries(sc!.cards.map((c) => [c.id, { x: c.x, y: c.y, w: c.w, h: c.h ?? 160 }]));
    const [g] = bridge.route(rects);
    expect(g.id).toBe("l1");
    expect(g.d.startsWith("M")).toBe(true);
    expect(g.taper?.length).toBeGreaterThan(10);
    expect(g.head?.startsWith("M")).toBe(true);
    // the line end sits on row 2 of the code card: head 36 + 6 above + one row + half a row
    expect(g.pts[1]).toBeCloseTo(36 + 6 + 20 + 10, 5);
  });

  it("a drag is one undo step, saved to the same file the extension reads", async () => {
    const dir = tmpDir();
    writeBoard(dir, 3);
    const { bridge, native } = shell(dir);
    await bridge.open("b1");
    bridge.beginDrag();
    bridge.drag([{ id: "c1", x: 10, y: 20 }]);
    bridge.drag([{ id: "c1", x: 100, y: 200 }]);
    const ch = await bridge.endDrag([at("c1", 100, 200)]);
    expect(ch.cards.map((c) => [c.id, c.x, c.y])).toEqual([["c1", 100, 200]]);
    expect(ch.gone.cards).toEqual([]);
    expect(native.events.filter((e) => e.name === "stacks").at(-1)?.data).toEqual({ undo: true, redo: false });
    await bridge.flush();
    expect(readFile(dir).place.c1).toMatchObject({ x: 100, y: 200 });
    expect(readFile(dir).cam).toBeUndefined();
    const back = await bridge.undo();
    expect(back.cards.map((c) => [c.id, c.x, c.y])).toEqual([["c1", 440, 0]]);
    await bridge.flush();
    expect(readFile(dir).place.c1).toMatchObject({ x: 440, y: 0 });
    const again = await bridge.redo();
    expect(again.cards[0]).toMatchObject({ id: "c1", x: 100, y: 200 });
  });

  it("two shells editing the same board at once merge without losing either change", async () => {
    const dir = tmpDir();
    writeBoard(dir, 4);
    const a = shell(dir),
      b = shell(dir);
    await a.bridge.open("b1");
    await b.bridge.open("b1");
    // A (the Mac app) moves c0, B (VS Code) moves c3 and renames c1, before either writes
    a.bridge.beginDrag();
    a.bridge.drag([{ id: "c0", x: 1, y: 2 }]);
    await a.bridge.endDrag([at("c0", 1, 2)]);
    b.bridge.beginDrag();
    b.bridge.drag([{ id: "c3", x: 3, y: 4 }]);
    await b.bridge.endDrag([at("c3", 3, 4)]);
    b.bridge.mutate((bb) => {
      bb.cards[1].title = "Renamed";
    });
    await a.bridge.flush();
    // B learns of A's write the way the watcher tells it, then writes its own: a three-way merge
    const file = path.join(dir, "b1.json");
    for (const [id] of b.native.watchers) b.bridge.fsChanged(id, file);
    await b.bridge.flush();
    const disk = readFile(dir);
    expect(disk.place.c0).toMatchObject({ x: 1, y: 2 });
    expect(disk.place.c3).toMatchObject({ x: 3, y: 4 });
    expect(disk.cards[1].title).toBe("Renamed");
    // and A, told of B's write, shows B's changes as a sync (no undo step of its own)
    for (const [id] of a.native.watchers) a.bridge.fsChanged(id, file);
    await new Promise((r) => setTimeout(r, 50));
    const changed = a.native.events.filter((e) => e.name === "changed").at(-1)?.data as { cards: { id: string }[] };
    expect(changed.cards.map((c) => c.id).sort()).toEqual(["c1", "c3"]);
    expect(a.bridge.board().place.c3).toMatchObject({ x: 3, y: 4 });
    expect(a.bridge.board().place.c0).toMatchObject({ x: 1, y: 2 });
  });

  it("the M1 gate: one edit on a 250-card board in 2 ms (p95)", async () => {
    const dir = tmpDir();
    writeBoard(dir, 250);
    const { bridge } = shell(dir);
    await bridge.open("b1");
    const ids = Object.keys(bridge.board().place);
    const times: number[] = [];
    for (let i = 0; i < 300; i++) {
      const id = ids[i % ids.length];
      const t0 = performance.now();
      bridge.mutate((bb) => {
        bb.place[id].x += 1;
      });
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`edit on 250 cards: p50 ${times[150].toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
    expect(p95).toBeLessThan(2);
    await bridge.flush();
  });

  it("colours C and CUDA through tree-sitter, like VS Code", async () => {
    const dir = tmpDir();
    const b = writeBoard(dir, 0);
    b.cards.push({
      id: "k",
      kind: "code",
      segments: [
        {
          id: "sk",
          src: { kind: "free" },
          path: "",
          lang: "cuda-cpp",
          start: 1,
          end: 2,
          text: ["__global__ void add(int *a) {", "  return; // done"],
          version: { kind: "none" },
        },
      ],
    });
    b.place.k = { x: 0, y: 0, w: 380 };
    const { cam: _cam, ...file } = b;
    fs.writeFileSync(path.join(dir, "b1.json"), JSON.stringify(file));
    const { bridge } = shell(dir, wasmDir());
    const sc = await bridge.open("b1");
    const lines = sc!.cards[0].segments![0].lines;
    expect(lines[0].toks.some(([t, cls]) => t === "void" && cls === "kw")).toBe(true);
    expect(lines[0].toks.some(([t, cls]) => t === "add" && cls === "fn")).toBe(true);
    expect(lines[1].toks.some(([t, cls]) => t.startsWith("//") && cls === "com")).toBe(true);
  });

  it("an arrow on a Note's block follows the block when the Note is edited", async () => {
    const dir = tmpDir();
    const b = writeBoard(dir, 2);
    const note = b.cards[1] as Extract<Card, { kind: "note" }>;
    note.md = "# T\n\npara one\n\npara two";
    b.links[0].to = { card: "c1", block: { i: 2, h: blockSig("para two") } };
    const { cam: _cam, ...file } = b;
    fs.writeFileSync(path.join(dir, "b1.json"), JSON.stringify(file));
    const { bridge } = shell(dir);
    await bridge.open("b1");
    bridge.mutate((bb) => {
      (bb.cards[1] as typeof note).md = "# T\n\nnew first\n\npara one\n\npara two";
    });
    expect(bridge.board().links[0].to.block).toEqual({ i: 3, h: blockSig("para two") });
    await bridge.flush();
    expect(readFile(dir).links[0].to.block.i).toBe(3);
  });

  it("a dropped card joins the Section it lands in, and leaves it when dropped outside", async () => {
    const dir = tmpDir();
    const b = writeBoard(dir, 2);
    b.sections.push({ id: "S", title: "S", x: 2000, y: 2000, w: 1000, h: 1000 });
    const { cam: _cam, ...file } = b;
    fs.writeFileSync(path.join(dir, "b1.json"), JSON.stringify(file));
    const { bridge } = shell(dir);
    await bridge.open("b1");
    bridge.beginDrag();
    bridge.drag([{ id: "c0", x: 2100, y: 2100 }]);
    const ch = await bridge.endDrag([at("c0", 2100, 2100)]);
    expect(ch.cards[0]).toMatchObject({ id: "c0", section: "S" });
    bridge.beginDrag();
    bridge.drag([{ id: "c0", x: 0, y: 0 }]);
    await bridge.endDrag([at("c0", 0, 0)]);
    expect(bridge.board().place.c0.section).toBeUndefined();
    bridge.undo();
    expect(bridge.board().place.c0.section).toBe("S");
  });

  it("cameras go to the shell's store, not the board file", async () => {
    const dir = tmpDir();
    writeBoard(dir, 1);
    const { bridge, native } = shell(dir);
    await bridge.open("b1");
    bridge.cam({ x: 5, y: 6, z: 2 });
    await bridge.flush();
    expect(JSON.parse(native.camGet("b1")!)).toEqual({ x: 5, y: 6, z: 2 });
    expect(readFile(dir).cam).toBeUndefined();
  });

  it("setTimeout's extra arguments do not make it repeat", () => {
    const set: [number, number][] = [];
    const g: Record<string, unknown> = {};
    const native = {
      setTimer: (id: number, ms: number) => set.push([id, ms]),
      cancelTimer: () => {},
    } as unknown as Native;
    const { fire } = installGlobals(native, g);
    let n = 0;
    const id = (g.setTimeout as (fn: () => void, ms: number, extra: string) => number)(() => n++, 5, "extra");
    fire(id);
    fire(id);
    expect(n).toBe(1);
    expect(set).toEqual([[id, 5]]);
  });
});
