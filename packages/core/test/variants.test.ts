import { describe, expect, it } from "vitest";
import {
  addVariant, danglingRefs, dropVariants, emptyBoard, isMine, loadBoard, placeCards, rebaseUpstream, removeVariant, segsOf, setVariantSegs, switchVariant, threeWay, upstreamSegs, variantMarks, noteShown,
  type Board, type CodeCard, type Segment,
} from "../src";

const UP = ["def forward(x):", "    a = x < 1", "    r = a.argmax()", "    out[r + 1:] = -1", "    return out"];
const MINE = ["def forward(x):", "    a = x < 1", "    r = (~a).argmax()", "    r[a.all()] = k", "    out[r + 1:] = -1", "    return out"];
const seg = (text: string[], start = 10, commit = "bb823b3"): Segment => ({ id: "s1", src: { kind: "repo", repo: "" }, path: "m.py", lang: "python", start, end: start + text.length - 1, text, version: { kind: "git", commit }, symbol: { qual: "forward", kind: "function" } });

function board(): Board {
  const b = emptyBoard("b", "B");
  const c: CodeCard = { id: "c1", kind: "code", segments: [seg(UP)] };
  b.cards.push(c, { id: "c2", kind: "note", md: "x", look: "note" });
  b.place.c1 = { x: 0, y: 0, w: 400 };
  b.place.c2 = { x: 500, y: 0, w: 200 };
  // 第 14 行（return out）连到 c2；第 12 行（r = …）有一条 Sidenote
  b.links.push({ id: "l1", from: { card: "c1", seg: "s1", line: 14 }, to: { card: "c2" } });
  b.sidenotes.push({ id: "n1", at: { card: "c1", seg: "s1", lines: [12, 12] }, kind: "text", md: "argmax" });
  return b;
}
const card = (b: Board) => b.cards[0] as CodeCard;

