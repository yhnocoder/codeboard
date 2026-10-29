import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  alignRows, wordDiff, mapLines, findBlock, diffLines, computeFlows, walkOrder, descendants, hiddenByCollapse, stampBorn, loadBoard, snapMove, align,
  cardRows, rowIndexOf, copyText, parseGithubUrl, classifyPaste, guessLang, migrateBoard, mergeOverlapping, sortSegments, emptyBoard, estSize, mdHeading,
  type Board, type CodeCard, type Link, type Segment, type SegView,
} from "../src";
import { initAnalysis, analyze, BLANK, COMMENT, DOCSTRING, type FileAnalysis } from "@codeboard/analysis";

// Uses the repo's nano-vllm submodule as test data
const repo = fileURLToPath(new URL("../../../examples/nano-vllm", import.meta.url));
const show = (rev: string, path: string) => execFileSync("git", ["-C", repo, "show", `${rev}:${path}`], { encoding: "utf8" });
const NEW = "bb823b3", OLD = "9e8507e";
const SCHED = "nanovllm/engine/scheduler.py", RUNNER = "nanovllm/engine/model_runner.py";

beforeAll(() => initAnalysis());

const sym = (a: FileAnalysis, q: string) => a.symbols.find((s) => s.qual === q)!;

describe("diff and alignment", () => {
  it("aligns prepare_prefill with prepare_decode side by side", () => {
    const an = analyze("python", show(NEW, RUNNER));
    const lines = show(NEW, RUNNER).split("\n");
    const pf = sym(an, "ModelRunner.prepare_prefill"), pd = sym(an, "ModelRunner.prepare_decode");
    const rows = alignRows(lines.slice(pf.start - 1, pf.end), lines.slice(pd.start - 1, pd.end));
    const same = rows.filter((r) => r.kind === "same").map((r) => lines[pf.start - 1 + r.l!].trim());
    expect(same).toContain("input_ids = []");
    expect(same).toContain("return input_ids, positions");
    expect(rows.some((r) => r.kind === "changed")).toBe(true);
  });
  it("marks changed words", () => {
    const w = wordDiff("    input_ids.extend(seq[start:end])", "    input_ids.append(seq.last_token)");
    expect(w.a.length).toBeGreaterThan(0);
    expect("    input_ids.extend(seq[start:end])".slice(...w.a[0])).toContain("extend");
  });
  it("maps lines across versions by content", () => {
    const o = show(OLD, SCHED).split("\n"), n = show(NEW, SCHED).split("\n");
    const so = sym(analyze("python", o.join("\n")), "Scheduler.schedule"), sn = sym(analyze("python", n.join("\n")), "Scheduler.schedule");
    const m = mapLines(o.slice(so.start - 1, so.end), so.start, n.slice(sn.start - 1, sn.end), sn.start);
    const ret = o.findIndex((l, i) => i >= so.start - 1 && l.includes("return scheduled_seqs, True")) + 1;
    expect(n[m.get(ret)! - 1]).toContain("return scheduled_seqs, True");
  });
  it("finds a block by content, or by first and last line", () => {
    const n = show(NEW, SCHED).split("\n");
    expect(findBlock(["x", ...n], n.slice(40, 43))).toEqual({ start: 42, end: 44 });
    const edited = [...n.slice(0, 41), "    # inserted", ...n.slice(41)];
    expect(findBlock(edited, n.slice(40, 45))).toEqual({ start: 41, end: 46 });
  });
  it("maps edited lines to their counterpart and skips only deleted ones", () => {
    const old = ["def f():", "    x = 1", "", "    y = 2", "    return x + y  # sum"];
    const now = ["def f():", "    x = 1", "    y = 2", "    return x + y  # total"];
    const m = mapLines(old, 10, now, 20);
    expect([10, 11, 12, 13, 14].map((l) => m.get(l))).toEqual([20, 21, undefined, 22, 23]);
  });
  it("diffs lines", () => {
    expect(diffLines(["a", "b"], ["a", "c"]).map((d) => d.op).join("")).toBe(" -+");
  });
});

