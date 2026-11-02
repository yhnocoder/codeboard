// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { coreOf, createMarkdown, type Markdown } from "../src/markdown";
import type { MathPreamble } from "../src/math";
import { checkMath, completions, tokenAt, type MathProblem, type Part } from "../src/editor/mathhints";

const PRE =
  "\\newcommand{\\tid}{\\text{threadIdx.x}}\n\\newcommand{\\R}{\\mathbb{R}}\n\\def\\pair#1#2{(#1,#2)}\n\\newcommand{\\norm}[1]{\\lVert #1\n\\rVert}";
// KaTeX draws a command it does not know as red text
const red = (html: string) => (html.match(/class="mord text" style="color:#cc0000;"/g) ?? []).length;
const text = (p: MathProblem | null | undefined) =>
  (p?.parts ?? []).map((x: Part) => (typeof x === "string" ? x : "code" in x ? x.code : `[${x.fix}]`)).join("");
const fixOf = (p: MathProblem | null | undefined) =>
  p?.parts.find((x): x is Extract<Part, { fix: string }> => typeof x === "object" && "fix" in x);

let markdown: Markdown, math: MathPreamble;
beforeEach(() => {
  markdown = createMarkdown();
  math = coreOf(markdown).math;
});

describe("math preamble", () => {
  it("defines commands for the static render, with arguments, \\def and definitions over several lines", () => {
    expect(red(markdown.render("$\\tid + \\pair{a}{b} + \\norm{x}$"))).toBe(3);
    markdown.setMathPreamble(PRE);
    const h = markdown.render("$\\tid + \\pair{a}{b} + \\norm{x} \\in \\R$");
    expect(red(h)).toBe(0);
    expect(h).toContain("threadIdx.x");
    expect(math.definitions().map((d) => [d.name, d.args])).toEqual([
      ["tid", 0],
      ["R", 0],
      ["pair", 2],
      ["norm", 1],
    ]);
    expect(markdown.mathPreambleErrors()).toEqual([]);
  });

  it("clears the render cache when it changes", () => {
    markdown.setMathPreamble("\\newcommand{\\tid}{AAA}");
    expect(markdown.render("$\\tid$")).toMatch(/>A+</);
    markdown.setMathPreamble("\\newcommand{\\tid}{BBB}");
    expect(markdown.render("$\\tid$")).toMatch(/>B+</);
  });

  it("keeps a \\newcommand written in one formula out of the others", () => {
    markdown.setMathPreamble(PRE);
    const h = markdown.render("$\\newcommand{\\two}{2}\\two$ and $\\two$");
    expect(red(h)).toBe(1);
    expect(Object.keys(markdown.mathMacros())).not.toContain("\\two");
  });

  it("is each instance's own", () => {
    const other = createMarkdown({ mathPreamble: "\\newcommand{\\tid}{BBB}" });
    markdown.setMathPreamble("\\newcommand{\\tid}{AAA}");
    expect(markdown.render("$\\tid$")).toMatch(/>A+</);
    expect(other.render("$\\tid$")).toMatch(/>B+</);
  });

  it("reports a bad line and keeps the others", () => {
    markdown.setMathPreamble("\\newcommand{\\bad}{\\frac{1}\n\\newcommand{\\ok}{1}");
    expect(markdown.mathPreambleErrors().length).toBe(1);
    expect(red(markdown.render("$\\ok$"))).toBe(0);
  });
});

describe("command completion", () => {
  it("finds the command being typed, not after \\\\", () => {
    expect(tokenAt("a + \\fr", 7)).toEqual({ q: "fr", from: 4 });
    expect(tokenAt("a \\\\", 4)).toBeNull();
    expect(tokenAt("a \\\\ \\", 6)).toEqual({ q: "", from: 5 });
  });

  it("lists prefix matches first, preamble commands tagged 预设, this formula's tagged 本式", () => {
    markdown.setMathPreamble(PRE);
    expect(completions("fr", "", math)[0].name).toBe("frac");
    expect(
      completions("ti", "", math)
        .map((c) => c.name)
        .slice(0, 3),
    ).toEqual(["tid", "times", "tilde"]);
    const all = completions("", "\\newcommand{\\half}{\\frac12} \\", math);
    expect(all.slice(0, 5).map((c) => [c.name, c.tag])).toEqual([
      ["tid", "预设"],
      ["R", "预设"],
      ["pair", "预设"],
      ["norm", "预设"],
      ["half", "本式"],
    ]);
    expect(completions("pa", "", math).find((c) => c.name === "pair")?.snip).toBe("\\pair{|}{}");
  });

  it("closes when a command without arguments is typed out", () => {
    expect(completions("times", "", math)).toEqual([]);
    expect(completions("frac", "", math).map((c) => c.name)).toEqual(["frac"]);
  });
});

describe("plain errors", () => {
  it("renders good formulas", () => {
    expect(checkMath("a \\times b", true, math).html).toContain("katex");
  });

  it("suggests the nearest command, preamble ones included, with the place to replace", () => {
    markdown.setMathPreamble(PRE);
    const p = checkMath("a \\tims b", false, math).problem!;
    expect(text(p)).toBe("不认识 \\tims 这个命令。 是不是想写 [\\times]？");
    expect(fixOf(p)).toMatchObject({ from: 2, to: 7, text: "\\times" });
    expect(p.at).toBe(2);
    expect(fixOf(checkMath("i + \\tidd", false, math).problem)).toMatchObject({ text: "\\tid", from: 4, to: 9 });
  });

  it("does not complain while a command name can still complete", () => {
    expect(checkMath("a + \\fr", false, math).problem).toBeNull();
    expect(checkMath("a + \\fr", false, math, 3).problem).not.toBeNull();
    expect(checkMath("a + \\zzz", false, math).problem).not.toBeNull();
  });

  it("explains a missing or extra }", () => {
    const miss = checkMath("\\frac{n + 255}{256", false, math).problem!;
    expect(text(miss)).toContain("少了一个 }");
    expect(fixOf(miss)).toMatchObject({ from: 18, to: 18, text: "}" });
    const extra = checkMath("a } b", false, math).problem!;
    expect(text(extra)).toContain("多了一个 }");
    expect(fixOf(extra)).toMatchObject({ from: 2, to: 3, text: "" });
  });

  it("explains double subscripts, empty ^ and redefining a preamble command", () => {
    expect(text(checkMath("x_i_j", false, math).problem)).toContain("只能有一个下标");
    expect(text(checkMath("x^", false, math).problem)).toContain("后面还没写东西");
    markdown.setMathPreamble(PRE);
    const p = checkMath("\\newcommand{\\tid}{y} \\tid", false, math).problem!;
    expect(text(p)).toContain("\\renewcommand");
    expect(fixOf(p)).toMatchObject({ from: 0, to: 11, text: "\\renewcommand" });
  });
});
