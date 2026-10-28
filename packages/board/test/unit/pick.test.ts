// The harness scenario selection (tools/test/pick.mjs, tools/test/areas.mjs): which areas a change touches, what npm run check
// and CI run, and the areas in tiers.json covering every source file
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import { pick, repeatPick } from "../../../../tools/test/pick.mjs";
// @ts-expect-error plain ESM script without type declarations
import { globRe, holders, areasOf, groupTimes, OWNED } from "../../../../tools/test/areas.mjs";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const TIERS = JSON.parse(fs.readFileSync(path.join(REPO, "packages/board/test/tiers.json"), "utf8"));

type Group = { files: string[]; scenarios: string[] };
type Tiers = { smoke: string[]; manual: string[]; solo: string[]; limits?: Record<string, number>; broad?: Group; areas?: Record<string, Group> };
type Plan = { run: { name: string; why: string }[]; areas: { name: string; files: string[]; ms: number }[]; forCI: string[]; deferred: string[]; shards?: number; notes: string[] };

// outside packages/board/test/scenarios, so that no area or broad holds the made-up spec files
const spec = (n: string) => `test/${n}.spec.ts`;
/** Scenarios as { name: [seconds in the last nightly run, source files it ran] }; a missing time means the nightly run doesn't have it */
function setup(s: Record<string, [number | null, string[]?]>) {
  const all = Object.fromEntries(Object.keys(s).map((n) => [n, spec(n)]));
  const scenarios = Object.fromEntries(Object.entries(s).filter(([, [ms]]) => ms !== null).map(([n, [sec, files]]) => [n, { ms: sec! * 1000, files: files ?? ["packages/board/src/other.ts"] }]));
  return { all, impact: { map: { commit: "c", generated: "g", scenarios }, failing: [] as string[] } };
}
/** Three areas: links (Links.tsx and its spec), notes (NoteBody.tsx) and model (model.ts, no group of its own); broad for the
 *  shared stylesheet and the lockfile */
const tiers: Tiers = {
  smoke: ["smoke1"], manual: [], solo: [], limits: { area: 30, smoke: 90, local: 180 },
  broad: { files: ["packages/board/src/styles.css", "package-lock.json"], scenarios: ["look1"] },
  areas: {
    links: { files: ["packages/board/src/canvas/Links.tsx", "packages/board/test/scenarios/links*.spec.ts"], scenarios: ["link1", "link2"] },
    notes: { files: ["packages/board/src/cards/NoteBody.tsx"], scenarios: ["note1", "smoke1"] },
    model: { files: ["packages/core/src/model.ts"], scenarios: [] },
  },
};
const SCENARIOS = { smoke1: [3], look1: [4], link1: [5], link2: [6], note1: [7], links3: [2], other: [1] } as Record<string, [number]>;
const change = (files: string[], added: string[] = []) => ({ base: "base", files, added });
const none = { added: [] as string[], edited: [] as string[] };
const whyOf = (plan: Plan) => Object.fromEntries(plan.run.map((r) => [r.name, r.why]));