const seg = (id: string, start = 1, end = 3): Segment => ({ id, src: { kind: "repo", repo: "" }, path: "a.py", lang: "python", start, end, text: [], version: { kind: "git", commit: "x" } });
const code = (id: string): CodeCard => ({ id, kind: "code", segments: [seg(`s${id}`, 1, 50)] });
const call = (from: string, line: number, to: string): Link => ({ id: `${from}-${to}`, from: { card: from, seg: `s${from}`, line }, to: { card: to }, call: { name: to, col: 0 } });
const plain = (from: string, to: string, line?: number): Link => ({ id: `p${from}-${to}`, from: { card: from, seg: line ? `s${from}` : undefined, line }, to: { card: to } });

describe("call graphs", () => {
  const board = (links: Link[], ids = ["a", "b", "c", "d", "e"]): Board => {
    const b: Board = { ...emptyBoard("b", "B"), cards: ids.map(code), links };
    stampBorn(b);
    return b;
  };
  it("one mark per graph, shown on every card in it; no numbering", () => {
    const f = computeFlows(board([call("a", 9, "b"), call("a", 3, "c"), call("b", 5, "d")]));
    expect(["a", "b", "c", "d"].map((id) => f.byId.get(id)!.label)).toEqual(["A", "A", "A", "A"]);
    expect(f.graphs).toHaveLength(1);
    expect(f.graphs[0].roots).toEqual(["a"]);
    expect(f.kids.get("a")!.map((l) => l.to.card)).toEqual(["c", "b"]); // by source line
    expect(f.byId.has("e")).toBe(false);
  });
  it("letters follow the creation order of each graph's oldest card, not b.cards order", () => {
    const b = board([call("c", 1, "d"), call("b", 1, "a")]);
    expect(computeFlows(b).byId.get("d")!.label).toBe("B");
    expect(computeFlows(b).byId.get("a")!.label).toBe("A"); // a and b are older than c and d
    b.cards.reverse(); // Arrange (send to back / bring to front) reorders b.cards
    expect(computeFlows(b).byId.get("d")!.label).toBe("B");
    expect(computeFlows(b).byId.get("a")!.label).toBe("A");
  });
  it("a card can have several callers; joining two graphs keeps the older graph's mark", () => {
    const b = board([call("a", 1, "b"), call("c", 1, "d")]);
    expect(computeFlows(b).byId.get("d")!.label).toBe("B");
    b.links.push(call("b", 2, "d")); // d is now called from c and from b
    const f = computeFlows(b);
    expect(f.graphs).toHaveLength(1);
    expect(["a", "b", "c", "d"].map((id) => f.byId.get(id)!.label)).toEqual(["A", "A", "A", "A"]);
    expect(f.parents.get("d")!.map((l) => l.from.card).sort()).toEqual(["b", "c"]);
    expect(f.graphs[0].roots.sort()).toEqual(["a", "c"]);
  });
  it("user marks are keyed by the graph's oldest card; auto letters skip the letters users took", () => {
    const b = board([call("a", 1, "b"), call("c", 1, "d")], ["a", "b", "c", "d", "e", "f"]);
    b.links.push(call("e", 1, "f"));
    b.marks = { c: { letter: "A" } };
    let f = computeFlows(b);
    expect(["a", "c", "e"].map((id) => f.byId.get(id)!.label)).toEqual(["B", "A", "C"]);
    expect(f.byId.get("c")!.custom).toBe(true);
    b.marks = { a: { icon: "star" } };
    f = computeFlows(b);
    expect(f.byId.get("b")!.mark).toEqual({ icon: "star" });
    expect(["a", "c", "e"].map((id) => f.byId.get(id)!.label)).toEqual(["", "A", "B"]);
    // joining: the younger graph's own mark yields to the older graph's
    b.marks = { c: { letter: "Z" } };
    b.links.push(call("b", 2, "c"));
    f = computeFlows(b);
    expect(f.byId.get("d")!.label).toBe("A");
  });
  it("cycles are allowed; self-calls do not make a graph", () => {
    const f = computeFlows(board([call("a", 1, "b"), call("b", 1, "a"), call("c", 1, "c")]));
    expect(f.graphs).toHaveLength(1);
    expect(f.graphs[0].roots).toEqual(["a"]);
    expect(f.byId.has("c")).toBe(false);
    expect(descendants(f, "a")).toEqual(["b"]);
  });
  it("Compare columns may sit in different graphs", () => {
    const b = board([call("a", 1, "p"), call("b", 1, "q")], ["a", "b", "p", "q"]);
    b.cards.push({ id: "k", kind: "compare", cols: ["p", "q"] });
    const f = computeFlows(b);
    expect([f.byId.get("p")!.label, f.byId.get("q")!.label]).toEqual(["A", "B"]);
  });
  it("walkthrough: Call arrows depth-first by source line, then plain arrows; visited once", () => {
    // step → schedule → alloc (calls), step → note (plain), alloc → step (call, a cycle)
    const ids = ["step", "schedule", "note", "alloc", "x"];
    const b = board([plain("step", "note", 2), call("step", 5, "schedule"), call("schedule", 3, "alloc"), call("alloc", 1, "step"), plain("note", "x")], ids);
    expect(walkOrder(b, "step")).toEqual(["step", "schedule", "alloc", "note", "x"]);
    expect(walkOrder(b, "schedule")).toEqual(["schedule", "alloc", "step", "note", "x"]);
    const c = board([call("a", 9, "b"), call("a", 3, "c"), call("b", 5, "d"), call("c", 1, "d")]);
    expect(walkOrder(c, "a")).toEqual(["a", "c", "d", "b"]);
  });
  it("collapse hides a card only when every call path from a root passes through a collapsed card", () => {
    const b = board([call("a", 1, "b"), call("b", 1, "c"), call("a", 2, "d"), call("d", 1, "c"), call("c", 1, "e")]);
    b.place.b = { x: 0, y: 0, w: 100, collapsed: true };
    expect([...hiddenByCollapse(b, computeFlows(b))]).toEqual([]); // c is still reachable through d
    b.place.d = { x: 0, y: 0, w: 100, collapsed: true };
    expect([...hiddenByCollapse(b, computeFlows(b))].sort()).toEqual(["c", "e"]);
    b.place.a = { x: 0, y: 0, w: 100, collapsed: true };
    b.place.b.collapsed = undefined; b.place.d.collapsed = undefined;
    expect([...hiddenByCollapse(b, computeFlows(b))].sort()).toEqual(["b", "c", "d", "e"]); // roots stay visible
  });
});

