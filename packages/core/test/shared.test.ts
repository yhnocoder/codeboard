import { describe, expect, it } from "vitest";
import { emptyBoard, sharedInfo, type Board, type Card } from "../src";

const note = (id: string): Card => ({ id, kind: "note", md: id, look: "note" });
const code = (id: string): Card => ({ id, kind: "code", segments: [{ id: `s${id}`, src: { kind: "repo", repo: "" }, path: "a.py", lang: "python", start: 1, end: 3, text: ["a", "b", "c"], version: { kind: "none" } }] });
function b(id: string, name: string, cards: Card[]): Board {
  const x = { ...emptyBoard(id, name), cards };
  for (const c of cards) x.place[c.id] = { x: 0, y: 0, w: 1 };
  return x;
}

describe("sharedInfo", () => {
  it("lists the boards of each shared card with that board's call graph mark, and arrows into it from other boards", () => {
    const A = b("A", "Attention", [code("r"), code("p")]);
    A.links.push({ id: "l", from: { card: "p", seg: "sp", line: 2 }, to: { card: "r" }, call: { name: "rms", col: 0 } });
    const M = b("M", "MoE", [code("x"), code("y"), code("r")]);
    M.links.push({ id: "m1", from: { card: "x", seg: "sx", line: 3 }, to: { card: "y" }, call: { name: "y", col: 0 } });
    M.links.push({ id: "m2", from: { card: "y", seg: "sy", line: 1 }, to: { card: "r" }, call: { name: "rms", col: 0 } });
    M.links.push({ id: "m3", from: { card: "r" }, to: { card: "r" }, label: "self" });
    M.marks = { x: { icon: "star" } };
    const C = b("C", "Alone", [note("z")]);
    const all = [{ id: "A", board: A, refs: new Set(["r"]) }, { id: "M", board: M, refs: new Set(["r"]) }, { id: "C", board: C, refs: new Set(["z"]) }];
    const info = sharedInfo(all, "A");
    expect(Object.keys(info)).toEqual(["r"]);
    expect(info.r.boards).toEqual([{ id: "A", name: "Attention", mark: "A" }, { id: "M", name: "MoE", icon: "star" }]);
    expect(info.r.ins).toEqual([{ board: "M", boardName: "MoE", card: "y", title: "a.py 1–3", line: 1, call: "rms" }]);
    // A card shared with only one board has no badge
    expect(sharedInfo(all, "C")).toEqual({});
  });
});