describe("areas", () => {
  it("reads globs: ** any depth, * one segment, {a,b} alternatives", () => {
    expect(globRe("packages/board/src/**").test("packages/board/src/ui/pops/peek.tsx")).toBe(true);
    expect(globRe("packages/board/src/*.ts").test("packages/board/src/ui/x.ts")).toBe(false);
    expect(globRe("packages/core/src/{edit,model}.ts").test("packages/core/src/model.ts")).toBe(true);
    expect(globRe("packages/core/src/{edit,model}.ts").test("packages/core/src/modelx.ts")).toBe(false);
    expect(globRe("packages/*/tsconfig*.json").test("packages/markdown/tsconfig.build.json")).toBe(true);
  });

  it("gives every source file and scenario spec an area or broad", () => {
    const owned = ["board", "core", "host", "markdown", "analysis"].flatMap((p) => {
      const dir = path.join(REPO, "packages", p, "src");
      return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => `packages/${p}/src/${f}`);
    });
    const specs = fs.readdirSync(path.join(REPO, "packages/board/test/scenarios")).filter((f) => f.endsWith(".spec.ts")).map((f) => `packages/board/test/scenarios/${f}`);
    expect(owned.length).toBeGreaterThan(100);
    for (const f of [...owned, ...specs]) expect(OWNED.test(f), f).toBe(true);
    expect([...owned, ...specs].filter((f) => !holders(f, TIERS).length)).toEqual([]);
  });

  it("names only existing scenarios in tiers.json, and no manual or solo ones in a group", () => {
    const dir = path.join(REPO, "packages/board/test/scenarios");
    const names = new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".spec.ts")).flatMap((f) => [...fs.readFileSync(path.join(dir, f), "utf8").matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1])));
    const groups: [string, Group][] = [["broad", TIERS.broad], ...Object.entries(TIERS.areas as Record<string, Group>)];
    const named = [...TIERS.smoke, ...TIERS.manual, ...TIERS.solo, ...groups.flatMap(([, g]) => g.scenarios)];
    expect(named.filter((n) => !names.has(n))).toEqual([]);
    const off = new Set([...TIERS.manual, ...TIERS.solo]);
    expect(groups.flatMap(([a, g]) => g.scenarios.filter((n) => off.has(n)).map((n) => `${a}: ${n}`))).toEqual([]);
  });

  it("touches the areas a changed file belongs to; broad holds what no area can place", () => {
    expect(areasOf(["packages/board/src/canvas/Links.tsx", "packages/board/test/scenarios/links-extra.spec.ts"], tiers))
      .toEqual({ areas: { links: ["packages/board/src/canvas/Links.tsx", "packages/board/test/scenarios/links-extra.spec.ts"] }, broad: [], unplaced: [] });
    expect(areasOf(["package-lock.json", "packages/core/src/new.ts"], tiers))
      .toEqual({ areas: {}, broad: ["package-lock.json"], unplaced: ["packages/core/src/new.ts"] });
  });

  it("touches nothing for files no scenario runs: docs, unit tests, tiers.json", () => {
    expect(areasOf(["README.md", "packages/core/test/edit.test.ts", "packages/board/test/tiers.json"], tiers)).toEqual({ areas: {}, broad: [], unplaced: [] });
  });

  it("holds a file broad matches in broad only", () => {
    expect(areasOf(["packages/board/src/styles.css"], { ...tiers, areas: { all: { files: ["packages/board/src/**"], scenarios: [] } } }))
      .toEqual({ areas: {}, broad: ["packages/board/src/styles.css"], unplaced: [] });
  });

  it("measures each group beside smoke against the limits", () => {
    const sec = (n: string) => (SCENARIOS[n]?.[0] ?? 0) * 1000;
    const t = groupTimes({ ...tiers, limits: { area: 10, smoke: 2, local: 30 } }, sec);
    expect(t.groups.map((g: { name: string; ms: number; over: boolean }) => [g.name, g.ms, g.over])).toEqual([["broad", 4000, false], ["links", 11000, true], ["notes", 7000, false], ["model", 0, false]]);
    expect(t.over).toEqual(["links: 11 s beside smoke, over the 10 s limit", "smoke: 3 s, over the 2 s limit"]);
    expect(groupTimes({ ...tiers, limits: { area: 30, smoke: 90, local: 20 } }, sec).over).toEqual(["smoke and the three largest groups: 25 s, over the 20 s of npm run check"]);
  });
});

