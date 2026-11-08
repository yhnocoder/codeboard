import { describe, expect, it } from "vitest";
import { makeIndex, plan, planned, zipName, type Index } from "../src/plan";

const p = (id: string, hash: string) => planned({ id, name: id.toUpperCase(), cards: 2, subs: [] }, hash);
const prev: Index = {
  branch: "main",
  commit: "c0",
  codeboard: "x",
  built: "2026-01-01T00:00:00.000Z",
  boards: [
    { ...p("a", "h1"), asset: zipName("a", "h1"), size: 10 },
    { ...p("b", "h2"), asset: zipName("b", "h2"), size: 20 },
  ],
};

describe("plan", () => {
  it("draws everything without a previous index", () => {
    const { todo, kept } = plan([p("a", "h1")], null);
    expect(todo.map((b) => b.id)).toEqual(["a"]);
    expect(kept.size).toBe(0);
  });

  it("keeps the zips of unchanged boards and draws changed and new ones", () => {
    const { todo, kept } = plan([p("a", "h1"), p("b", "h9"), p("c", "h3")], prev);
    expect(todo.map((b) => b.id)).toEqual(["b", "c"]);
    expect([...kept]).toEqual([["a", { asset: "a-h1.zip", size: 10 }]]);
  });

  it("draws nothing when nothing changed", () => {
    expect(plan([p("a", "h1"), p("b", "h2")], prev).todo).toEqual([]);
  });
});

describe("index", () => {
  it("lists every board with its zip, in the listing's order, in the app's format", () => {
    const zips = new Map([
      ["b", { asset: "b-h2.zip", size: 20 }],
      ["a", { asset: "a-h1.zip", size: 10 }],
    ]);
    const built = new Date("2026-11-08T10:00:00Z");
    const i = makeIndex([p("a", "h1"), p("b", "h2")], zips, { branch: "dev", commit: "c1", codeboard: "cb", built });
    expect(i).toEqual({
      branch: "dev",
      commit: "c1",
      codeboard: "cb",
      built: "2026-11-08T10:00:00.000Z",
      boards: [
        { id: "a", name: "A", cards: 2, subs: [], hash: "h1", asset: "a-h1.zip", size: 10 },
        { id: "b", name: "B", cards: 2, subs: [], hash: "h2", asset: "b-h2.zip", size: 20 },
      ],
    });
    expect(Object.keys(i.boards[0])).toEqual(["id", "name", "cards", "subs", "hash", "asset", "size"]);
  });

  it("fails on a board with no zip", () => {
    expect(() =>
      makeIndex([p("a", "h1")], new Map(), { branch: "", commit: "", codeboard: "", built: new Date() }),
    ).toThrow(/no tiles for board a/);
  });
});