describe("snapping and align", () => {
  it("snaps the left edge to another card", () => {
    const r = snapMove({ x: 103, y: 300, w: 50, h: 50 }, [{ x: 100, y: 0, w: 80, h: 80 }], 6);
    expect(r.dx).toBe(-3);
    expect(r.guides[0]).toMatchObject({ axis: "x", at: 100 });
  });
  it("aligns left and distributes", () => {
    const m = align([{ id: "a", x: 10, y: 0, w: 10, h: 10 }, { id: "b", x: 30, y: 0, w: 10, h: 10 }, { id: "c", x: 100, y: 0, w: 10, h: 10 }], "hdist");
    expect(m.get("b")!.x).toBe(55);
  });
});

describe("cardRows", () => {
  const s: Segment = { ...seg("s1", 10, 16), text: ["def f():", '    """d"""', "    # c", "", "    x = 1", "    y = 2", "    return x"], hidden: [[15, 15]] };
  const v: SegView = { html: [], flags: [0, DOCSTRING, COMMENT, BLANK, 0, 0, 0], calls: [], defs: [{ line: 10, name: "f", qual: "f" }] };
  it("hides by flags with a dashed gutter, and manual hides become a gap bar", () => {
    const rows = cardRows({ segments: [s], hide: { comments: true, docstrings: true, blank: true } }, { views: { s1: v } });
    expect(rows).toEqual([
      { t: "line", seg: "s1", line: 10, skipped: false },
      { t: "line", seg: "s1", line: 14, skipped: true },
      { t: "gap", seg: "s1", from: 15, to: 15, manual: true },
      { t: "line", seg: "s1", line: 16, skipped: false },
    ]);
    expect(rowIndexOf(rows, "s1", 15)).toBe(2);
    expect(rowIndexOf(rows, "s1", 12)).toBe(1);
  });
  it("shows a temporarily expanded range", () => {
    const rows = cardRows({ segments: [s] }, { views: { s1: v }, shown: new Set(["s1:15"]) });
    expect(rows.filter((r) => r.t === "line").length).toBe(7);
  });
  it("separates segments by gap, function and file", () => {
    const a = { ...seg("a", 1, 2), scope: "A.f" }, b = { ...seg("b", 5, 6), scope: "A.f" }, c = { ...seg("c", 9, 9), scope: "A.g" }, d = { ...seg("d", 1, 1), path: "b.py" };
    const rows = cardRows({ segments: [a, b, c, d] });
    expect(rows.filter((r) => r.t !== "line").map((r) => r.t)).toEqual(["gap", "fn", "file"]);
  });
  it("marks every segment boundary, also where a segment starts with a definition", () => {
    // a card merged from get_context 18–19, set_context 21–23 and a set_context copy right after it
    const dv = (id: string, line: number, name: string): SegView => ({ html: [], flags: [], calls: [], defs: [{ line, name, qual: name }] });
    const g = seg("g", 18, 19), st = seg("st", 21, 23), t2 = seg("t2", 24, 25);
    const rows = cardRows({ segments: [g, st, t2] }, { views: { g: dv("g", 18, "get_context"), st: dv("st", 21, "set_context"), t2: dv("t2", 24, "reset_context") } });
    expect(rows.filter((r) => r.t !== "line")).toEqual([{ t: "gap", seg: "st", from: 20, to: 20, manual: false }, { t: "fn", seg: "t2", name: "reset_context" }]);
  });
  it("draws a function divider above a decorator, not between it and the def", () => {
    const d: Segment = { ...seg("d", 1, 6), text: ["x = 1", "", "@dataclass(slots=True)", "class Context:", "    a: int = 0", "    b: int = 0"] };
    const rows = cardRows({ segments: [d] }, { views: { d: { html: [], flags: [], calls: [], defs: [{ line: 4, name: "Context", qual: "Context" }] } } });
    expect(rows.map((r) => r.t === "line" ? r.line : r.t)).toEqual([1, 2, "fn", 3, 4, 5, 6]);
  });
  it("copies code without line numbers and keeps relative indent", () => {
    expect(copyText(["        while x:", "            y()"])).toBe("while x:\n    y()");
  });
});

