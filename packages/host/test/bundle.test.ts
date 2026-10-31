import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import {
  BOARD_VERSION,
  emptyBoard,
  type Board,
  type CodeCard,
  type RunRecord,
  type Segment,
  type Source,
} from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { useWorkspace } from "../src/ws";
import { BundleError, LIMITS, importBundle, importFile, packBoards, readBundle, type Manifest } from "../src/bundle";
import { nodeWorkspace } from "./node-workspace";
import { tempRepo } from "./helpers";

const tmp: string[] = [];
const mk = (p: string) => {
  const d = fs.mkdtempSync(`/tmp/codeboard-${p}-`);
  tmp.push(d);
  return d;
};
/** A = 导出那边的工作区，B = 导入这边的工作区（同一个仓库的另一份），O = 两边都不在的仓库 */
let A: string, B: string, O: string;
let n = 0;

const seg = (src: Source, p = "x.py"): Segment => ({
  id: `s${++n}`,
  src,
  path: p,
  lang: "python",
  start: 1,
  end: 1,
  text: ["x = 1"],
  version: { kind: "none" },
});
const code = (id: string, ...segs: Segment[]): CodeCard => ({ id, kind: "code", segments: segs });
const put = (b: Board, c: Board["cards"][number], x = 0) => {
  b.cards.push(c);
  b.place[c.id] = { x, y: 0, w: 400, ...(c.kind === "board" ? { h: 300 } : {}) };
};
const codeOf = (b: Board | null, id: string) => b?.cards.find((c) => c.id === id) as CodeCard | undefined;
const run = (id: string): RunRecord => ({
  version: 1,
  id,
  entry: "python x.py",
  cwd: "/w",
  commit: null,
  at: 1,
  ms: 1,
  exit: 0,
  scope: ["/w"],
  pkgs: [],
  calls: [],
});
const files = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => path.relative(dir, path.join(d.parentPath, d.name)))
        .sort()
    : [];

/** 导出那边的存储：Main（组 g）带共享卡、图片卡、引用图片的 Note、子白板框、运行记录；Sub 里一张 B 里的外部来源 */
async function source(): Promise<Storage> {
  const src = mk("bsrc");
  const store = new Storage(nodeFs, { dir: () => src });
  const S = emptyBoard("bSub", "Sub");
  put(S, code("k1", seg({ kind: "external", root: path.join(B, "lib") })));
  put(S, code("k2", seg({ kind: "external", root: O })), 500);
  const M = emptyBoard("bMain", "Main");
  const shared = code("sh", seg({ kind: "repo", repo: "" }));
  shared.gen = { what: "CUDA source", run: "r1" };
  put(M, shared);
  put(M, { id: "img", kind: "image", src: "abc123.png" }, 500);
  put(M, { id: "note", kind: "note", md: "see ![x](assets/def456.png)", look: "note" }, 900);
  put(M, { id: "fr", kind: "board", board: "bSub" }, 1300);
  await store.save(S, { group: "g" });
  await store.save(M, { group: "g" });
  await store.share("bMain", ["sh"]);
  fs.mkdirSync(path.join(src, "assets"));
  fs.writeFileSync(path.join(src, "assets/abc123.png"), "png");
  fs.writeFileSync(path.join(src, "assets/def456.png"), "png2");
  fs.writeFileSync(path.join(src, "assets/unused.png"), "nope");
  fs.mkdirSync(path.join(src, "runs"));
  fs.writeFileSync(path.join(src, "runs/r1.json"), JSON.stringify(run("r1")));
  await store.save(emptyBoard("bOther", "Not exported"));
  return store;
}

const manifest = (o: Partial<Manifest> = {}): Uint8Array =>
  strToU8(
    JSON.stringify({
      format: 1,
      codeboard: "t",
      exported: "",
      folders: [],
      boards: [{ id: "bX", name: "X" }],
      groups: [],
      ...o,
    }),
  );
const boardFile = (id: string, name = "X") =>
  strToU8(JSON.stringify({ ...emptyBoard(id, name), version: BOARD_VERSION }));
const zip = (z: Zippable) => zipSync(z);