describe("pick for npm run check", () => {
  it("runs the whole group of each touched area, and no other group", () => {
    const { all, impact } = setup(SCENARIOS);
    const plan: Plan = pick({ all, impact, tiers, change: change(["packages/board/src/canvas/Links.tsx"]), changed: none });
    expect(whyOf(plan)).toEqual({ smoke1: "smoke", link1: "area links", link2: "area links" });
    expect(plan.areas).toEqual([{ name: "links", files: ["packages/board/src/canvas/Links.tsx"], ms: 11000 }]);
  });

  it("runs broad for a change no area holds, and only smoke for one that runs no scenario code", () => {
    const { all, impact } = setup(SCENARIOS);
    const unplaced: Plan = pick({ all, impact, tiers, change: change(["packages/core/src/new.ts"]), changed: none });
    expect(whyOf(unplaced)).toEqual({ smoke1: "smoke", look1: "broad" });
    expect(unplaced.notes.join("\n")).toMatch(/in no area of tiers\.json, run as broad: packages\/core\/src\/new\.ts/);
    const docs: Plan = pick({ all, impact, tiers, change: change(["README.md"]), changed: none });
    expect(whyOf(docs)).toEqual({ smoke1: "smoke" });
  });

  it("runs the groups whole over the budget, with a warning naming them", () => {
    const { all, impact } = setup(SCENARIOS);
    const plan: Plan = pick({ all, impact, tiers, budgetMs: 5000, change: change(["packages/board/src/canvas/Links.tsx", "packages/board/src/cards/NoteBody.tsx"]), changed: none });
    expect(Object.keys(whyOf(plan)).sort()).toEqual(["link1", "link2", "note1", "smoke1"]);
    expect(plan.notes.join("\n")).toMatch(/over the budget, not cut: 21 s of scenario time against 5 s \(asked, added, failing and smoke 3 s; groups links \+11 s, notes \+7 s\)/);
  });

  it("runs asked, added and failing scenarios, and lists edited ones outside the groups as run in CI", () => {
    const { all, impact } = setup(SCENARIOS);
    impact.failing = ["note1"];
    const plan: Plan = pick({
      all, impact, tiers, focus: ["other"],
      change: change(["packages/board/test/scenarios/links.spec.ts"]),
      changed: { added: ["links3"], edited: ["link2", "look1"] },
    });
    expect(whyOf(plan)).toEqual({ other: "asked", links3: "test added", note1: "failing last night", smoke1: "smoke", link1: "area links", link2: "area links" });
    expect(plan.forCI).toEqual(["look1"]);
  });

  it("notes a touched group over its limit", () => {
    const { all, impact } = setup(SCENARIOS);
    const plan: Plan = pick({ all, impact, tiers: { ...tiers, limits: { area: 10 } }, change: change(["packages/board/src/canvas/Links.tsx"]), changed: none });
    expect(plan.notes.join("\n")).toMatch(/group links takes 11 s beside smoke, over its 10 s limit/);
  });
});

describe("pick for CI", () => {
  const ci = { perShardMs: 10_000, minShards: 2, maxShards: 3 };

  it("runs every changed scenario, then fills the shards' room with affected ones and leaves the rest to the nightly run", () => {
    const { all, impact } = setup({ ...SCENARIOS, aff1: [4, ["packages/core/src/model.ts"]], aff2: [9, ["packages/core/src/model.ts"]] });
    const plan: Plan = pick({
      all, impact, tiers, ci,
      change: change(["packages/core/src/model.ts", spec("other"), spec("look1")]),
      changed: { added: [], edited: ["other", "look1"] },
    });
    expect(whyOf(plan)).toEqual({ smoke1: "smoke", other: "test changed", look1: "test changed", aff1: "affected" });
    expect(plan.shards).toBe(2);
    expect(plan.deferred).toEqual(["aff2"]);
  });

  it("adds shards for the changed scenarios, and runs them all when even the most shards can't hold them", () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`e${i}`, [5] as [number]]));
    const { all, impact } = setup({ ...SCENARIOS, ...many });
    const edited = Object.keys(many);
    const plan: Plan = pick({ all, impact, tiers, ci, change: change(edited.map(spec)), changed: { added: [], edited } });
    expect(edited.every((n) => whyOf(plan)[n] === "test changed")).toBe(true);
    expect(plan.shards).toBe(3);
    expect(plan.notes.join("\n")).toMatch(/take 63 s of scenario time, more than 3 harness jobs of 10 s hold: all of them run/);
    const some: Plan = pick({ all, impact, tiers, ci, change: change(edited.slice(0, 4).map(spec)), changed: { added: [], edited: edited.slice(0, 4) } });
    expect(some.shards).toBe(3);
    expect(some.notes.join("\n")).not.toMatch(/more than/);
  });

  it("runs the touched areas' groups and broad there too", () => {
    const { all, impact } = setup(SCENARIOS);
    const plan: Plan = pick({ all, impact, tiers, ci, change: change(["packages/board/src/styles.css", "packages/board/src/cards/NoteBody.tsx"]), changed: none });
    expect(Object.entries(whyOf(plan)).filter(([, w]) => w !== "affected" && w !== "new")).toEqual([["smoke1", "smoke"], ["look1", "broad"], ["note1", "area notes"]]);
    expect(plan.notes.join("\n")).toMatch(/every scenario may be affected \(packages\/board\/src\/styles\.css, /);
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
