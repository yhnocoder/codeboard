import { describe, expect, it } from "vitest";
import {
  blockAt,
  blockMap,
  blockSig,
  boardMarkdown,
  danglingRefs,
  emptyBoard,
  rebaseBlocks,
  shelveItems,
  BOARD_VERSION,
  type Board,
  type Card,
  type Link,
} from "../src";
import { upgraded } from "./upgrade";
import { upkeeper } from "../src/history/upkeep";

const ROOF = "**Roofline 模型**把应用画在一张图上：左边的斜线是内存带宽的上限，右边的水平线是峰值算力。";
const OLD = [
  "# 计算强度",
  "每从 global memory 读一个字节能做多少次浮点运算（FLOP/B）。",
  ROOF,
  "- vecAdd：0.25 FLOP/B\n- tiled matmul：随 tile 变大而升高",
  "```\nratio = flops / bytes\n```",
];
const note = (id: string, blocks: string[]): Card => ({ id, kind: "note", md: blocks.join("\n\n"), look: "note" });
const ref = (blocks: string[], i: number) => ({ i, h: blockSig(blocks[i]) });
function board(links: Link[]): Board {
  return {
    ...emptyBoard("b", "B"),
    cards: [note("n", OLD), note("m", ["other"])],
    place: { n: { x: 0, y: 0, w: 300 }, m: { x: 400, y: 0, w: 300 } },
    links,
  };
}
const arrow = (i: number): Link => ({ id: "l", from: { card: "m" }, to: { card: "n", block: ref(OLD, i) } });