beforeAll(() => {
  A = tempRepo("ba", { "x.py": "x = 1\n" });
  tmp.push(A);
  B = tempRepo("bb", { "x.py": "x = 1\n", "lib/x.py": "x = 1\n" });
  tmp.push(B);
  O = tempRepo("bo", { "x.py": "x = 1\n" });
  tmp.push(O);
});
afterEach(() => {
  Object.assign(LIMITS, { file: 256 << 20, entry: 64 << 20, total: 512 << 20, entries: 20_000 });
});
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

describe("export boards", () => {
  it("writes a zip with a manifest, the board and its sub-board in their group, the shared card, used images and run records", async () => {
    useWorkspace(nodeWorkspace(A));
    const store = await source();
    const r = (await packBoards(store, ["bMain"]))!;
    const z = unzipSync(r.data);
    expect(Object.keys(z).sort()).toEqual([
      "assets/abc123.png",
      "assets/def456.png",
      "cards/sh.json",
      "g/bMain.json",
      "g/bSub.json",
      "manifest.json",
      "runs/r1.json",
    ]);
    const m = JSON.parse(strFromU8(z["manifest.json"])) as Manifest;
    expect(m).toMatchObject({ format: 1, codeboard: "test", folders: [path.basename(A)], groups: ["g"] });
    expect(m.boards).toEqual([
      { id: "bMain", name: "Main", group: "g" },
      { id: "bSub", name: "Sub", group: "g", sub: true },
    ]);
    // 来源原样带走，白板文件里只有共享卡的引用
    const main = JSON.parse(strFromU8(z["g/bMain.json"]));
    expect(main.cards.find((c: { id: string }) => c.id === "sh").kind).toBe("shared");
    // 当前版本的白板文件，镜头不在里面（每台机器自己记）
    expect(main.version).toBe(BOARD_VERSION);
    expect(main.cam).toBeUndefined();
    expect(JSON.parse(strFromU8(z["cards/sh.json"])).card.segments[0].src).toEqual({ kind: "repo", repo: "" });
    // 这边一点没动
    expect(files(store.dir())).toContain("g/bMain.json");
  });

  it("leaves out images that are missing on disk and still imports the board", async () => {
    useWorkspace(nodeWorkspace(A));
    const store = await source();
    fs.rmSync(path.join(store.dir(), "assets/abc123.png"));
    const r = (await packBoards(store, ["bMain"]))!;
    expect(Object.keys(unzipSync(r.data))).not.toContain("assets/abc123.png");
    useWorkspace(nodeWorkspace(B));
    const dstDir = mk("bdst"),
      dst = new Storage(nodeFs, { dir: () => dstDir });
    const got = await importBundle(dst, r.data);
    expect(got.boards).toBe(2);
    expect((await dst.load("bMain"))?.cards.find((c) => c.id === "img")).toMatchObject({
      kind: "image",
      src: "abc123.png",
    });
    expect(files(path.join(dst.dir(), "assets"))).toEqual(["def456.png"]);
  });
});

