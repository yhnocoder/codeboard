import { describe, expect, it } from "vitest";
import {
  danglingRefs,
  emptyBoard,
  headingTree,
  mdHeading,
  splitHeadings,
  splitNoteByHeadings,
  type Board,
  type NoteCard,
} from "../src";

const titles = (md: string) => splitHeadings(md)?.parts.map((p) => `${"#".repeat(p.level)} ${p.title} <${p.parent}`);

describe("splitHeadings", () => {
  it("starting at ## splits ## and ### but keeps #### inside, and text before the first heading stays", () => {
    const md = "intro\n\n## A\n\na text\n\n### A1\n\n#### deep\n\nstill A1\n\n## B\n\nb text";
    const sp = splitHeadings(md)!;
    expect(sp.pre).toBe("intro");
    expect(titles(md)).toEqual(["## A <-1", "### A1 <0", "## B <-1"]);
    expect(sp.parts[1].md).toBe("### A1\n\n#### deep\n\nstill A1");
    expect(sp.parts[0].md).toBe("## A\n\na text");
  });
  it("starting at ### splits ### and ####; ##### stays in the card", () => {
    expect(titles("x\n\n### A\n\n#### A1\n\n##### keep\n\n#### A2\n\n### B")).toEqual([
      "### A <-1",
      "#### A1 <0",
      "#### A2 <0",
      "### B <-1",
    ]);
  });
  it("a heading shallower than the first one later on is split too and becomes a top card", () => {
    const md = "x\n\n### A\n\n#### A1\n\n## Summary\n\n### C";
    expect(titles(md)).toEqual(["### A <-1", "#### A1 <0", "## Summary <-1", "### C <2"]);
  });
  it("no headings, or headings only in code blocks and math blocks: nothing to split", () => {
    expect(splitHeadings("just text\n\nmore")).toBeNull();
    expect(splitHeadings("x\n\n```py\n# comment\n## two\n```\n\n$$\n# not\n$$")).toBeNull();
    expect(splitHeadings("x\n\n~~~~\n## a\n~~~\n## b\n~~~~")).toBeNull();
    expect(titles("x\n\n```\n# c\n```\n\n## real")).toEqual(["## real <-1"]);
  });
  it("a Note that starts with its heading keeps the first section, and its sub-headings hang off the Note", () => {
    const sp = splitHeadings("# Title\n\nintro\n\n## A\n\n## B\n\n### B1")!;
    expect(sp.pre).toBe("# Title\n\nintro");
    expect(sp.parts.map((p) => [p.title, p.parent])).toEqual([
      ["A", -1],
      ["B", -1],
    ]);
    expect(sp.parts[1].md).toBe("## B\n\n### B1"); // 第一个标题是 #：### 留在卡里
    expect(
      splitHeadings("## Only\n\ntext\n\n### deeper is split\n\n#### but not this")?.parts.map((p) => p.title),
    ).toEqual(["deeper is split"]);
    expect(splitHeadings("## Only\n\ntext")).toBeNull();
  });
  it("a Note that starts with a heading followed by headings of the same level: they all hang off the Note", () => {
    const sp = splitHeadings("## A\n\na\n\n## B\n\n### B1\n\n## C")!;
    expect(sp.pre).toBe("## A\n\na");
    expect(sp.parts.map((p) => [p.title, p.parent])).toEqual([
      ["B", -1],
      ["B1", 0],
      ["C", -1],
    ]);
  });
  it("closing #s and empty headings", () => {
    expect(titles("x\n\n## A ##\n\n##")).toEqual(["## A <-1", "##  <-1"]);
  });
});

describe("headingTree", () => {
  it("puts children in a row under their parent, centred, rows aligned by depth", () => {
    const at = headingTree({ x: 100, y: 0, w: 300, h: 100 }, [
      { h: 200, parent: -1 },
      { h: 80, parent: 0 },
      { h: 90, parent: 0 },
      { h: 150, parent: -1 },
    ]);
    // 原卡下面一行：A（带两个子卡，宽 628）和 B；整体以原卡为中心
    expect(at[0].y).toBe(156);
    expect(at[3].y).toBe(156);
    expect(at[1].y).toBe(156 + 200 + 56);
    expect(at[2].y).toBe(at[1].y);
    expect(at[2].x - at[1].x).toBe(328);
    expect(at[0].x + 150).toBe((at[1].x + at[2].x + 300) / 2); // A 在两个子卡中间
    expect((at[1].x + at[3].x + 300) / 2).toBe(250); // 整棵树在原卡下居中
  });
  it("moves the new cards down past cards already there", () => {
    const at = headingTree(
      { x: 0, y: 0, w: 300, h: 100 },
      [{ h: 100, parent: -1 }],
      [{ x: 0, y: 150, w: 300, h: 200 }],
    );
    expect(at[0].y).toBeGreaterThanOrEqual(350);
  });
});

describe("splitNoteByHeadings", () => {
  const board = (md: string): Board => ({
    ...emptyBoard("b", "B"),
    cards: [{ id: "n", kind: "note", md, look: "note" }],
    place: { n: { x: 0, y: 0, w: 381, h: 500, section: "s" } },
    sections: [{ id: "s", title: "S", x: -50, y: -50, w: 100, h: 100 }],
  });
  it("adds a Note per heading with solid arrows parent → child, the Note keeps the intro", () => {
    const b = board("intro\n\n## A\n\na\n\n### A1\n\n## B");
    const ids = splitNoteByHeadings(b, "n", { ids: ["a", "a1", "bb"] })!;
    expect(ids).toEqual(["a", "a1", "bb"]);
    expect((b.cards[0] as NoteCard).md).toBe("intro");
    expect(b.cards.map((c) => [c.id, c.kind === "note" && mdHeading(c.md)])).toEqual([
      ["n", ""],
      ["a", "A"],
      ["a1", "A1"],
      ["bb", "B"],
    ]);
    expect(b.links.map((l) => `${l.from.card}→${l.to.card}${l.style ? "!" : ""}`)).toEqual(["n→a", "a→a1", "n→bb"]);
    expect(b.place.n.h).toBeUndefined();
    expect(b.place.a).toMatchObject({ w: 381, section: "s" });
    expect(b.place.a1.y).toBeGreaterThan(b.place.a.y);
    expect(danglingRefs(b)).toEqual([]);
  });
  it("a Note that starts with its heading and has same-level headings after it: the new Note sits under it, linked", () => {
    const b = board("## A\n\na\n\n| x | y |\n| :-: | :-: |\n| 1 | 2 |\n\n## B\n\n$$\n1/2\n$$");
    expect(splitNoteByHeadings(b, "n", { ids: ["bb"] })).toEqual(["bb"]);
    expect((b.cards[0] as NoteCard).md).toContain("## A");
    expect(b.links.map((l) => `${l.from.card}→${l.to.card}`)).toEqual(["n→bb"]);
    expect(b.place.bb.y).toBeGreaterThan(0); // 新卡在原卡下面，不是 NaN（看不见）
    expect(Number.isFinite(b.place.bb.x)).toBe(true);
    expect(danglingRefs(b)).toEqual([]);
  });
  it("does nothing without a heading to split at", () => {
    const b = board("no headings");
    expect(splitNoteByHeadings(b, "n")).toBeNull();
    expect(b.cards).toHaveLength(1);
    expect(b.place.n.h).toBe(500);
  });
});
