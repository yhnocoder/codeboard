import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyBoard, type BoardMeta, type HostToBoard } from "@codeboard/core";
import { describe, expect, it } from "vitest";
import { assetsNamed, dirHash, drawn, pictureHash, rendererHash } from "../src/hash";

const meta = (id: string, name: string, cards = 1): BoardMeta => ({ id, name, cards });
function messages(o: { cam?: number; md?: string; others?: BoardMeta[]; welcome?: boolean } = {}): HostToBoard[] {
  const b = emptyBoard("b1", "Main");
  b.cam = { x: o.cam ?? 0, y: 0, z: 1 };
  b.cards.push({ id: "n1", kind: "note", md: o.md ?? "![](assets/a.png)", look: "note" });
  b.place.n1 = { x: 0, y: 0, w: 300 };
  b.cards.push({ id: "f1", kind: "board", board: "b2" });
  b.place.f1 = { x: 400, y: 0, w: 300, h: 200 };
  return [
    {
      type: "init",
      board: b,
      boards: [meta("b1", "Main"), meta("b2", "Sub"), ...(o.others ?? [meta("b3", "Elsewhere")])],
      views: {},
      stale: {},
      host: {} as Extract<HostToBoard, { type: "init" }>["host"],
      ...(o.welcome ? { welcome: { days: 3, open: 1 } } : {}),
    },
    { type: "sharedInfo", cards: {} },
  ];
}
const files = new Map<string, Uint8Array>([["a.png", new Uint8Array([1, 2, 3])]]);
const asset = (n: string) => files.get(n);

describe("picture hash", () => {
  const base = pictureHash("r1", messages(), asset);

  it("is 16 hex digits and the same for the same input", () => {
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(pictureHash("r1", messages(), asset)).toBe(base);
  });

  it("changes with the renderer, the board and the images it names", () => {
    expect(pictureHash("r2", messages(), asset)).not.toBe(base);
    expect(pictureHash("r1", messages({ md: "changed" }), asset)).not.toBe(base);
    expect(pictureHash("r1", messages(), () => new Uint8Array([9]))).not.toBe(base);
    expect(pictureHash("r1", messages({ others: [meta("b3", "Elsewhere")].map((m) => ({ ...m })) }), asset)).toBe(base);
  });

  it("changes when a board it shows is renamed", () => {
    const renamed = messages();
    const init = renamed[0] as Extract<HostToBoard, { type: "init" }>;
    init.boards = init.boards.map((m) => (m.id === "b2" ? { ...m, name: "Sub!" } : m));
    expect(pictureHash("r1", renamed, asset)).not.toBe(base);
  });

  it("ignores the camera, the welcome-back hint and boards it does not show", () => {
    expect(pictureHash("r1", messages({ cam: 500 }), asset)).toBe(base);
    expect(pictureHash("r1", messages({ welcome: true }), asset)).toBe(base);
    expect(pictureHash("r1", messages({ others: [meta("b3", "Renamed", 40), meta("b4", "New")] }), asset)).toBe(base);
  });
});

describe("drawn", () => {
  it("gives the board only the boards it names, the camera at the origin and no welcome", () => {
    const [init] = drawn(messages({ cam: 500, welcome: true }));
    if (init.type !== "init") throw new Error("init first");
    expect(init.boards.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(init.board.cam).toEqual({ x: 0, y: 0, z: 1 });
    expect("welcome" in init).toBe(false);
  });
});

describe("renderer hash", () => {
  it("reads every file of the built board", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiles-hash-"));
    fs.mkdirSync(path.join(dir, "chunks"));
    fs.writeFileSync(path.join(dir, "boot.js"), "a");
    fs.writeFileSync(path.join(dir, "chunks/x.js"), "b");
    const one = rendererHash(dir, "own");
    expect(rendererHash(dir, "own")).toBe(one);
    expect(rendererHash(dir, "other")).not.toBe(one);
    fs.writeFileSync(path.join(dir, "chunks/x.js"), "c");
    expect(rendererHash(dir, "own")).not.toBe(one);
    const d = dirHash(dir);
    fs.renameSync(path.join(dir, "chunks/x.js"), path.join(dir, "chunks/y.js"));
    expect(dirHash(dir)).not.toBe(d);
    fs.rmSync(dir, { recursive: true });
  });

  it("finds the images a recording names", () => {
    expect(assetsNamed('{"src":"assets/b.png","md":"![](assets/a.svg) assets/b.png"}')).toEqual([
      "assets/a.svg",
      "assets/b.png",
    ]);
  });
});