describe("import boards", () => {
  it("round-trips into another workspace: boards in their group, sub-board frame, shared card, images, runs; sources rewritten to this workspace", async () => {
    useWorkspace(nodeWorkspace(A));
    const r = (await packBoards(await source(), ["bMain"]))!;
    const file = path.join(mk("bfile"), "Main.codeboard");
    fs.writeFileSync(file, r.data);

    useWorkspace(nodeWorkspace(B));
    const dstDir = mk("bdst");
    const dst = new Storage(nodeFs, { dir: () => dstDir });
    const got = await importFile(dst, file);
    expect(got).toMatchObject({ first: "bMain", boards: 2, renamed: 0 });
    expect(files(dstDir)).toEqual([
      "assets/abc123.png",
      "assets/def456.png",
      "cards/sh.json",
      "g/bMain.json",
      "g/bSub.json",
      "runs/r1.json",
    ]);

    const there = new Storage(nodeFs, { dir: () => dstDir });
    expect((await there.list()).map((m) => [m.id, m.name, m.group]).sort()).toEqual([
      ["bMain", "Main", "g"],
      ["bSub", "Sub", "g"],
    ]);
    const main = await there.load("bMain");
    expect([...there.refsOf("bMain")]).toEqual(["sh"]);
    // repo 来源相对这边的主根（同一个仓库的另一份）；B 里的外部来源换成 repo；哪边都不在的仓库还是外部路径
    expect(codeOf(main, "sh")?.segments[0].src).toEqual({ kind: "repo", repo: "" });
    expect(codeOf(main, "sh")?.gen?.run).toBe("r1");
    expect(main?.cards.find((c) => c.id === "fr")).toMatchObject({ kind: "board", board: "bSub" });
    const sub = await there.load("bSub");
    expect(codeOf(sub, "k1")?.segments[0].src).toEqual({ kind: "repo", repo: "lib" });
    expect(codeOf(sub, "k2")?.segments[0].src).toEqual({ kind: "external", root: O });
    expect(fs.readFileSync(path.join(dstDir, "assets/abc123.png"), "utf8")).toBe("png");
  });

  it("gives boards whose id this project has a new id, points the parent's frame at it, and keeps this project's shared cards, images and names", async () => {
    useWorkspace(nodeWorkspace(A));
    const r = (await packBoards(await source(), ["bMain"]))!;

    useWorkspace(nodeWorkspace(B));
    const dstDir = mk("bdst");
    const dst = new Storage(nodeFs, { dir: () => dstDir });
    await dst.save(emptyBoard("bSub", "Their Sub"));
    await dst.save(emptyBoard("bTheirs", "Main"));
    const own = emptyBoard("bOwn", "Own");
    put(own, code("sh", seg({ kind: "repo", repo: "theirs" })));
    await dst.save(own);
    await dst.share("bOwn", ["sh"]);
    fs.mkdirSync(path.join(dstDir, "assets"));
    fs.writeFileSync(path.join(dstDir, "assets/abc123.png"), "theirs");
    const card = fs.readFileSync(path.join(dstDir, "cards/sh.json"), "utf8");

    const got = await importBundle(dst, r.data);
    expect(got.first).toBe("bMain");
    expect(got.renamed).toBe(2);
    const after = new Storage(nodeFs, { dir: () => dstDir });
    const metas = await after.list();
    const sub = metas.find((m) => m.name === "Sub")!;
    expect(sub.id).not.toBe("bSub");
    expect(metas.find((m) => m.id === "bSub")?.name).toBe("Their Sub");
    expect(metas.find((m) => m.id === "bMain")?.name).toBe("Main (2)");
    const main = await after.load("bMain");
    expect(main?.cards.find((c) => c.id === "fr")).toMatchObject({ kind: "board", board: sub.id });
    expect(fs.readFileSync(path.join(dstDir, "cards/sh.json"), "utf8")).toBe(card);
    expect(codeOf(main, "sh")?.segments[0].src).toEqual({ kind: "repo", repo: "theirs" });
    expect(fs.readFileSync(path.join(dstDir, "assets/abc123.png"), "utf8")).toBe("theirs");

    // 再导入一次：又是一份新的
    const again = await importBundle(dst, r.data);
    expect(again.first).not.toBe("bMain");
    expect((await dst.load(again.first))?.name).toBe("Main (3)");
  });

  describe("rejects a package and writes nothing", () => {
    const bad: [string, () => Uint8Array, RegExp][] = [
      [
        "a parent-directory entry",
        () => zip({ "manifest.json": manifest(), "bX.json": boardFile("bX"), "../evil.json": boardFile("evil") }),
        /Unexpected file “\.\.\/evil\.json”/,
      ],
      [
        "an absolute entry",
        () => zip({ "manifest.json": manifest(), "bX.json": boardFile("bX"), "/etc/evil.json": boardFile("evil") }),
        /Unexpected file/,
      ],
      [
        "a traversal inside assets",
        () => zip({ "manifest.json": manifest(), "bX.json": boardFile("bX"), "assets/../../x.png": strToU8("x") }),
        /Unexpected file/,
      ],
      [
        "a backslash path",
        () => zip({ "manifest.json": manifest(), "bX.json": boardFile("bX"), "cards\\..\\x.json": strToU8("{}") }),
        /Unexpected file/,
      ],
      [
        "a nested folder",
        () => zip({ "manifest.json": manifest(), "bX.json": boardFile("bX"), "g/h/bY.json": boardFile("bY") }),
        /Unexpected file/,
      ],
      [
        "a dot folder",
        () => zip({ "manifest.json": manifest(), "bX.json": boardFile("bX"), ".trash/bY.json": boardFile("bY") }),
        /Unexpected file/,
      ],
      [
        "an unknown file",
        () => zip({ "manifest.json": manifest(), "bX.json": boardFile("bX"), "run.sh": strToU8("rm -rf /") }),
        /Unexpected file/,
      ],
      ["no manifest", () => zip({ "bX.json": boardFile("bX") }), /no manifest\.json/],
      ["not a zip", () => strToU8("hello"), /Not a CodeBoard package/],
      [
        "a newer package format",
        () => zip({ "manifest.json": manifest({ format: 99 }), "bX.json": boardFile("bX") }),
        /newer CodeBoard/,
      ],
      [
        "a board listed but missing",
        () =>
          zip({
            "manifest.json": manifest({
              boards: [
                { id: "bX", name: "X" },
                { id: "bY", name: "Y" },
              ],
            }),
            "bX.json": boardFile("bX"),
          }),
        /“Y” \(bY\) is listed/,
      ],
      [
        "a board that fails the schema",
        () =>
          zip({
            "manifest.json": manifest(),
            "bX.json": strToU8(JSON.stringify({ version: BOARD_VERSION, id: "bX", name: 3, cards: "no" })),
          }),
        /“bX\.json”/,
      ],
      [
        "a board whose file name is another id",
        () => zip({ "manifest.json": manifest(), "bX.json": boardFile("bZ") }),
        /holds board “bZ”/,
      ],
      [
        "a bad shared card next to a good board",
        () => zip({ "manifest.json": manifest(), "bX.json": boardFile("bX"), "cards/c1.json": strToU8('{"card":1}') }),
        /“cards\/c1\.json”/,
      ],
      [
        "a bad run record",
        () => zip({ "manifest.json": manifest(), "bX.json": boardFile("bX"), "runs/r1.json": strToU8("{}") }),
        /“runs\/r1\.json”: Invalid run record/,
      ],
    ];
    for (const [what, make, msg] of bad) {
      it(what, async () => {
        useWorkspace(nodeWorkspace(B));
        const dstDir = mk("bdst");
        const dst = new Storage(nodeFs, { dir: () => dstDir });
        await expect(importBundle(dst, make())).rejects.toThrow(msg);
        await expect(importBundle(dst, make())).rejects.toBeInstanceOf(BundleError);
        expect(files(dstDir)).toEqual([]);
      });
    }

    it("an entry larger than the limit, by its header and by what it inflates to", async () => {
      const data = zip({
        "manifest.json": manifest(),
        "bX.json": boardFile("bX"),
        "assets/big.png": new Uint8Array(4096),
      });
      LIMITS.entry = 1024;
      expect(() => readBundle(data)).toThrow(/“assets\/big\.png” is larger than/);
      LIMITS.entry = 64 << 20;
      LIMITS.total = 2048;
      expect(() => readBundle(data)).toThrow(/contents are larger than/);
      LIMITS.total = 512 << 20;
      LIMITS.file = 100;
      expect(() => readBundle(data)).toThrow(/file is larger than/);
    });
  });

  it("a package renamed to .zip and one with folder entries imports the same", async () => {
    useWorkspace(nodeWorkspace(B));
    const data = zip({ "manifest.json": manifest(), "bX.json": boardFile("bX"), "assets/": new Uint8Array(0) });
    const file = path.join(mk("bfile"), "X.zip");
    fs.writeFileSync(file, data);
    const dstDir = mk("bdst"),
      dst = new Storage(nodeFs, { dir: () => dstDir });
    expect((await importFile(dst, file)).first).toBe("bX");
  });
});
