// jsdiff 版 diff：nano-vllm 的 git 历史里每个改过的文件，结果是最短编辑（公共行数等于 LCS 长度）且合法
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { alignRows, diffLines, mapLines, wordDiff, type DiffLine } from "../src";

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


/** LCS 长度（两行滚动的表），只作对照 */
function lcsLength(a: string[], b: string[]): number {
  let prev = new Uint32Array(b.length + 1), cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 编辑脚本合法：去掉 + 是 a，去掉 - 是 b，行号连续 */
function valid(d: DiffLine[], a: string[], b: string[], aStart = 1, bStart = 1) {
  expect(d.filter((x) => x.op !== "+").map((x) => x.text)).toEqual(a);
  expect(d.filter((x) => x.op !== "-").map((x) => x.text)).toEqual(b);
  expect(d.filter((x) => x.op !== "+").map((x) => x.a)).toEqual(a.map((_, i) => aStart + i));
  expect(d.filter((x) => x.op !== "-").map((x) => x.b)).toEqual(b.map((_, i) => bStart + i));
}

describe("diff (jsdiff) on nano-vllm history", () => {
  const ps = pairs();
  it("has real file pairs", () => { expect(ps.length).toBeGreaterThan(50); });
  it("gives a valid edit script with an LCS-length set of common lines", () => {
    for (const p of ps) {
      const d = diffLines(p.a, p.b);
      valid(d, p.a, p.b);
      expect(d.filter((x) => x.op === " ").length, p.name).toBe(lcsLength(p.a, p.b));
    }
  });
  it("aligned rows cover both sides in order; line mapping follows the rows", () => {
    for (const p of ps) {
      const rows = alignRows(p.a, p.b);
      expect(rows.filter((r) => r.l !== undefined).map((r) => r.l), p.name).toEqual(p.a.map((_, i) => i));
      expect(rows.filter((r) => r.r !== undefined).map((r) => r.r), p.name).toEqual(p.b.map((_, i) => i));
      for (const r of rows) if (r.kind === "same") expect(p.a[r.l!]).toBe(p.b[r.r!]);
      const m = mapLines(p.a, 1, p.b, 1, false);
      for (const [x, y] of m) expect(p.a[x - 1], p.name).toBe(p.b[y - 1]);
      expect(m.size).toBe(lcsLength(p.a, p.b));
      expect([...mapLines(p.a, 1, p.b, 1)]).toEqual(rows.filter((r) => r.l !== undefined && r.r !== undefined).map((r) => [r.l! + 1, r.r! + 1]));
    }
  });
  it("large real inputs keep an LCS of the same length", () => {
    const a = ps.slice(0, 60).flatMap((p) => p.a), b = ps.slice(0, 60).flatMap((p) => p.b);
    const d = diffLines(a, b);
    valid(d, a, b);
    expect(d.filter((x) => x.op === " ").length).toBe(lcsLength(a, b));
  });
  it("word diff marks exactly what changed", () => {
    const cut = (s: string, rs: [number, number][]) => rs.reduceRight((t, [x, y]) => t.slice(0, x) + t.slice(y), s);
    for (const [x, y] of [["    input_ids.extend(seq[start:end])", "    input_ids.append(seq.last_token)"], ["a b c", "a c"], ["", "x"], ["foo(bar)", "foo(baz)"]]) {
      const w = wordDiff(x, y);
      expect(cut(x, w.a)).toBe(cut(y, w.b));
    }
    expect(wordDiff("foo(bar)", "foo(baz)")).toEqual({ a: [[4, 7]], b: [[4, 7]] });
  });
});

describe("diff on 10k-line inputs", () => {
  const N = 10000;
  const a = Array.from({ length: N }, (_, i) => `line ${i} ${i % 7}`);
  // "in time" is CPU time of this process (user + system, ms), not wall time: other work on a busy machine doesn't count against it,
  // and an uncapped diff (an n·m table) would still take many seconds of it
  const check = (b: string[]) => {
    const t = process.cpuUsage(), d = diffLines(a, b), u = process.cpuUsage(t);
    expect((u.user + u.system) / 1000).toBeLessThan(3000);
    valid(d, a, b);
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
  it("mostly different with shared lines, or reversed: still a valid script in time", () => {
    check(Array.from({ length: N }, (_, i) => (i % 100 === 0 ? a[i] : i % 3 ? `x ${i}` : "")));
    check([...a].reverse());
  });
  it("small but very different inputs are still exact", () => {
    const x = Array.from({ length: 600 }, (_, i) => `l ${i % 40}`), y = Array.from({ length: 600 }, (_, i) => `l ${(i * 7) % 45}`);
    const d = diffLines(x, y);
    valid(d, x, y);
    expect(d.filter((t) => t.op === " ").length).toBe(lcsLength(x, y));
  });
});
