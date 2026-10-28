// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mdBlockStarts, parseMd } from "../src/schema";

const blocksAt = (src: string) => mdBlockStarts(src)?.map((s, i, all) => src.slice(s, all[i + 1] ?? src.length).trimEnd());

describe("mdBlockStarts", () => {
  it("gives where each top-level block starts, one per block of parseMd", () => {
    const src = "# Title\n\nFirst paragraph\nstill first.\n\n- a\n- b\n\n```py\nx = 1\n```\n\n$$\nx^2\n$$\n\n> quote\n\n![](assets/a.png){width=40%}\n\nlast";
    const parts = blocksAt(src);
    expect(parts).toEqual(["# Title", "First paragraph\nstill first.", "- a\n- b", "```py\nx = 1\n```", "$$\nx^2\n$$", "> quote", "![](assets/a.png){width=40%}", "last"]);
    expect(parts!.length).toBe(parseMd(src).content!.length);
  });
  it("gives null when blocks and words don't line up (extra blank lines read as empty paragraphs, footnote definitions)", () => {
    expect(mdBlockStarts("a\n\n\n\n\nb")).toBeNull();
    expect(mdBlockStarts("a[^1]\n\n[^1]: note")).toBeNull();
    expect(mdBlockStarts("a\r\n\r\nb")).toBeNull();
  });
  it("one paragraph, and an empty Note", () => {
    expect(mdBlockStarts("just text")).toEqual([0]);
    expect(mdBlockStarts("")).toEqual([]);
  });
});
