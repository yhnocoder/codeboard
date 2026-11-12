// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cutMdBlocks, findMdBlocks, insertMdBlocks, moveMdBlocks } from "../src/blockmove";

const SRC = "# T\n\nOne.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nx\n```\n\nTwo.\n\n```js\ny\n```";

describe("moving Markdown blocks", () => {
  it("cuts blocks out, keeping the others as written, and the layout goes with its table and code block", () => {
    const r = cutMdBlocks({ md: SRC, layout: { tables: [{ cols: [40, null] }], wrap: [1] } }, 2, 4)!;
    expect(r.part).toEqual({
      md: "| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nx\n```",
      layout: { tables: [{ cols: [40, null] }] },
    });
    expect(r.rest).toEqual({ md: "# T\n\nOne.\n\nTwo.\n\n```js\ny\n```", layout: { wrap: [0] } });
  });
  it("inserts blocks before a block or at the end, renumbering the layout", () => {
    const part = { md: "```c\nz\n```", layout: { wrap: [0] } };
    expect(insertMdBlocks({ md: "A\n\n```py\nx\n```", layout: { wrap: [0] } }, 1, part)).toEqual({
      md: "A\n\n```c\nz\n```\n\n```py\nx\n```",
      layout: { wrap: [0, 1] },
    });
    expect(insertMdBlocks({ md: "A", layout: null }, 1, { md: "B", layout: null })).toEqual({
      md: "A\n\nB",
      layout: null,
    });
    expect(insertMdBlocks({ md: "", layout: null }, 0, { md: "B", layout: null })).toEqual({ md: "B", layout: null });
  });
  it("moves blocks inside one text, down and up; a move onto itself is nothing", () => {
    const md = "A\n\nB\n\nC\n\nD";
    expect(moveMdBlocks({ md, layout: null }, 0, 2, 4)?.md).toBe("C\n\nD\n\nA\n\nB");
    expect(moveMdBlocks({ md, layout: null }, 2, 3, 0)?.md).toBe("C\n\nA\n\nB\n\nD");
    expect(moveMdBlocks({ md, layout: null }, 1, 2, 2)).toBeNull();
  });
  it("finds blocks by what they say, however they are written, nearest to a hint", () => {
    expect(findMdBlocks("A\n\n* x\n* y\n\nB\n\n- x\n- y", "- x\n- y", 3)).toEqual([3, 4]);
    expect(findMdBlocks("A\n\n* x\n* y\n\nB\n\n- x\n- y", "- x\n- y", 0)).toEqual([1, 2]);
    expect(findMdBlocks("A\n\nB", "C", 0)).toBeNull();
  });
});
