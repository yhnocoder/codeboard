// jsdiff 版 diff 和 v0.1.5 的 LCS 版对比（nano-vllm 的 git 历史里每个改过的文件）
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { alignRows, diffLines, mapLines, wordDiff } from "../src";
import * as lcs from "./fixtures/diff-lcs";

const repo = fileURLToPath(new URL("../../../examples/nano-vllm", import.meta.url));
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 1 << 26 });

/** 历史里每个提交改过的文件：[提交前, 提交后] */
function pairs(): { name: string; a: string[]; b: string[] }[] {
  const out: { name: string; a: string[]; b: string[] }[] = [];
  for (const c of git("rev-list", "HEAD").trim().split("\n")) {
    const parent = git("rev-list", "--parents", "-n", "1", c).trim().split(" ")[1];
    if (!parent) continue;
    for (const f of git("diff", "--name-only", "--diff-filter=M", parent, c).trim().split("\n").filter(Boolean)) {
      if (!/\.(py|md|toml|txt)$/.test(f)) continue;
      out.push({ name: `${c.slice(0, 7)}:${f}`, a: git("show", `${parent}:${f}`).split("\n"), b: git("show", `${c}:${f}`).split("\n") });
    }
  }
  return out;
}


describe("diff (jsdiff) vs v0.1.5 LCS on nano-vllm history", () => {
  const ps = pairs();
  it("has real file pairs", () => { expect(ps.length).toBeGreaterThan(50); });
  it("finds an LCS of the same length", () => {
    for (const p of ps) expect(diffLines(p.a, p.b).filter((x) => x.op === " ").length, p.name).toBe(lcs.diffLines(p.a, p.b).filter((x) => x.op === " ").length);
  });
  // 中间部分小于 LCS 表上限：和旧版逐行一致
  it("gives the same lines, rows and line mapping", () => {
    const differ: string[] = [];
    for (const p of ps) {
      const same = JSON.stringify(diffLines(p.a, p.b)) === JSON.stringify(lcs.diffLines(p.a, p.b));
      if (!same) { differ.push(p.name); continue; }
      expect(alignRows(p.a, p.b), p.name).toEqual(lcs.alignRows(p.a, p.b));
      expect(mapLines(p.a, 1, p.b, 1), p.name).toEqual(lcs.mapLines(p.a, 1, p.b, 1));
      expect(mapLines(p.a, 1, p.b, 1, false), p.name).toEqual(lcs.mapLines(p.a, 1, p.b, 1, false));
    }
    expect(differ).toEqual([]);
  });
  // 剥掉头尾后超过 LCS 表上限的走 Myers：公共行一样多（取哪几行可以不同）
  it("Myers path on large real inputs keeps an LCS of the same length", () => {
    const a = ps.slice(0, 60).flatMap((p) => p.a), b = ps.slice(0, 60).flatMap((p) => p.b);
    expect(a.length * b.length).toBeGreaterThan(1 << 22);
    const d = diffLines(a, b);
    expect(d.filter((x) => x.op === " ").length).toBe(lcs.diffLines(a, b).filter((x) => x.op === " ").length);
    expect(d.filter((x) => x.op !== "+").map((x) => x.text)).toEqual(a);
    expect(d.filter((x) => x.op !== "-").map((x) => x.text)).toEqual(b);
  });
  it("word diff matches", () => {
    for (const [x, y] of [["    input_ids.extend(seq[start:end])", "    input_ids.append(seq.last_token)"], ["a b c", "a c"], ["", "x"], ["foo(bar)", "foo(baz)"]])
      expect(wordDiff(x, y)).toEqual(lcs.wordDiff(x, y));
  });
});

describe("diff on 10k-line inputs", () => {
  const N = 10000;
  const a = Array.from({ length: N }, (_, i) => `line ${i} ${i % 7}`);
  const check = (b: string[]) => {
    const t = performance.now(), d = diffLines(a, b);
    expect(performance.now() - t).toBeLessThan(3000);
    expect(d.filter((x) => x.op !== "+").map((x) => x.text)).toEqual(a);
    expect(d.filter((x) => x.op !== "-").map((x) => x.text)).toEqual(b);
    return d;
  };
  it("scattered edits: exact", () => {
    const d = check(a.map((l, i) => (i % 50 === 0 ? l + " changed" : l)));
    expect(d.filter((x) => x.op === " ").length).toBe(N - N / 50);
  });
  it("completely different: no n·m table, falls back to delete + add", () => {
    const d = check(Array.from({ length: N }, (_, i) => `other ${i}`));
    expect(d.map((x) => x.op).join("")).toBe("-".repeat(N) + "+".repeat(N));
  });
  it("mostly different with shared lines: anchors on unique lines", () => {
    const b = Array.from({ length: N }, (_, i) => (i % 100 === 0 ? a[i] : i % 3 ? `x ${i}` : ""));
    expect(check(b).filter((x) => x.op === " ").length).toBeGreaterThanOrEqual(N / 100);
    check([...a].reverse());
  });
});
