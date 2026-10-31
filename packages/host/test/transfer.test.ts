import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBoard, type Board, type CodeCard, type Segment, type Source } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { useWorkspace } from "../src/ws";
import { copyToProject, freeName, otherProjects, recordProject, removeMoved, type Project } from "../src/transfer";
import { nodeWorkspace } from "./node-workspace";
import { tempRepo } from "./helpers";

const tmp: string[] = [];
const mk = (p: string) => {
  const d = fs.mkdtempSync(`/tmp/codeboard-${p}-`);
  tmp.push(d);
  return d;
};
/** 这个窗口的工作区（仓库 A）、目标项目的文件夹（B，里面有仓库 B/lib）、两边都不在的仓库 O */
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
const project = (folders: string | string[], dir: string): Project => {
  const fs = [folders].flat();
  return { folders: fs, name: path.basename(fs[0]), dir, seen: 0 };
};
const codeOf = (b: Board | null, id: string) => b?.cards.find((c) => c.id === id) as CodeCard | undefined;

beforeAll(() => {
  A = tempRepo("xa", { "x.py": "x = 1\n" });
  tmp.push(A);
  B = mk("xb");
  fs.mkdirSync(path.join(B, "lib"));
  fs.writeFileSync(path.join(B, "lib/x.py"), "x = 1\n");
  O = tempRepo("xo", { "x.py": "x = 1\n" });
  tmp.push(O);
  useWorkspace(nodeWorkspace(A));
});
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

