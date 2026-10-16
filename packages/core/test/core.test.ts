import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  alignRows, wordDiff, mapLines, findBlock, diffLines, computeFlows, walkOrder, canAttach, canExpand, canCompare, hiddenByCollapse, snapMove, align,
  cardRows, rowIndexOf, copyText, parseGithubUrl, classifyPaste, guessLang, migrateBoard, mergeOverlapping, sortSegments, emptyBoard,
  type Board, type Card, type CodeCard, type Link, type Segment, type SegView,
} from "../src";
import { initAnalysis, analyze, planSelection, varCandidates, symbolAt, pyprojectScripts, initExports, BLANK, COMMENT, DOCSTRING, type FileAnalysis } from "../src/analysis";

// Uses the repo's nano-vllm submodule as test data
const repo = fileURLToPath(new URL("../../../examples/nano-vllm", import.meta.url));
const show = (rev: string, path: string) => execFileSync("git", ["-C", repo, "show", `${rev}:${path}`], { encoding: "utf8" });
const NEW = "bb823b3", OLD = "9e8507e";
const SCHED = "nanovllm/engine/scheduler.py", RUNNER = "nanovllm/engine/model_runner.py", ENGINE = "nanovllm/engine/llm_engine.py";

beforeAll(() => initAnalysis());

const sym = (a: FileAnalysis, q: string) => a.symbols.find((s) => s.qual === q)!;

describe("analyze (python)", () => {
  it("finds methods with qualified names, decorators and signatures", () => {
    const a = analyze("python", show(NEW, SCHED));
    const s = sym(a, "Scheduler.schedule");
    expect(s.start).toBe(25);
    expect(s.sig).toBe("def schedule(self) -> tuple[list[Sequence], bool]");
    expect(s.parent).toBe("Scheduler");
    const f = sym(analyze("python", show(NEW, "nanovllm/layers/sampler.py")), "Sampler.forward");
    expect(f.start).toBe(f.defLine - 1); // @torch.compile
  });
  it("flags comments, docstrings, blank lines and trailing comments", () => {
    const src = 'def f(a):\n    """doc\n    more"""\n    # note\n\n    x = 1  # tail\n    return x\n';
    const a = analyze("python", src);
    expect(a.flags[1] & DOCSTRING).toBeTruthy();
    expect(a.flags[2] & DOCSTRING).toBeTruthy();
    expect(a.flags[3] & COMMENT).toBeTruthy();
    expect(a.flags[4] & BLANK).toBeTruthy();
    expect(a.flags[5]).toBe(0);
    expect(a.trailing[6]).toBe(11);
  });
  it("finds calls with receivers, loops and who takes the return value", () => {
    const a = analyze("python", show(NEW, ENGINE));
    const step = sym(a, "LLMEngine.step");
    const calls = a.calls.filter((c) => c.line >= step.start && c.line <= step.end);
    const sched = calls.find((c) => c.name === "schedule")!;
    expect(sched).toMatchObject({ recv: "self.scheduler", loop: false, assigned: ["seqs", "is_prefill"] });
    // call("run", …) records the string, but the callee is call
    const call = calls.find((c) => c.name === "call")!;
    expect(call.dispatch).toBe("run");
    const gen = sym(a, "LLMEngine.generate");
    const stepCall = a.calls.find((c) => c.name === "step" && c.line > gen.start && c.line <= gen.end)!;
    expect(stepCall.loop).toBe(true); // while not self.is_finished()
  });
  it("does not treat the for-loop iterable as inside the loop", () => {
    const a = analyze("python", "def f(xs):\n    for x in g(xs):\n        h(x)\n");
    expect(a.calls.find((c) => c.name === "g")!.loop).toBe(false);
    expect(a.calls.find((c) => c.name === "h")!.loop).toBe(true);
  });
  it("finds the __main__ block", () => {
    const a = analyze("python", show(NEW, "example.py"));
    expect(a.mainBlocks.length).toBe(1);
  });
  it("handles CJK text before a comment", () => {
    const a = analyze("python", 'x = "中文"  # 注释\n');
    expect(a.trailing[1]).toBe('x = "中文"  '.length);
  });
});

describe("analyze (c++ / cuda)", () => {
  it("finds functions, classes and calls", () => {
    const src = "template <typename T>\n__global__ void add(T* a, int n) {\n  for (int i = 0; i < n; i++) { foo(a, i); }\n}\nstruct S {\n  int f(int x) { return bar(x); }\n};\n";
    const a = analyze("cuda-cpp", src);
    expect(a.symbols.map((s) => [s.qual, s.start, s.end])).toEqual([["add", 1, 4], ["S", 5, 7], ["S::f", 6, 6]]);
    expect(a.calls.find((c) => c.name === "foo")!.loop).toBe(true);
    expect(a.calls.find((c) => c.name === "bar")!.loop).toBe(false);
  });
});