describe("segments", () => {
  it("sorts by file with the target file first and merges overlaps", () => {
    const a = { ...seg("a", 10, 12), text: ["1", "2", "3"] }, b = { ...seg("b", 12, 14), text: ["3", "4", "5"] }, c = { ...seg("c", 1, 1), path: "0.py" };
    const sorted = sortSegments([c, b, a], "a.py");
    expect(sorted.map((s) => s.id)).toEqual(["a", "b", "c"]);
    const m = mergeOverlapping(sorted);
    expect(m[0]).toMatchObject({ start: 10, end: 14, text: ["1", "2", "3", "4", "5"] });
  });
});

describe("note title from its leading heading", () => {
  it("returns the text of a leading ATX heading, without inline marks", () => {
    expect(mdHeading("# KV cache budget\n\nPrefill first.")).toBe("KV cache budget");
    expect(mdHeading("\n\n  ## **Decode** `loop` ##\nbody")).toBe("Decode loop");
    expect(mdHeading("### [Scheduler](https://x.y/z) and _batching_")).toBe("Scheduler and batching");
    expect(mdHeading("# 异构并行计算")).toBe("异构并行计算");
  });
  it("is empty when the first non-blank line is not a heading", () => {
    expect(mdHeading("Just text\n# Later heading")).toBe("");
    expect(mdHeading("#hashtag")).toBe("");
    expect(mdHeading("")).toBe("");
    expect(mdHeading("\n  \n")).toBe("");
  });
});