describe("Note block ends (rebaseBlocks)", () => {
  it("keeps following the same block when a block is inserted above it", () => {
    const b = board([arrow(2)]);
    const now = [OLD[0], "新插入的一段。", ...OLD.slice(1)];
    rebaseBlocks(b, "n", OLD, now);
    expect(b.links[0].to).toEqual({ card: "n", block: { i: 3, h: blockSig(ROOF) } });
    expect(danglingRefs(b)).toEqual([]);
  });

  it("follows a block rewritten in place, and takes its new fingerprint", () => {
    const b = board([arrow(2)]);
    const re = "**Roofline 模型**（Williams 等，2009）把应用画在一张图上：横轴是计算强度，纵轴是吞吐量。";
    const now = [...OLD.slice(0, 2), re, ...OLD.slice(3)];
    rebaseBlocks(b, "n", OLD, now);
    expect(b.links[0].to.block).toEqual({ i: 2, h: blockSig(re) });
  });

  it("insert above and rewrite in one edit: the block goes to the rewrite that reads most like it", () => {
    const b = board([arrow(2)]);
    const re = `${ROOF}两条线的交点叫 ridge point。`;
    const now = [...OLD.slice(0, 2), "（新插入的一段：先回顾一下第三章的矩阵乘法 kernel。）", re, ...OLD.slice(3)];
    rebaseBlocks(b, "n", OLD, now);
    expect(b.links[0].to.block).toEqual({ i: 3, h: blockSig(re) });
  });

  it("falls back to the whole card when the block is deleted", () => {
    const b = board([arrow(2)]);
    rebaseBlocks(b, "n", OLD, [...OLD.slice(0, 2), ...OLD.slice(3)]);
    expect(b.links[0].to).toEqual({ card: "n" });
    expect(b.links).toHaveLength(1);
  });

  it("does not hand a deleted block to an unrelated block put in its place, unless it is a one-for-one rewrite of the same kind", () => {
    const b = board([arrow(2)]);
    rebaseBlocks(b, "n", OLD, [
      ...OLD.slice(0, 2),
      "| a | b |\n|---|---|\n| 1 | 2 |",
      "> 完全不同的引用",
      ...OLD.slice(3),
    ]);
    expect(b.links[0].to.block).toBeUndefined();
  });

  it("an end made against text the editor had not saved yet is found by its fingerprint", () => {
    const now = [OLD[0], "x", ...OLD.slice(1)];
    const b = board([{ id: "l", from: { card: "m" }, to: { card: "n", block: ref(now, 3) } }]);
    rebaseBlocks(b, "n", OLD, now);
    expect(b.links[0].to.block).toEqual(ref(now, 3));
  });

  it("Markdown that cannot be split drops every block end on that Note", () => {
    const b = board([arrow(1), { id: "k", from: { card: "n", block: ref(OLD, 0) }, to: { card: "m" } }]);
    rebaseBlocks(b, "n", OLD, null);
    expect(b.links.map((l) => [l.from, l.to])).toEqual([
      [{ card: "m" }, { card: "n" }],
      [{ card: "n" }, { card: "m" }],
    ]);
  });

  it("a block moved to a Note made in the same change (Split by Headings) takes its end along; a link left with both ends on one card goes", () => {
    const b = board([
      arrow(2),
      { id: "self", from: { card: "n", block: ref(OLD, 1) }, to: { card: "x", block: ref(["## 子标题", ROOF], 1) } },
    ]);
    b.cards.push(note("x", ["## 子标题"]));
    rebaseBlocks(b, "n", OLD, OLD.slice(0, 2), [{ card: "x", blocks: ["## 子标题", ROOF] }]);
    expect(b.links.find((l) => l.id === "l")!.to).toEqual({ card: "x", block: { i: 1, h: blockSig(ROOF) } });
    expect(b.links.find((l) => l.id === "self")!.from.block).toEqual(ref(OLD, 1));
    const c = board([{ id: "c", from: { card: "n", block: ref(OLD, 2) }, to: { card: "x" } }]);
    c.cards.push(note("x", ["## 子标题"]));
    rebaseBlocks(c, "n", OLD, OLD.slice(0, 2), [{ card: "x", blocks: ["## 子标题", ROOF] }]);
    expect(c.links).toEqual([]);
  });

  it("follows a block moved to another place in its Note", () => {
    const b = board([arrow(2)]);
    rebaseBlocks(b, "n", OLD, [...OLD.slice(0, 2), ...OLD.slice(3), ROOF]);
    expect(b.links[0].to).toEqual({ card: "n", block: { i: 4, h: blockSig(ROOF) } });
  });

  it("follows a block moved into another Note changed in the same step", () => {
    const b = board([{ id: "l", from: { card: "x" }, to: { card: "n", block: ref(OLD, 2) } }]);
    b.cards.push(note("x", ["far"]));
    b.place.x = { x: 800, y: 0, w: 300 };
    const up = upkeeper((v) => v, (md) => md.split(/\n{2,}/));
    up.run(b);
    const n = b.cards.find((c) => c.id === "n") as Card & { md: string },
      m = b.cards.find((c) => c.id === "m") as Card & { md: string };
    n.md = [...OLD.slice(0, 2), ...OLD.slice(3)].join("\n\n");
    m.md = ["other", ROOF].join("\n\n");
    up.run(b);
    expect(b.links[0].to).toEqual({ card: "m", block: { i: 1, h: blockSig(ROOF) } });
  });

  it("follows the block on an arrow hidden on the Shelf, and drops a hidden arrow left with both ends on one card", () => {
    const b = board([arrow(2), { id: "c", from: { card: "n", block: ref(OLD, 2) }, to: { card: "x" } }]);
    b.cards.push(note("x", ["## 子标题"]));
    b.place.x = { x: 800, y: 0, w: 300 };
    shelveItems(b, { id: "e", at: 0, cards: ["n"] });
    rebaseBlocks(b, "n", OLD, [OLD[0], "新插入的一段。", ...OLD.slice(1)]);
    const e = b.shelf![0];
    expect(e.links.map((l) => (l.from.card === "n" ? l.from : l.to).block)).toEqual(
      [ref(OLD, 2), ref(OLD, 2)].map((r) => ({ ...r, i: 3 })),
    );
    rebaseBlocks(b, "n", OLD, OLD.slice(0, 2), [{ card: "x", blocks: ["## 子标题", ROOF] }]);
    expect(e.links.map((l) => l.id)).toEqual(["l"]);
    expect(e.links[0].to).toEqual({ card: "x", block: { i: 1, h: blockSig(ROOF) } });
    expect(danglingRefs(b)).toEqual([]);
  });

  it("blockMap matches unchanged blocks first, also when two blocks read the same", () => {
    expect(blockMap(["a", "same", "b", "same"], ["a", "same", "new", "b", "same"])).toEqual([0, 1, 3, 4]);
    expect(blockMap(["a", "b"], ["b"])).toEqual([-1, 0]);
  });

  it("blockAt prefers the given index, then the nearest block with the same fingerprint", () => {
    const sigs = ["a", "x", "b", "x"].map(blockSig);
    expect(blockAt({ i: 3, h: blockSig("x") }, sigs)).toBe(3);
    expect(blockAt({ i: 2, h: blockSig("x") }, sigs)).toBe(1);
    expect(blockAt({ i: 0, h: blockSig("gone") }, sigs)).toBe(-1);
    expect(blockSig("  para \n")).toBe(blockSig("para"));
  });
});

describe("Note block ends in the board file", () => {
  it("the schema reads a block end and rejects a malformed one; danglingRefs flags a block on a code card or next to a line", () => {
    const b = board([arrow(2)]);
    const file = { ...structuredClone(b), version: BOARD_VERSION, cam: { x: 0, y: 0, z: 1 } };
    expect(upgraded(structuredClone(file)).links[0].to.block).toEqual(ref(OLD, 2));
    (file.links[0].to as { block: unknown }).block = { i: "2", h: "x" };
    expect(() => upgraded(file)).toThrow(/links\.0\.to\.block\.i/);
    const c = board([
      {
        id: "l",
        from: { card: "c", block: { i: 0, h: "x" } },
        to: { card: "n", seg: "s", line: 1, block: { i: 0, h: "y" } },
      },
    ]);
    c.cards.push({ id: "c", kind: "code", segments: [] });
    expect(danglingRefs(c)).toEqual([
      "link l → missing n/s",
      "link l → block on c, which is not a Note",
      "link l → both a block and a line on n",
    ]);
  });

  it("the Markdown export names the block an arrow starts from or points at", () => {
    const b = board([{ id: "l", from: { card: "m" }, to: { card: "n", block: ref(OLD, 2) } }]);
    const md = boardMarkdown(b, { order: ["m", "n"], blocks: (s) => s.split("\n\n") });
    expect(md).toContain("→ 计算强度 at “Roofline 模型把应用画在一张图上：左边的斜线是内存带宽的上限，右边的水平…”");
  });
});
