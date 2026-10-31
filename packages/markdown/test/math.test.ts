// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderMd } from "../src/render";
import { mathMacros, mathPreambleDefs, mathPreambleErrors, setMathPreamble } from "../src/math";
import { checkMath, completions, tokenAt, type MathProblem, type Part } from "../src/editor/mathhints";

const PRE =
  "\\newcommand{\\tid}{\\text{threadIdx.x}}\n\\newcommand{\\R}{\\mathbb{R}}\n\\def\\pair#1#2{(#1,#2)}\n\\newcommand{\\norm}[1]{\\lVert #1\n\\rVert}";
// KaTeX draws a command it does not know as red text
const red = (html: string) => (html.match(/class="mord text" style="color:#cc0000;"/g) ?? []).length;
const text = (p: MathProblem | null | undefined) =>
  (p?.parts ?? []).map((x: Part) => (typeof x === "string" ? x : "code" in x ? x.code : `[${x.fix}]`)).join("");
const fixOf = (p: MathProblem | null | undefined) =>
  p?.parts.find((x): x is Extract<Part, { fix: string }> => typeof x === "object" && "fix" in x);

afterEach(() => {
  setMathPreamble("");
});

describe("math preamble", () => {
  it("defines commands for the static render, with arguments, \\def and definitions over several lines", () => {
    expect(red(renderMd("$\\tid + \\pair{a}{b} + \\norm{x}$"))).toBe(3);
    setMathPreamble(PRE);
    const h = renderMd("$\\tid + \\pair{a}{b} + \\norm{x} \\in \\R$");
    expect(red(h)).toBe(0);
    expect(h).toContain("threadIdx.x");
    expect(mathPreambleDefs().map((d) => [d.name, d.args])).toEqual([
      ["tid", 0],
      ["R", 0],
      ["pair", 2],
      ["norm", 1],
    ]);
    expect(mathPreambleErrors()).toEqual([]);
  });

  it("clears the render cache when it changes", () => {
    setMathPreamble("\\newcommand{\\tid}{AAA}");
    expect(renderMd("$\\tid$")).toMatch(/>A+</);
    setMathPreamble("\\newcommand{\\tid}{BBB}");
    expect(renderMd("$\\tid$")).toMatch(/>B+</);
  });

  it("keeps a \\newcommand written in one formula out of the others", () => {
    setMathPreamble(PRE);
    const h = renderMd("$\\newcommand{\\two}{2}\\two$ and $\\two$");
    expect(red(h)).toBe(1);
    expect(Object.keys(mathMacros())).not.toContain("\\two");
  });

  it("reports a bad line and keeps the others", () => {
    setMathPreamble("\\newcommand{\\bad}{\\frac{1}\n\\newcommand{\\ok}{1}");
    expect(mathPreambleErrors().length).toBe(1);
    expect(red(renderMd("$\\ok$"))).toBe(0);
  });
});

describe("command completion", () => {
  it("finds the command being typed, not after \\\\", () => {
    expect(tokenAt("a + \\fr", 7)).toEqual({ q: "fr", from: 4 });
    expect(tokenAt("a \\\\", 4)).toBeNull();
    expect(tokenAt("a \\\\ \\", 6)).toEqual({ q: "", from: 5 });
  });

  it("lists prefix matches first, preamble commands tagged 预设, this formula's tagged 本式", () => {
    setMathPreamble(PRE);
    expect(completions("fr", "")[0].name).toBe("frac");
    expect(
      completions("ti", "")
        .map((c) => c.name)
        .slice(0, 3),
    ).toEqual(["tid", "times", "tilde"]);
    const all = completions("", "\\newcommand{\\half}{\\frac12} \\");
    expect(all.slice(0, 5).map((c) => [c.name, c.tag])).toEqual([
      ["tid", "预设"],
      ["R", "预设"],
      ["pair", "预设"],
      ["norm", "预设"],
      ["half", "本式"],
    ]);
    expect(completions("pa", "").find((c) => c.name === "pair")?.snip).toBe("\\pair{|}{}");
  });

  it("closes when a command without arguments is typed out", () => {
    expect(completions("times", "")).toEqual([]);
    expect(completions("frac", "").map((c) => c.name)).toEqual(["frac"]);
  });
});

describe("plain errors", () => {
  it("renders good formulas", () => {
    expect(checkMath("a \\times b", true).html).toContain("katex");
  });

  it("suggests the nearest command, preamble ones included, with the place to replace", () => {
    setMathPreamble(PRE);
    const p = checkMath("a \\tims b", false).problem!;
    expect(text(p)).toBe("不认识 \\tims 这个命令。 是不是想写 [\\times]？");
    expect(fixOf(p)).toMatchObject({ from: 2, to: 7, text: "\\times" });
    expect(p.at).toBe(2);
    expect(fixOf(checkMath("i + \\tidd", false).problem)).toMatchObject({ text: "\\tid", from: 4, to: 9 });
  });

  it("does not complain while a command name can still complete", () => {
    expect(checkMath("a + \\fr", false).problem).toBeNull();
    expect(checkMath("a + \\fr", false, 3).problem).not.toBeNull();
    expect(checkMath("a + \\zzz", false).problem).not.toBeNull();
  });

  it("explains a missing or extra }", () => {
    const miss = checkMath("\\frac{n + 255}{256", false).problem!;
    expect(text(miss)).toContain("少了一个 }");
    expect(fixOf(miss)).toMatchObject({ from: 18, to: 18, text: "}" });
    const extra = checkMath("a } b", false).problem!;
    expect(text(extra)).toContain("多了一个 }");
    expect(fixOf(extra)).toMatchObject({ from: 2, to: 3, text: "" });
  });

  it("explains double subscripts, empty ^ and redefining a preamble command", () => {
    expect(text(checkMath("x_i_j", false).problem)).toContain("只能有一个下标");
    expect(text(checkMath("x^", false).problem)).toContain("后面还没写东西");
    setMathPreamble(PRE);
    const p = checkMath("\\newcommand{\\tid}{y} \\tid", false).problem!;
    expect(text(p)).toContain("\\renewcommand");
    expect(fixOf(p)).toMatchObject({ from: 0, to: 11, text: "\\renewcommand" });
  });
});
