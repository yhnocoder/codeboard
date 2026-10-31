import { describe, expect, it } from "vitest";
import { Highlighter, plainView, segViewOf, type SegSource } from "../src/highlight";
import type { FileAnalysis } from "@codeboard/analysis";
import type { Segment } from "../src";

const fa = (calls: FileAnalysis["calls"] = []): FileAnalysis => ({ symbols: [], calls, imports: [], flags: [], trailing: {} } as unknown as FileAnalysis);
const seg = (o: Partial<Segment> = {}): Segment => ({ id: "s1", src: { kind: "repo", repo: "" }, path: "m.py", lang: "python", start: 3, end: 4, text: ["    x = run(1)", "    return x"], version: { kind: "none" }, ...o });

describe("highlighter", () => {
  const hl = new Highlighter({ treeLines: async () => null });

  it("colours Python with shiki and keeps every line's text", async () => {
    const toks = await hl.tokensOf("python", "def f(a):\n    return 'x'");
    expect(toks.map((l) => l.map((t) => t.text).join(""))).toEqual(["def f(a):", "    return 'x'"]);
    expect(toks[0].some((t) => t.text === "def" && t.cls)).toBe(true);
  });

  it("tokenises the same text once while several segments ask for it", () => {
    expect(hl.tokensOf("python", "a = 1")).toBe(hl.tokensOf("python", "a = 1"));
  });

  it("asks the port for tree-sitter languages, and shows plain text when the parsers are not there", async () => {
    const asked: string[] = [];
    const h = new Highlighter({ treeLines: async (g) => { asked.push(g); return null; } });
    expect(await h.tokensOf("cpp", "int x;")).toEqual([[{ text: "int x;" }]]);
    expect(asked.length).toBe(1);
  });

  it("highlights lines inside their whole file", async () => {
    const html = await hl.highlight(["    return 'x'"], "python", "def f(a):\n    return 'x'");
    expect(html).toHaveLength(1);
    expect(html[0]).toContain("return");
  });
});

describe("segment views", () => {
  const hl = new Highlighter({ treeLines: async () => null });

  it("builds a segment's view from its own text when the file is not there, with calls at the real columns", async () => {
    const analysed: string[] = [];
    const src: SegSource = {
      fileText: async () => null,
      currentText: async () => null,
      fileOf: () => null,
      analyze: (_l, text) => { analysed.push(text); return fa([{ line: 1, col: 4, end: 7, name: "run", loop: false } as FileAnalysis["calls"][number]]); },
    };
    const v = await segViewOf(seg(), src, hl);
    // The common indent is taken off for the analysis and added back to the columns
    expect(analysed[0]).toBe("x = run(1)\nreturn x");
    expect(v.calls).toEqual([expect.objectContaining({ line: 3, col: 8, end: 11, name: "run" })]);
    expect(v.html).toHaveLength(2);
    expect(v.html[0]).toContain("run");
  });

  it("uses the whole file at the segment's version when it is there", async () => {
    const file = "import os\n\ndef f():\n    x = run(1)\n    return x";
    const ranges: unknown[] = [];
    const src: SegSource = {
      fileText: async () => file,
      currentText: async () => file,
      fileOf: () => "/r/m.py",
      analyze: (_l, _t, range) => { ranges.push(range); return fa(); },
    };
    const v = await segViewOf(seg({ start: 4, end: 5 }), src, hl);
    expect(ranges).toEqual([{ start: 4, end: 5 }]);
    expect(v.html).toHaveLength(2);
  });

  it("gives a plain view for a segment that cannot be built", () => {
    expect(plainView(seg({ text: ["a < b", ""] }))).toEqual({ html: ["a &lt; b", ""], flags: [0, 1], calls: [], defs: [] });
  });
});
