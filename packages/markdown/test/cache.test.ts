// @vitest-environment jsdom
// A Markdown instance's caches are bounded: past their size the oldest entry goes first
import { describe, expect, it } from "vitest";
import { capped, cappedAdd } from "../src/cache";
import { createMarkdown } from "../src/markdown";

describe("bounded caches", () => {
  it("drop the oldest entry once full, and keep a rewritten one in place", () => {
    const m = new Map<string, number>();
    for (const k of ["a", "b", "c"]) capped(m, 3, k, 1);
    capped(m, 3, "b", 2);
    expect([...m.keys()]).toEqual(["a", "b", "c"]);
    capped(m, 3, "d", 1);
    expect([...m.keys()]).toEqual(["b", "c", "d"]);
    const s = new Set<string>();
    for (const k of ["a", "b", "c", "d"]) cappedAdd(s, 3, k);
    expect([...s]).toEqual(["b", "c", "d"]);
  });

  it("the render cache follows its instance's preamble", () => {
    const md = createMarkdown();
    md.render("$x$");
    expect(md.isCached("$x$")).toBe(true);
    md.setMathPreamble("\\newcommand{\\y}{1}");
    expect(md.isCached("$x$")).toBe(false);
  });
});