describe("variants", () => {
  it("add + switch: segments swap, arrows and sidenotes follow by content, MINE only when the code differs", () => {
    const b = board();
    addVariant(b, "c1", { id: "v1", name: "fix-spec-bug", from: { kind: "ref", ref: "fix-spec-bug" }, segs: [seg(MINE, 20, "aaa1111")] });
    expect(card(b).variants!.map((v) => v.id)).toEqual(["up", "v1"]);
    expect(isMine(card(b))).toBe(false);
    expect(switchVariant(b, "c1", "v1")).toBe(true);
    expect(card(b).active).toBe("v1");
    expect(card(b).segments[0].text).toEqual(MINE);
    expect(upstreamSegs(card(b))[0].text).toEqual(UP);
    expect(isMine(card(b))).toBe(true);
    // return out：上游第 14 行 → 我的第 25 行；r = … 是改过的行（配对）→ 第 22 行
    expect(b.links[0].from.line).toBe(25);
    expect(b.sidenotes[0].at.lines).toEqual([22, 22]);
    switchVariant(b, "c1", "up");
    expect(card(b).active).toBeUndefined();
    expect(b.links[0].from.line).toBe(14);
    expect(b.sidenotes[0].at.lines).toEqual([12, 12]);
    expect(segsOf(card(b), "v1")![0].text).toEqual(MINE);
    expect(() => loadBoard(JSON.parse(JSON.stringify(b)))).not.toThrow();
  });
  it("danglingRefs checks the variant invariant: only the shown variant has no segs, the others mirror the card's segment ids", () => {
    const b = board();
    addVariant(b, "c1", { id: "v1", name: "v", from: { kind: "worktree" }, segs: [seg(MINE, 20)] });
    switchVariant(b, "c1", "v1");
    expect(danglingRefs(b)).toEqual([]);
    card(b).variants![1].segs = [seg(MINE)];
    card(b).variants![0].segs![0].id = "other";
    expect(danglingRefs(b)).toEqual(["card c1: variant up segments do not match the card's", "card c1: shown variant v1 keeps its own segments"]);
  });

  it("Only-in-this-variant sidenotes stay in their variant's line numbers and only show there", () => {
    const b = board();
    addVariant(b, "c1", { id: "v1", name: "w", from: { kind: "worktree" }, segs: [seg(MINE, 20)] });
    switchVariant(b, "c1", "v1");
    b.sidenotes.push({ id: "n2", at: { card: "c1", seg: "s1", lines: [23, 23] }, kind: "text", md: "131 TFLOPS", variant: "v1" });
    switchVariant(b, "c1", "up");
    const n2 = b.sidenotes.find((n) => n.id === "n2")!;
    expect(n2.at.lines).toEqual([23, 23]);
    expect(noteShown(n2, card(b))).toBe(false);
    // 在 v1 不显示时 v1 的代码变了（保存）：它的 Sidenote 跟着挪
    setVariantSegs(b, "c1", "v1", [seg(["# header", ...MINE], 20)]);
    expect(n2.at.lines).toEqual([24, 24]);
    switchVariant(b, "c1", "v1");
    expect(noteShown(n2, card(b))).toBe(true);
    removeVariant(b, "c1", "v1");
    expect(card(b).variants).toBeUndefined();
    expect(n2.variant).toBeUndefined();
  });

  it("refreshing the shown variant moves line ends; Update on upstream while a variant is shown leaves the shown code alone", () => {
    const b = board();
    addVariant(b, "c1", { id: "v1", name: "b", from: { kind: "ref", ref: "b" }, segs: [seg(MINE, 20)] });
    switchVariant(b, "c1", "v1");
    setVariantSegs(b, "c1", "v1", [seg(MINE, 40, "ccc")]); // rebase：函数挪到第 40 行
    expect(card(b).segments[0].start).toBe(40);
    expect(b.links[0].from.line).toBe(45);
    rebaseUpstream(b, "c1", seg(["# new", ...UP], 10, "4c1d0e9"));
    expect(card(b).segments[0].start).toBe(40);
    expect(upstreamSegs(card(b))[0].version).toEqual({ kind: "git", commit: "4c1d0e9" });
    expect(b.links[0].from.line).toBe(45);
  });

  it("Convert drops the variants and pins to upstream latest", () => {
    const b = board();
    addVariant(b, "c1", { id: "v1", name: "b", from: { kind: "ref", ref: "b" }, segs: [seg(MINE, 20)] });
    switchVariant(b, "c1", "v1");
    dropVariants(b, "c1", [seg(MINE, 30, "4c1d0e9")]);
    expect(card(b).variants).toBeUndefined();
    expect(card(b).active).toBeUndefined();
    expect(card(b).segments[0]).toMatchObject({ start: 30, version: { commit: "4c1d0e9" } });
    expect(b.links[0].from.line).toBe(35);
  });

  it("copies keep variant segments matched to the new segment ids", () => {
    const b = board();
    addVariant(b, "c1", { id: "v1", name: "b", from: { kind: "ref", ref: "b" }, segs: [seg(MINE, 20)] });
    const r = placeCards(b, [{ card: card(b) }], { copy: true });
    const cp = b.cards.find((c) => c.id === r.cards.c1) as CodeCard;
    expect(cp.variants![1].segs![0].id).toBe(cp.segments[0].id);
    expect(cp.segments[0].id).not.toBe("s1");
  });

  it("marks and three-way", () => {
    const m = variantMarks([seg(UP)], [seg(MINE, 20)]);
    expect([...m.marks]).toEqual([["s1:22", "~"], ["s1:23", "+"]]);
    expect(m).toMatchObject({ changed: 1, added: 1, removed: 0 });
    const latest = ["def forward(x):", "    a = x <= 1", "    r = a.argmax()", "    out[r + 1:] = -1", "    return out"];
    const t = threeWay(UP, MINE, latest);
    expect(t.base).toEqual(["same", "theirs", "mine", "same", "same"]);
    expect(t.conflicts).toBe(0);
    const both = threeWay(UP, MINE, ["def forward(x):", "    a = x < 1", "    r = a.argmax(dim=-1)", "    out[r + 1:] = -1", "    return out"]);
    expect(both.conflicts).toBe(1);
    expect(both.mine[2]).toBe("both");
    expect(both.latest[2]).toBe("both");
  });
});