describe("paste", () => {
  it("parses GitHub links with line ranges", () => {
    expect(parseGithubUrl("https://github.com/GeeeekExplorer/nano-vllm/blob/main/nanovllm/engine/scheduler.py#L25-L34")).toEqual({
      owner: "GeeeekExplorer", name: "nano-vllm", ref: "main", path: "nanovllm/engine/scheduler.py", start: 25, end: 34,
    });
  });
  it("classifies clipboard text", () => {
    expect(classifyPaste("https://github.com/a/b/blob/main/x.py#L3").kind).toBe("github");
    expect(classifyPaste("https://arxiv.org/abs/2309.06180").kind).toBe("web");
    expect(classifyPaste("为什么 prefill 优先\n有新请求时这一步只做 prefill。").kind).toBe("note");
    expect(classifyPaste("idx = tl.program_id(0)\nslot = tl.load(slot_mapping_ptr + idx)")).toEqual({ kind: "code", lang: "python" });
    expect(guessLang("__global__ void k(float* x) {\n  int i = threadIdx.x;\n}")).toBe("cuda-cpp");
  });
  it("tells the common languages apart", () => {
    const cases: [string, string][] = [
      ["void vecAdd(float* A_h, float* B_h, float* C_h, int n) {\n    for (int i = 0; i < n; ++i) {\n        C_h[i] = A_h[i] + B_h[i];\n    }\n}", "c"],
      ["#include <stdio.h>\nint main(void) {\n  printf(\"hi\\n\");\n  return 0;\n}", "c"],
      ["#include <vector>\nstd::vector<int> v;\nfor (auto x : v) {\n  std::cout << x;\n}", "cpp"],
      ["template <typename T>\nT add(T a, T b) {\n  return a + b;\n}", "cpp"],
      ["def schedule(self, seqs):\n    for s in seqs:\n        if s.done:\n            return None", "python"],
      ["const add = (a, b) => a + b;\nconsole.log(add(1, 2));", "javascript"],
      ["function add(a: number, b: number): number {\n  return a + b;\n}", "typescript"],
      ["interface Card {\n  id: string;\n}", "typescript"],
      ["fn main() {\n    let mut v = Vec::new();\n    println!(\"{}\", v.len());\n}", "rust"],
      ["package main\nimport \"fmt\"\nfunc main() {\n\tx := 1\n\tfmt.Println(x)\n}", "go"],
      ["#!/bin/bash\nset -e\ncd build\nmake -j8\necho \"done $HOME\"", "shellscript"],
      ["pip install -e .\ngit clone https://github.com/a/b", "shellscript"],
    ];
    for (const [code, lang] of cases) expect([code, guessLang(code)]).toEqual([code, lang]);
  });
});