describe("copy to another project", () => {
  it("brings the board, its sub-board, shared card, image and run record, and loads in the target", async () => {
    const src = mk("xsrc"),
      dst = mk("xdst");
    const store = new Storage(nodeFs, { dir: () => src });
    const S = emptyBoard("bSub", "Sub");
    put(S, code("k1", seg({ kind: "external", root: path.join(B, "lib") })));
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
    fs.writeFileSync(path.join(src, "runs/r1.json"), "{}");

    const t = await copyToProject(store, "bMain", project(B, dst));
    expect(t).toEqual({ id: "bMain", boards: ["bMain", "bSub"] });

    const there = new Storage(nodeFs, { dir: () => dst });
    const metas = await there.list();
    expect(metas.map((m) => [m.id, m.name, m.group]).sort()).toEqual([
      ["bMain", "Main", "g"],
      ["bSub", "Sub", "g"],
    ]);
    const m = await there.load("bMain");
    expect([...there.refsOf("bMain")]).toEqual(["sh"]);
    expect(fs.existsSync(path.join(dst, "cards/sh.json"))).toBe(true);
    // 仓库 A 不在目标项目里：外部路径
    expect(codeOf(m, "sh")?.segments[0].src).toEqual({ kind: "external", root: A });
    expect(fs.readFileSync(path.join(dst, "assets/abc123.png"), "utf8")).toBe("png");
    expect(fs.existsSync(path.join(dst, "assets/def456.png"))).toBe(true);
    expect(fs.existsSync(path.join(dst, "assets/unused.png"))).toBe(false);
    expect(fs.existsSync(path.join(dst, "runs/r1.json"))).toBe(true);
    // 子白板：B/lib 在目标项目的文件夹里，换成相对它的 repo
    expect(codeOf(await there.load("bSub"), "k1")?.segments[0].src).toEqual({ kind: "repo", repo: "lib" });
    // 这边一点没动
    expect(codeOf(await store.load("bMain"), "sh")?.segments[0].src).toEqual({ kind: "repo", repo: "" });
    expect(fs.existsSync(path.join(src, "g/bMain.json"))).toBe(true);
  });

  it("rewrites every segment: repo inside the target folder, outside roots, variants, merged cards and code sidenotes; leaves unknown repos alone", async () => {
    const src = mk("xsrc"),
      dst = mk("xdst");
    const store = new Storage(nodeFs, { dir: () => src });
    const b = emptyBoard("bV", "Variants");
    const c = code("v", seg({ kind: "external", root: B }));
    c.variants = [
      { id: "up", name: "Upstream", from: { kind: "upstream" } },
      {
        id: "w",
        name: "Mine",
        from: { kind: "worktree" },
        segs: [{ ...seg({ kind: "external", root: O }), id: c.segments[0].id }],
      },
    ];
    c.mergedFrom = [
      { card: code("old", seg({ kind: "external", root: path.join(B, "lib") })), place: { x: 0, y: 0, w: 300 } },
    ];
    put(b, c);
    put(b, code("gone", seg({ kind: "repo", repo: "no-such-dir" })), 500);
    put(b, code("gh", seg({ kind: "github", owner: "o", name: "n", ref: "main" })), 900);
    b.sidenotes.push({ id: "sn", kind: "code", at: { card: "v" }, code: seg({ kind: "repo", repo: "" }) });
    await store.save(b);

    await copyToProject(store, "bV", project(B, dst));
    const got = await new Storage(nodeFs, { dir: () => dst }).load("bV");
    const v = codeOf(got, "v")!;
    expect(v.segments[0].src).toEqual({ kind: "repo", repo: "" });
    expect(v.variants![1].segs![0].src).toEqual({ kind: "external", root: O });
    expect(v.mergedFrom![0].card.segments[0].src).toEqual({ kind: "repo", repo: "lib" });
    expect(codeOf(got, "gone")?.segments[0].src).toEqual({ kind: "repo", repo: "no-such-dir" });
    expect(codeOf(got, "gh")?.segments[0].src).toEqual({ kind: "github", owner: "o", name: "n", ref: "main" });
    const sn = got?.sidenotes.find((x) => x.id === "sn");
    expect(sn?.kind === "code" && sn.code.src).toEqual({ kind: "external", root: A });
    // 行号、路径不动
    expect(v.segments[0].path).toBe("x.py");
  });

  it("writes a repo in any folder of a multi-root target relative to its first folder, as that window adds code itself", async () => {
    const src = mk("xsrc"),
      dst = mk("xdst");
    const store = new Storage(nodeFs, { dir: () => src });
    const b = emptyBoard("bMR", "Multi-root");
    put(b, code("a", seg({ kind: "repo", repo: "" })));
    put(b, code("lib", seg({ kind: "external", root: path.join(B, "lib") })), 500);
    put(b, code("o", seg({ kind: "external", root: O })), 900);
    await store.save(b);

    // 目标窗口的文件夹：[B, A]，仓库 A 是第二个根
    await copyToProject(store, "bMR", project([B, A], dst));
    const got = await new Storage(nodeFs, { dir: () => dst }).load("bMR");
    expect(codeOf(got, "a")?.segments[0].src).toEqual({ kind: "repo", repo: path.relative(B, A) });
    expect(path.relative(B, A).startsWith("../")).toBe(true);
    expect(codeOf(got, "lib")?.segments[0].src).toEqual({ kind: "repo", repo: "lib" });
    expect(codeOf(got, "o")?.segments[0].src).toEqual({ kind: "external", root: O });
  });

  it("gives a board whose id the target already has a new id and points the parent's sub-board frame at it; keeps the target's shared card", async () => {
    const src = mk("xsrc"),
      dst = mk("xdst");
    const store = new Storage(nodeFs, { dir: () => src });
    const S = emptyBoard("bSub", "Sub");
    put(S, { id: "n1", kind: "note", md: "mine", look: "note" });
    const M = emptyBoard("bTop", "Top");
    put(M, { id: "fr", kind: "board", board: "bSub" });
    put(M, code("sh", seg({ kind: "repo", repo: "" })), 500);
    await store.save(S);
    await store.save(M);
    await store.share("bTop", ["sh"]);

    const there = new Storage(nodeFs, { dir: () => dst });
    const theirs = emptyBoard("bSub", "Their Sub");
    await there.save(theirs);
    const own = emptyBoard("bOwn", "Own");
    put(own, code("sh", seg({ kind: "repo", repo: "theirs" })));
    await there.save(own);
    await there.share("bOwn", ["sh"]);
    const card = fs.readFileSync(path.join(dst, "cards/sh.json"), "utf8");

    const t = await copyToProject(store, "bTop", project(B, dst));
    expect(t?.id).toBe("bTop");
    const after = new Storage(nodeFs, { dir: () => dst });
    const metas = await after.list();
    const sub = metas.find((m) => m.name === "Sub");
    expect(sub && sub.id).not.toBe("bSub");
    expect(metas.find((m) => m.id === "bSub")?.name).toBe("Their Sub");
    const top = await after.load("bTop");
    expect(top?.cards.find((c) => c.id === "fr")).toMatchObject({ kind: "board", board: sub!.id });
    // 那边卡库里已经有的共享卡不覆盖，拷过去的白板用那边的
    expect(fs.readFileSync(path.join(dst, "cards/sh.json"), "utf8")).toBe(card);
    expect(codeOf(top, "sh")?.segments[0].src).toEqual({ kind: "repo", repo: "theirs" });
  });
});

