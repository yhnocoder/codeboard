import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pythonSymbols, braceSymbols, findCalls, rankByReceiver, computeSync, followMap, outlineTree } from "../src";

// 用仓库里的 nano-vllm submodule 做测试数据
const repo = fileURLToPath(new URL("../../../examples/nano-vllm", import.meta.url));
const show = (rev: string, path: string) => execFileSync("git", ["-C", repo, "show", `${rev}:${path}`], { encoding: "utf8" }).split("\n");
const OLD = "9e8507e", NEW = "bb823b3", SCHED = "nanovllm/engine/scheduler.py";

describe("pythonSymbols", () => {
  it("finds methods with qualified names and full ranges", () => {
    const syms = pythonSymbols(show(NEW, SCHED));
    const s = syms.find((x) => x.qual === "Scheduler.schedule")!;
    expect(s.start).toBe(25);
    expect(show(NEW, SCHED)[s.end - 1].trim()).toBe("return scheduled_seqs, False");
  });
  it("keeps multi-line signatures inside the symbol", () => {
    const lines = ["def f(", "    a,", "):", "    return a", "x = 1"];
    expect(pythonSymbols(lines)[0]).toMatchObject({ start: 1, end: 4 });
  });
  it("does not end a function at a comment written in column 0", () => {
    const lines = ["class A:", "    def f(self):", "        x = 1", "# note", "        return x", "", "    def g(self):", "        pass"];
    expect(pythonSymbols(lines).find((s) => s.qual === "A.f")).toMatchObject({ start: 2, end: 5 });
  });
  it("includes decorators", () => {
    const syms = pythonSymbols(show(NEW, "nanovllm/layers/sampler.py"));
    const f = syms.find((x) => x.qual === "Sampler.forward")!;
    expect(f.start).toBe(f.defLine - 1);
  });
});

describe("braceSymbols", () => {
  it("finds C++ functions", () => {
    const src = ["template <typename T>", "__global__ void add(T* a, int n) {", "  if (n) {", "  }", "}", "int main() { return 0; }"];
    const syms = braceSymbols(src);
    expect(syms.map((s) => [s.name, s.start, s.end])).toEqual([["add", 1, 5], ["main", 6, 6]]);
  });
});

describe("findCalls", () => {
  it("finds method calls and their receivers", () => {
    const calls = findCalls("        seqs, is_prefill = self.scheduler.schedule()");
    expect(calls).toMatchObject([{ name: "schedule", recv: "scheduler" }]);
  });
  it("treats .call(\"run\") as a call to run", () => {
    const names = findCalls('        token_ids = self.model_runner.call("run", seqs, is_prefill)').map((c) => c.name);
    expect(names).toContain("run");
  });
  it("skips definitions and keywords", () => {
    expect(findCalls("    def step(self):")).toEqual([]);
    expect(findCalls("    for x in range(10):")).toEqual([]);
  });
  it("ranks candidates by receiver", () => {
    const r = rankByReceiver([{ qual: "Other.schedule" }, { qual: "Scheduler.schedule" }], "scheduler");
    expect(r[0].qual).toBe("Scheduler.schedule");
  });
});

describe("computeSync", () => {
  const oldLines = show(OLD, SCHED), newLines = show(NEW, SCHED);
  const oldSym = pythonSymbols(oldLines).find((s) => s.qual === "Scheduler.schedule")!;
  const card = { start: oldSym.start, end: oldSym.end, snapshot: oldLines.slice(oldSym.start - 1, oldSym.end), symbol: "Scheduler.schedule" };

  it("reports a changed function with its new range", () => {
    const s = computeSync(card, newLines, pythonSymbols(newLines));
    expect(s.state).toBe("changed");
    if (s.state === "changed") { expect(s.start).toBe(25); expect(s.added).toBeGreaterThan(0); }
  });
  it("reports ok when nothing changed", () => {
    expect(computeSync(card, oldLines, pythonSymbols(oldLines))).toEqual({ state: "ok" });
  });
  it("reports moved when lines shift but content is the same", () => {
    const shifted = ["# new header", "", ...oldLines];
    expect(computeSync(card, shifted, pythonSymbols(shifted))).toEqual({ state: "moved", start: card.start + 2, end: card.end + 2 });
  });
  it("reports lost when the symbol is gone", () => {
    expect(computeSync(card, ["x = 1"], []).state).toBe("lost");
  });
  it("maps old lines to new lines when following", () => {
    const s = computeSync(card, newLines, pythonSymbols(newLines));
    if (s.state !== "changed") throw new Error();
    const map = followMap(card, newLines, s.start, s.end);
    const oldReturn = card.start + card.snapshot.findIndex((l) => l.includes("return scheduled_seqs, True"));
    expect(newLines[map[oldReturn] - 1]).toContain("return scheduled_seqs, True");
  });
});

describe("outlineTree", () => {
  it("nests cards by edges and orders children by source line", () => {
    const c = (id: string, step?: string) => ({ id, type: "code" as const, x: 0, y: 0, w: 1, path: "a.py", start: 1, end: 1, lang: "python", snapshot: [], commit: null, hl: [], step });
    const tree = outlineTree({
      cards: [c("a", "1"), c("b"), c("c")],
      edges: [
        { id: "1", from: { card: "a", line: 9 }, to: { card: "b" }, kind: "call" },
        { id: "2", from: { card: "a", line: 3 }, to: { card: "c" }, kind: "call" },
      ],
    });
    expect(tree.map((n) => [n.card.id, n.kids.map((k) => k.card.id)])).toEqual([["a", ["c", "b"]]]);
  });
  it("lists a card once even when two edges point at it", () => {
    const c = (id: string) => ({ id, type: "code" as const, x: 0, y: 0, w: 1, path: "a.py", start: 1, end: 1, lang: "python", snapshot: [], commit: null, hl: [] });
    const tree = outlineTree({
      cards: [c("a"), c("b")],
      edges: [
        { id: "1", from: { card: "a", line: 2 }, to: { card: "b" }, kind: "call" },
        { id: "2", from: { card: "a", line: 2 }, to: { card: "b" }, kind: "call" },
      ],
    });
    expect(tree[0].kids.length).toBe(1);
  });
});