describe("migrateBoard", () => {
  it("turns a v1 board into v7", () => {
    const b = migrateBoard({ id: "b", name: "x", cam: { x: 0, y: 0, z: 1 }, version: 1,
      cards: [{ id: "c1", type: "code", x: 0, y: 0, w: 500, path: "a.py", start: 1, end: 2, lang: "python", snapshot: ["a", "b"], commit: "abc", hl: [2], symbol: "f" }],
      edges: [{ id: "e", from: { card: "c1", line: 2 }, to: { card: "c1" }, kind: "call" }] });
    expect(b.version).toBe(9);
    expect(b.links[0].call).toEqual({ name: "f", col: 0 });
    const c = b.cards[0] as CodeCard;
    expect(c.segments[0]).toMatchObject({ path: "a.py", start: 1, end: 2, hl: [2], symbol: { qual: "f" } });
    expect(b.place.c1).toEqual({ x: 0, y: 0, w: 500 });
    expect(b.links[0].from.seg).toBe(c.segments[0].id);
  });
  it("splits v2 cards into content and placement; Compare references its columns", () => {
    const col = (id: string) => ({ id, kind: "code", x: 5, y: 6, w: 300, segments: [seg(`s${id}`)] });
    const b = migrateBoard({
      version: 2, id: "b", name: "x", cam: { x: 0, y: 0, z: 1 }, sections: [{ id: "g", title: "G", x: 0, y: 0, w: 10, h: 10 }], sidenotes: [],
      cards: [
        { id: "a", kind: "code", x: 1, y: 2, w: 400, h: 90, section: "g", locked: true, collapsed: true, title: "T", segments: [seg("sa")] },
        { id: "k", kind: "compare", x: 10, y: 20, w: 900, cols: [col("p"), col("q")], swap: true },
        { id: "w", kind: "web", x: 0, y: 0, w: 300, url: "https://x.org", pageTitle: "X" },
        { id: "i", kind: "image", x: 0, y: 0, w: 300, src: "a.png" },
      ],
      links: [{ id: "l", kind: "plain", from: { card: "a" }, to: { card: "w" } }],
    });
    expect(b.place.a).toEqual({ x: 1, y: 2, w: 400, h: 54, section: "g", locked: true, collapsed: true }); // v4: code area only
    expect(b.cards.find((c) => c.id === "a")).toEqual({ id: "a", kind: "code", title: "T", segments: [seg("sa")] });
    expect(b.cards.find((c) => c.id === "k")).toEqual({ id: "k", kind: "compare", cols: ["p", "q"], swap: true });
    expect(b.cards.map((c) => c.id)).toEqual(["a", "p", "q", "k", "w", "i"]);
    expect(b.place.p).toBeUndefined();
    expect(b.place.k).toEqual({ x: 10, y: 20, w: 900 });
    expect(b.cards.find((c) => c.id === "w")).toEqual({ id: "w", kind: "web", url: "https://x.org", meta: { title: "X" } });
    expect(b.cards.find((c) => c.id === "i")).toMatchObject({ bg: true });
    expect(b.links[0]).toEqual({ id: "l", from: { card: "a" }, to: { card: "w" }, style: { head: { end: false } } }); // old plain links had no arrowhead
    expect(b.stickers).toEqual([]);
    expect(migrateBoard(structuredClone(b))).toEqual(b);
  });
  it("image cards keep no height: it follows the image's aspect ratio", () => {
    const b = migrateBoard({ version: 6, id: "b", name: "x", cam: { x: 0, y: 0, z: 1 }, cards: [{ id: "i", kind: "image", src: "a.png" }, { id: "n", kind: "note", md: "x", bg: true }],
      place: { i: { x: 1, y: 2, w: 300, h: 300 }, n: { x: 0, y: 0, w: 200, h: 90 } } });
    expect(b.place.i).toEqual({ x: 1, y: 2, w: 300 });
    expect(b.place.n.h).toBe(90);
  });
  it("arrows into a card inside a sub-board card attach to the sub-board card itself; a lost mark that came from that card goes", () => {
    const raw = {
      version: 7, id: "b", name: "x", cam: { x: 0, y: 0, z: 1 },
      cards: [code("a"), { id: "f", kind: "board", board: "S" }], place: { a: { x: 0, y: 0, w: 400 }, f: { x: 600, y: 0, w: 500, h: 300 } },
      links: [
        { id: "c", from: { card: "a", seg: "sa", line: 3 }, to: { card: "f", sub: "inner" }, call: { name: "g", col: 0 } },
        { id: "gone", from: { card: "a" }, to: { card: "f", sub: "deleted" }, lost: { to: true } },
        { id: "both", from: { card: "a", seg: "sa", line: 9 }, to: { card: "f", sub: "deleted" }, lost: { from: true, to: true } },
      ],
    };
    const b = loadBoard(structuredClone(raw));
    expect(b.links).toEqual([
      { id: "c", from: { card: "a", seg: "sa", line: 3 }, to: { card: "f" }, call: { name: "g", col: 0 } },
      { id: "gone", from: { card: "a" }, to: { card: "f" } },
      { id: "both", from: { card: "a", seg: "sa", line: 9 }, to: { card: "f" }, lost: { from: true } },
    ]);
    const { cam: _cam, ...file } = b;
    expect(migrateBoard(structuredClone(b))).toEqual(file);
  });
  it("v3 → v4: code cards store the code area height (minus the 36px Warm Ink header), other cards keep theirs", () => {
    const a = { id: "a", kind: "code", segments: [seg("sa")], mergedFrom: [{ card: { id: "m", kind: "code", segments: [seg("sm")] }, place: { x: 0, y: 0, w: 300, h: 200 } }] };
    const raw = {
      version: 3, id: "b", name: "x", cam: { x: 0, y: 0, z: 1 },
      cards: [a, { id: "z", kind: "code", segments: [seg("sz")] }, { id: "n", kind: "note", md: "x" }],
      place: { a: { x: 0, y: 0, w: 400, h: 300 }, z: { x: 0, y: 0, w: 400 }, n: { x: 0, y: 0, w: 300, h: 120 } },
    };
    const b = migrateBoard(structuredClone(raw));
    expect(b.version).toBe(9);
    expect(b.place.a.h).toBe(264);
    expect(b.place.z.h).toBeUndefined();
    expect(b.place.n.h).toBe(120);
    expect((b.cards[0] as CodeCard).mergedFrom![0].place.h).toBe(164);
    expect(migrateBoard(structuredClone(b))).toEqual(b); // v8 is read as is
    expect(estSize(b.cards[0] as CodeCard, b.place.a).h).toBe(300); // estimates still count the header
  });
  it("v4 → v5: call links become Call-marked arrows, plain links keep their look", () => {
    const raw = {
      version: 4, id: "b", name: "x", cam: { x: 0, y: 0, z: 1 }, sections: [], sidenotes: [], stickers: [],
      cards: [code("a"), code("b"), { id: "n", kind: "note", md: "x", bg: true }],
      place: { a: { x: 0, y: 0, w: 1 }, b: { x: 0, y: 0, w: 1 }, n: { x: 0, y: 0, w: 1 } },
      links: [
        { id: "c", kind: "call", from: { card: "a", seg: "sa", line: 3 }, to: { card: "b" }, call: { name: "g", col: 8 }, vars: [{ a: "x", b: "y" }], cands: [{ a: "x", b: "y" }, { a: "r", ret: true }], loop: true, label: "hot", at: 0.3, side: "left" },
        { id: "p1", kind: "plain", from: { card: "n" }, to: { card: "a", seg: "sa", line: 2 }, arrow: "both", solid: false, color: "blue" },
        { id: "p2", kind: "plain", from: { card: "a", seg: "sa", line: 1 }, to: { card: "n" }, arrow: "end", side: "right" },
        { id: "p3", kind: "plain", from: { card: "a" }, to: { card: "n" } },
      ],
    };
    const b = loadBoard(structuredClone(raw));
    expect(b.version).toBe(9);
    expect(b.links).toEqual([
      { id: "c", from: { card: "a", seg: "sa", line: 3 }, to: { card: "b" }, label: "hot", at: 0.3, sides: { from: "left" }, call: { name: "g", col: 8, vars: [{ a: "x", b: "y" }], cands: [{ a: "x", b: "y" }, { a: "r", ret: true }], loop: true } },
      { id: "p1", from: { card: "n" }, to: { card: "a", seg: "sa", line: 2 }, style: { dash: true, head: { start: true }, color: "blue" } },
      { id: "p2", from: { card: "a", seg: "sa", line: 1 }, to: { card: "n" }, sides: { from: "right" } },
      { id: "p3", from: { card: "a" }, to: { card: "n" } },
    ]);
    expect(b.links.every((l) => !("kind" in l))).toBe(true);
    const { cam: _cam, ...file } = b;
    expect(migrateBoard(structuredClone(b))).toEqual(file);
  });
  it("v4 → v5 keeps every flow letter, and Arrange no longer changes them", () => {
    // Old letters: trees ordered by their root's place in b.cards; a child card earlier in b.cards than its root (r2's child k) must not change that
    const ids = ["k", "x", "r1", "c1", "r2", "y"];
    const old = (from: string, to: string, line = 1) => ({ id: `${from}-${to}`, kind: "call", from: { card: from, seg: `s${from}`, line }, to: { card: to } });
    const raw = {
      version: 4, id: "b", name: "x", cam: { x: 0, y: 0, z: 1 }, sections: [], sidenotes: [], stickers: [], place: {},
      cards: ids.map(code), links: [old("r1", "c1"), old("r2", "k"), old("r2", "x", 2)],
    };
    const b = loadBoard(structuredClone(raw));
    let f = computeFlows(b);
    expect(["r1", "c1", "r2", "k", "x"].map((id) => f.byId.get(id)!.label)).toEqual(["A", "A", "B", "B", "B"]);
    expect(f.graphs.map((g) => g.id)).toEqual(["r1", "r2"]); // the old root is the graph's oldest card
    b.cards = [b.cards[4], ...b.cards.filter((_, i) => i !== 4)]; // r2 sent to back (it used to become A)
    f = computeFlows(b);
    expect(["r1", "r2"].map((id) => f.byId.get(id)!.label)).toEqual(["A", "B"]);
    // a card added later is younger than everything migrated
    b.cards.push(code("z"));
    stampBorn(b);
    expect(b.born!.z).toBe(6);
  });
  it("fills what the current types require: nulls, missing title / lang, false-only flags, corner stickers", () => {
    const raw = {
      version: 6, id: "b", name: "x", cam: { x: 0, y: 0, z: 1 }, hideNumbers: null,
      cards: [{ ...code("a"), title: null, segments: [{ ...seg("sa"), lang: undefined }] }, { id: "n", kind: "note", md: "x" }],
      place: { a: { x: 0, y: 0, w: 400, h: null } },
      sections: [{ id: "g", x: 0, y: 0, w: 1, h: 1 }],
      links: [{ id: "l", from: { card: "a" }, to: { card: "n" }, gen: false, back: false, style: { dash: false } }],
      stickers: [0, 1].map((i) => ({ id: `k${i}`, icon: { pack: "builtin", name: "star" }, at: { kind: "card", card: "a" }, q: { md: "", done: false } })),
    };
    const b = loadBoard(raw);
    expect("hideNumbers" in b || "title" in b.cards[0] || "h" in b.place.a).toBe(false);
    expect((b.cards[0] as CodeCard).segments[0].lang).toBe("plaintext");
    expect(b.cards[1]).toMatchObject({ look: "text" });
    expect(b.sections[0].title).toBe("");
    expect(b.links[0]).toEqual({ id: "l", from: { card: "a" }, to: { card: "n" }, style: {} });
    expect(b.stickers.map((k) => k.at)).toEqual([
      { kind: "canvas", x: 344, y: -11, size: 22, on: { card: "a" } },
      { kind: "canvas", x: 319, y: -11, size: 22, on: { card: "a" } },
    ]);
    expect(b.stickers[0].q).toEqual({ md: "" });
  });
  it("refuses a board written by a newer CodeBoard", () => {
    expect(() => migrateBoard({ version: 10, id: "b", name: "x", cards: [] })).toThrow(/newer/);
  });
});