describe("move to another project", () => {
  it("puts the board in .trash, keeps sub-boards another board still embeds, and leaves shared card files", async () => {
    const src = mk("xsrc"),
      dst = mk("xdst");
    const store = new Storage(nodeFs, { dir: () => src });
    const S1 = emptyBoard("bS1", "Only here"),
      S2 = emptyBoard("bS2", "Also elsewhere");
    const M = emptyBoard("bM", "Moving"),
      K = emptyBoard("bK", "Keeps S2");
    put(M, { id: "f1", kind: "board", board: "bS1" });
    put(M, { id: "f2", kind: "board", board: "bS2" }, 500);
    put(M, code("sh", seg({ kind: "repo", repo: "" })), 900);
    put(K, { id: "f2", kind: "board", board: "bS2" });
    for (const b of [S1, S2, M, K]) await store.save(b);
    await store.share("bM", ["sh"]);

    const t = (await copyToProject(store, "bM", project(B, dst)))!;
    const closed: string[] = [];
    const gone = await removeMoved(store, t, (id) => closed.push(id));
    expect(gone.sort()).toEqual(["bM", "bS1"]);
    expect(closed.sort()).toEqual(["bM", "bS1"]);
    expect((await store.list()).map((m) => m.id).sort()).toEqual(["bK", "bS2"]);
    const trash = fs.readdirSync(path.join(src, ".trash"));
    expect(trash.some((f) => f.startsWith("bM."))).toBe(true);
    expect(trash.some((f) => f.startsWith("bS1."))).toBe(true);
    expect(fs.existsSync(path.join(src, "cards/sh.json"))).toBe(true);
    expect((await new Storage(nodeFs, { dir: () => dst }).list()).map((m) => m.id).sort()).toEqual([
      "bM",
      "bS1",
      "bS2",
    ]);
  });
});

describe("board names in the target", () => {
  it("suffixes a name the target already has with the first free number, across groups and boards moved together", async () => {
    const src = mk("xsrc"),
      dst = mk("xdst");
    const store = new Storage(nodeFs, { dir: () => src });
    const S = emptyBoard("bS", "Engine step");
    const M = emptyBoard("bM", "Engine step");
    put(M, { id: "fr", kind: "board", board: "bS" });
    await store.save(S);
    await store.save(M);
    const there = new Storage(nodeFs, { dir: () => dst });
    await there.save(emptyBoard("t1", "Engine step"));
    await there.save(emptyBoard("t3", "Engine step (3)"), { group: "Elsewhere" });
    await there.save(emptyBoard("t4", "Other"));

    await copyToProject(store, "bM", project(B, dst));
    const after = new Storage(nodeFs, { dir: () => dst });
    expect((await after.load("bM"))?.name).toBe("Engine step (2)");
    expect((await after.load("bS"))?.name).toBe("Engine step (4)");
    // 这边的名字不动；再拷一次接着往后数
    expect((await store.load("bM"))?.name).toBe("Engine step");
    const t = await copyToProject(store, "bM", project(B, dst));
    expect((await new Storage(nodeFs, { dir: () => dst }).load(t!.id))?.name).toBe("Engine step (5)");
    expect(freeName("Other (2)", new Set(["Other (2)", "Other"]))).toBe("Other (3)");
    expect(freeName("New", new Set(["Old"]))).toBe("New");
  });
});

describe("project registry", () => {
  it("lists other projects, newest first, without this one or ones whose folder is gone", async () => {
    const mem = new Map<string, unknown>();
    const state = {
      get: <T>(k: string) => mem.get(k) as T | undefined,
      set: async (k: string, v: unknown) => {
        mem.set(k, v);
      },
    };
    const here = path.join(mk("xhere"), "boards"),
      here2 = path.join(mk("xhere"), "boards");
    await recordProject(state, here);
    expect((mem.get("codeboard.projects") as Record<string, Project>)[here]).toMatchObject({
      folders: [A],
      name: path.basename(A),
    });
    mem.set("codeboard.projects", {
      ...(mem.get("codeboard.projects") as object),
      "/b": { folders: [B], name: "b", dir: "/b", seen: 2 },
      "/o": { folders: [O, B], name: "o", dir: "/o", seen: 3 },
      "/x": { folders: ["/tmp/codeboard-no-such-folder"], name: "x", dir: "/x", seen: 4 },
    });
    expect((await otherProjects(state, here)).map((p) => p.dir)).toEqual(["/o", "/b"]);
    expect(Object.keys(mem.get("codeboard.projects") as object).sort()).toEqual(["/b", "/o", here].sort());
    // 同一个文件夹换了存储目录：旧的那条换掉
    await recordProject(state, here2);
    expect(Object.keys(mem.get("codeboard.projects") as object).sort()).toEqual(["/b", "/o", here2].sort());
  });
});
