import { describe, expect, it } from "vitest";
import { callText, loopLine, varGone, varText, type Segment } from "../src";

const seg = (start: number, text: string[], lang = "python"): Segment => ({ id: "s", src: { kind: "repo", repo: "" }, path: "a.py", lang, start, end: start + text.length - 1, text, version: { kind: "git", commit: "x" } });

describe("callText", () => {
  it("is the call line when the parentheses close on it", () => {
    const s = seg(10, ["    out = self.runner.run(seqs, cfg)", "    x = 1"]);
    expect(callText(s, 10, 14)).toBe("    out = self.runner.run(seqs, cfg)");
  });
  it("takes the following lines until the call's parentheses close", () => {
    const s = seg(1, ["out = run(", "    seqs,", "    cfg=cfg)", "after(seqs)"]);
    expect(callText(s, 1, 6)).toBe("out = run(\n    seqs,\n    cfg=cfg)");
  });
  it("is empty for a line outside the segment", () => {
    expect(callText(seg(1, ["a()"]), 5)).toBe("");
  });
});

describe("varGone", () => {
  const site = "    out = self.runner.run(seqs, cfg)", callee = "def run(self, seqs, config):\n    return x";
  it("keeps arguments whose names are still in both places", () => {
    expect(varGone({ a: "seqs" }, site, callee)).toBe(false);
    expect(varGone({ a: "cfg", b: "config" }, site, callee)).toBe(false);
    expect(varGone({ a: "out", ret: true }, site, callee)).toBe(false);
  });
  it("marks an argument gone when the call site or the callee lost the name", () => {
    expect(varGone({ a: "cfg2", b: "config" }, site, callee)).toBe(true);
    expect(varGone({ a: "cfg", b: "conf" }, site, callee)).toBe(true);
    expect(varGone({ a: "res", ret: true }, site, callee)).toBe(true);
  });
  it("matches whole words only and skips custom and cut-off names", () => {
    expect(varGone({ a: "seq" }, site, callee)).toBe(true);
    expect(varGone({ a: "seqs[0].block_table", custom: true }, site, callee)).toBe(false);
    expect(varGone({ a: "self.runner.ru…" }, site, callee)).toBe(false);
  });
});

describe("loopLine", () => {
  it("finds the enclosing for / while above the call line", () => {
    const s = seg(50, ["def step(self):", "    for seq in seqs:", "        if seq.ok:", "            out = run(seq)", "    done()"]);
    expect(loopLine(s, 53)).toEqual({ line: 51, text: "for seq in seqs:" });
    expect(loopLine(s, 54)).toBeUndefined();
  });
  it("stops at the function boundary and sees comprehensions on the call line", () => {
    const s = seg(1, ["while True:", "    def f():", "        g()", "    xs = [h(x) for x in ys]"]);
    expect(loopLine(s, 3)).toBeUndefined();
    expect(loopLine(s, 4)).toEqual({ line: 4, text: "xs = [h(x) for x in ys]" });
  });
  it("knows C++ loops", () => {
    const s = seg(1, ["void f() {", "  for (int i = 0; i < n; i++) {", "    g(i);", "  }", "}"], "cpp");
    expect(loopLine(s, 3)).toEqual({ line: 2, text: "for (int i = 0; i < n; i++) {" });
  });
});

describe("varText", () => {
  it("writes return values as return → receiver", () => {
    expect(varText({ a: "out", ret: true })).toBe("return → out");
    expect(varText({ a: "seqs" })).toBe("seqs");
    expect(varText({ a: "cfg", b: "config" })).toBe("cfg → config");
  });
});