describe("varCandidates", () => {
  it("pairs args with params, keeps names that differ, and adds the return value", () => {
    const eng = analyze("python", show(NEW, ENGINE));
    const gen = sym(eng, "LLMEngine.generate");
    const add = eng.calls.find((c) => c.name === "add_request" && c.line > gen.start)!;
    expect(varCandidates(add, sym(eng, "LLMEngine.add_request"))).toEqual([{ a: "prompt" }, { a: "sp", b: "sampling_params" }]);
    const sched = eng.calls.find((c) => c.name === "schedule")!;
    expect(varCandidates(sched, sym(analyze("python", show(NEW, SCHED)), "Scheduler.schedule"))).toEqual([{ a: "seqs, is_prefill", ret: true }]);
  });
  it("gives nothing for string dispatch", () => {
    const eng = analyze("python", show(NEW, ENGINE));
    const call = eng.calls.find((c) => c.name === "call")!;
    expect(varCandidates(call, sym(analyze("python", show(NEW, RUNNER)), "ModelRunner.call"))).toEqual([]);
  });
});

describe("planSelection", () => {
  const a = () => analyze("python", show(NEW, SCHED));
  const sel = (s: number, e: number, endCol = 1) => ({ startLine: s, startCol: 4, endLine: e, endCol });
  it("takes whole lines and trims blank edges", () => {
    expect(planSelection([sel(28, 33)], a())).toEqual({ kind: "segments", ranges: [{ start: 29, end: 33, scope: "Scheduler.schedule" }] });
  });
  it("does not include the next line when the selection stops at its column 0", () => {
    expect(planSelection([sel(30, 32, 0)], a())).toMatchObject({ ranges: [{ start: 30, end: 31 }] });
  });
  it("upgrades to a function card at >= 90% coverage", () => {
    const s = sym(a(), "Scheduler.schedule");
    expect(planSelection([sel(s.start + 1, s.end)], a())).toMatchObject({ kind: "function", sym: { qual: "Scheduler.schedule" } });
  });
  it("makes a class card when several methods of one class are selected", () => {
    const an = a();
    const p = sym(an, "Scheduler.preempt"), post = sym(an, "Scheduler.postprocess");
    expect(planSelection([sel(p.start, post.end)], an)).toMatchObject({ kind: "class", sym: { qual: "Scheduler" }, members: ["Scheduler.preempt", "Scheduler.postprocess"] });
  });
  it("asks when two top-level functions are selected", () => {
    const an = analyze("python", "def a():\n    pass\n\ndef b():\n    pass\n\nx = 1\ny = 2\n");
    expect(planSelection([sel(1, 8)], an)).toMatchObject({ kind: "split", syms: [{ qual: "a" }, { qual: "b" }] });
  });
  it("keeps the tail of one function and head of the next as one snippet", () => {
    const an = a();
    const p = sym(an, "Scheduler.preempt");
    expect(planSelection([sel(p.start - 3, p.start + 1)], an)).toMatchObject({ kind: "segments", ranges: [{ scope: "Scheduler.schedule" }] });
  });
  it("names module-level code as top", () => {
    expect(planSelection([sel(1, 3)], a())).toMatchObject({ ranges: [{ module: true }] });
  });
  it("turns multiple selections into one multi-segment card", () => {
    const p = planSelection([sel(31, 32), sel(44, 45)], a());
    expect(p).toMatchObject({ kind: "segments", ranges: [{ start: 31, end: 32 }, { start: 44, end: 45 }] });
  });
});

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

// ---------- Flows ----------

const seg = (id: string, start = 1, end = 3): Segment => ({ id, src: { kind: "repo", repo: "" }, path: "a.py", lang: "python", start, end, text: [], version: { kind: "git", commit: "x" } });
const code = (id: string): CodeCard => ({ id, kind: "code", segments: [seg(`s${id}`, 1, 50)] });
const call = (from: string, line: number, to: string): Link => ({ id: `${from}-${to}`, kind: "call", from: { card: from, seg: `s${from}`, line }, to: { card: to } });

