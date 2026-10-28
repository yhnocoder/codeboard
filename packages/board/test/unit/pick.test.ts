// The harness scenario selection (tools/test/pick.mjs): what always runs, what the budget orders, what is reported as deferred
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import { pick, repeatPick } from "../../../../tools/test/pick.mjs";

const SRC = "packages/core/src/model.ts";
const spec = (n: string) => `packages/board/test/scenarios/${n}.spec.ts`;
/** Scenarios as { name: [seconds in the last nightly run, ran SRC] }; a missing time means the nightly run doesn't have it */
function setup(s: Record<string, [number | null, boolean?]>) {
  const all = Object.fromEntries(Object.keys(s).map((n) => [n, spec(n)]));
  const scenarios = Object.fromEntries(Object.entries(s).filter(([, [ms]]) => ms !== null).map(([n, [sec, src]]) => [n, { ms: sec! * 1000, files: src ? [SRC] : ["packages/board/src/other.ts"] }]));
  return { all, impact: { map: { commit: "c", generated: "g", scenarios }, failing: [] as string[] } };
}
const tiers = { smoke: [] as string[], manual: [], solo: [] };
const change = (files: string[]) => ({ base: "base", files, added: [] });
const whyOf = (plan: { run: { name: string; why: string }[] }) => Object.fromEntries(plan.run.map((r) => [r.name, r.why]));

describe("pick", () => {
  it("runs changed scenarios within the budget, the quickest first, and reports the rest as deferred", () => {
    const { all, impact } = setup({ c1: [8], c2: [2], c3: [5], c4: [9], a1: [1, true] });
    const plan = pick({
      all, impact, tiers, budgetMs: 7_000,
      change: change([SRC, ...["c1", "c2", "c3", "c4"].map(spec)]),
      changed: { added: [], edited: ["c1", "c2", "c3", "c4"] },
    });
    expect(whyOf(plan)).toEqual({ c2: "test changed", c3: "test changed" });
    expect(plan.deferredChanged).toEqual(["c1", "c4"]);
    // an affected scenario waits behind the changed ones even when it is quicker than all of them
    expect(plan.deferred).toEqual(["c1", "c4", "a1"]);
    expect(plan.notes.join("\n")).toMatch(/2 of 4 changed scenarios over the budget/);
  });

  it("runs asked, added, failing and smoke scenarios whatever the budget", () => {
    const { all, impact } = setup({ asked: [20], added: [null], failing: [20], smoke: [20], edited: [1] });
    impact.failing = ["failing"];
    const plan = pick({
      all, impact, tiers: { ...tiers, smoke: ["smoke"] }, budgetMs: 0, focus: ["asked"],
      change: change(["added", "edited"].map(spec)),
      changed: { added: ["added"], edited: ["edited"] },
    });
    expect(whyOf(plan)).toEqual({ asked: "asked", added: "test added", failing: "failing last night", smoke: "smoke" });
    expect(plan.deferred).toEqual(["edited"]);
    expect(plan.notes.join("\n")).toMatch(/alone take 80 s of scenario time, over the 0 s budget/);
  });

  it("puts changed scenarios ahead of those other branches added", () => {
    const { all, impact } = setup({ elsewhere: [null], edited: [12] });
    const plan = pick({
      all, impact, tiers, budgetMs: 12_000,
      change: change([spec("edited")]),
      changed: { added: [], edited: ["edited"] },
    });
    expect(whyOf(plan)).toEqual({ edited: "test changed" });
    expect(plan.deferred).toEqual(["elsewhere"]);
  });

  it("counts a changed scenario once, under the reason that runs it whatever the budget", () => {
    const { all, impact } = setup({ s: [30] });
    const plan = pick({
      all, impact, tiers: { ...tiers, smoke: ["s"] }, budgetMs: 0,
      change: change([spec("s")]),
      changed: { added: [], edited: ["s"] },
    });
    expect(whyOf(plan)).toEqual({ s: "smoke" });
    expect(plan.deferred).toEqual([]);
  });
});

describe("repeatPick", () => {
  it("repeats added scenarios before changed ones, the quickest first within each, within the cap", () => {
    const { all, impact } = setup({ slowNew: [6], quickNew: [2], edited1: [1], edited2: [3] });
    const plan = repeatPick({
      all, impact, tiers, repeat: 3, workers: 3, capMs: 10_000,
      change: change(Object.values(all)),
      changed: { added: ["slowNew", "quickNew"], edited: ["edited2", "edited1"] },
    });
    expect(plan.run.map((r: { name: string; why: string }) => `${r.name}:${r.why}`)).toEqual(["quickNew:test added", "slowNew:test added", "edited1:test changed"]);
    expect(plan.deferred).toEqual(["edited2"]);
  });
});