describe("computeFlows", () => {
  const board = (links: Link[], ids = ["a", "b", "c", "d", "e"]): Board => ({ ...emptyBoard("b", "B"), cards: ids.map(code), links });
  it("numbers root A, children by source line, grandchildren 2.1", () => {
    const f = computeFlows(board([call("a", 9, "b"), call("a", 3, "c"), call("b", 5, "d")]));
    expect(["a", "c", "b", "d"].map((id) => f.byId.get(id)!.num)).toEqual(["", "1", "2", "2.1"]);
    expect(["a", "c", "b", "d"].map((id) => f.byId.get(id)!.label)).toEqual(["A", "A", "A", "A"]);
    expect(walkOrder(f.roots[0]).map((n) => n.id)).toEqual(["a", "c", "b", "d"]);
  });
  it("labels every card with its tree's letter", () => {
    const f = computeFlows(board([call("a", 1, "b"), call("c", 1, "d")]));
    expect(f.byId.get("b")!.label).toBe("A");
    expect(f.byId.get("c")!.label).toBe("B");
    expect(f.byId.get("d")!.label).toBe("B");
    expect(f.byId.has("e")).toBe(false);
  });
  it("attaches only to cards with no incoming call, without loops", () => {
    const b = board([call("a", 1, "b"), call("c", 1, "d")]);
    const f = computeFlows(b);
    expect(canAttach(b, f, "a", "b").ok).toBe(false); // b already has an incoming link
    expect(canAttach(b, f, "a", "e").ok).toBe(true);
    expect(canAttach(b, f, "b", "a").ok).toBe(false); // would form a cycle
    expect(canAttach(b, f, "b", "c").ok).toBe(true); // root of another tree: the whole tree merges in
  });
  it("keeps both Compare columns in one flow on expand and attach", () => {
    const cmp: Card = { id: "k", kind: "compare", cols: ["p", "q"] };
    const b: Board = { ...emptyBoard("b", "B"), cards: [...["a", "b", "e", "p", "q"].map(code), cmp], links: [call("p", 1, "a")] };
    const f = computeFlows(b);
    expect(canExpand(b, "q").ok).toBe(false); // q would become the root of a second tree
    expect(canExpand(b, "p").ok).toBe(true);
    expect(canExpand(b, "a").ok).toBe(true);
    expect(canAttach(b, f, "a", "q").ok).toBe(true); // q joins p's tree
    const b2: Board = { ...b, links: [call("p", 1, "a"), call("b", 1, "e")] };
    expect(canAttach(b2, computeFlows(b2), "b", "q").ok).toBe(false); // q joins b's tree while p is in another
    const b3: Board = { ...b, links: [] };
    expect(canExpand(b3, "q").ok).toBe(true);
    expect(canAttach(b3, computeFlows(b3), "q", "p").ok).toBe(true);
  });
  it("forbids comparing cards of two different flows", () => {
    const f = computeFlows(board([call("a", 1, "b"), call("c", 1, "d")]));
    expect(canCompare(f, "b", "d").ok).toBe(false);
    expect(canCompare(f, "b", "a").ok).toBe(true);
    expect(canCompare(f, "b", "e").ok).toBe(true);
  });
  it("hides collapsed subtrees", () => {
    const b = board([call("a", 1, "b"), call("b", 1, "c")]);
    b.place.b = { x: 0, y: 0, w: 100, collapsed: true };
    expect([...hiddenByCollapse(b, computeFlows(b))]).toEqual(["c"]);
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
});

describe("entry points", () => {
  it("reads pyproject scripts and package exports", () => {
    expect(pyprojectScripts('[project]\nname="x"\n[project.scripts]\nnv = "nanovllm.cli:main"\n')).toEqual([{ name: "nv", module: "nanovllm.cli", func: "main" }]);
    expect(initExports(show(NEW, "nanovllm/__init__.py")).map((e) => e.name)).toEqual(["LLM", "SamplingParams"]);
  });
});

describe("migrateBoard", () => {
  it("turns a v1 board into v3", () => {
    const b = migrateBoard({ id: "b", name: "x", cam: { x: 0, y: 0, z: 1 }, version: 1,
      cards: [{ id: "c1", type: "code", x: 0, y: 0, w: 500, path: "a.py", start: 1, end: 2, lang: "python", snapshot: ["a", "b"], commit: "abc", hl: [2], symbol: "f" }],
      edges: [{ id: "e", from: { card: "c1", line: 2 }, to: { card: "c1" }, kind: "call" }] });
    expect(b.version).toBe(3);
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
    expect(b.place.a).toEqual({ x: 1, y: 2, w: 400, h: 90, section: "g", locked: true, collapsed: true });
    expect(b.cards.find((c) => c.id === "a")).toEqual({ id: "a", kind: "code", title: "T", segments: [seg("sa")] });
    expect(b.cards.find((c) => c.id === "k")).toEqual({ id: "k", kind: "compare", cols: ["p", "q"], swap: true });
    expect(b.cards.map((c) => c.id)).toEqual(["a", "p", "q", "k", "w", "i"]);
    expect(b.place.p).toBeUndefined();
    expect(b.place.k).toEqual({ x: 10, y: 20, w: 900 });
    expect(b.cards.find((c) => c.id === "w")).toEqual({ id: "w", kind: "web", url: "https://x.org", meta: { title: "X" } });
    expect(b.cards.find((c) => c.id === "i")).toMatchObject({ bg: true });
    expect(b.links[0]).toMatchObject({ kind: "plain", arrow: "none" });
    expect(b.stickers).toEqual([]);
    expect(migrateBoard(structuredClone(b))).toEqual(b);
  });
});

it("symbolAt picks the innermost", () => {
  const a = analyze("python", show(NEW, SCHED));
  expect(symbolAt(a.symbols, 30)!.qual).toBe("Scheduler.schedule");
});
