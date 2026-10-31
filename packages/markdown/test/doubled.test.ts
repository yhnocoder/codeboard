// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DOMParser as PMParser, type Node as PMNode } from "@tiptap/pm/model";
import { mdSchema, parseMd } from "../src/schema";
import { mathInSlice } from "../src/editor/pastemath";
import { undoubleTex } from "../src/doubled";

// Copied as text from a web page and an e-book: each typeset formula comes out as the shown text
// followed by its TeX ("N×N" + "N\times N")
const DOUBLED: [string, string][] = [
  ["本章采用一种简化方法：取围绕目标像素并包含目标像素在内的 N×NN\\times N 像素块的简单平均值。",
    "本章采用一种简化方法：取围绕目标像素并包含目标像素在内的 $N\\times N$ 像素块的简单平均值。"],
  ["注意，图 3.2 中 y 方向多生成了 2 个线程，x 方向多生成了 4 个线程。也就是说，为了处理 62×7662\\times76 个像素，我们总共生成了 64×8064\\times80 个线程。",
    "注意，图 3.2 中 y 方向多生成了 2 个线程，x 方向多生成了 4 个线程。也就是说，为了处理 $62\\times76$ 个像素，我们总共生成了 $64\\times80$ 个线程。"],
  ["假设我们选择 16×1616\\times16 的 thread block，即 x 方向和 y 方向各有 16 个线程。需要在 y 方向使用 4 个 thread block，在 x 方向使用 5 个 thread block，因此总共需要 4×5=204\\times5=20 个 thread block",
    "假设我们选择 $16\\times16$ 的 thread block，即 x 方向和 y 方向各有 16 个线程。需要在 y 方向使用 4 个 thread block，在 x 方向使用 5 个 thread block，因此总共需要 $4\\times5=20$ 个 thread block"],
  ["图 3.2 展示了这种处理方式，输入图片 Pin 的大小为 62×7662\\times76（垂直方向或 y 方向有 62 个像素，水平方向或 x 方向有 76 个像素）。假设我们选择 16×1616\\times16 的 thread block，即 x 方向和 y 方向各有 16 个线程。需要在 y 方向使用 4 个 thread block，在 x 方向使用 5 个 thread block，因此总共需要 4×5=204\\times5=20 个 thread block,",
    "图 3.2 展示了这种处理方式，输入图片 Pin 的大小为 $62\\times76$（垂直方向或 y 方向有 62 个像素，水平方向或 x 方向有 76 个像素）。假设我们选择 $16\\times16$ 的 thread block，即 x 方向和 y 方向各有 16 个线程。需要在 y 方向使用 4 个 thread block，在 x 方向使用 5 个 thread block，因此总共需要 $4\\times5=20$ 个 thread block,"],
];

describe("formulas copied as shown text + TeX", () => {
  it("keeps only the TeX, as $…$, in text from a web page or an e-book", () => {
    for (const [pasted, want] of DOUBLED) expect(undoubleTex(pasted)).toBe(want);
  });

  it("handles fractions, scripts, Greek letters and English text after the formula", () => {
    expect(undoubleTex("面积 x2x^2 与 ab\\frac{a}{b}")).toBe("面积 $x^2$ 与 $\\frac{a}{b}$");
    expect(undoubleTex("the N×NN\\times N pixels and αβ\\alpha\\beta here")).toBe("the $N\\times N$ pixels and $\\alpha\\beta$ here");
  });

  it("leaves TeX that is not doubled, paths, code and existing $…$ alone", () => {
    for (const t of ["写 $N\\times N$ 就行", "N\\times N 原文", "C:\\Users\\x\\bin", 'printf("%d\\n", a_b[i]);', "a_b and x^y", "\\frac{a}{b}"]) expect(undoubleTex(t)).toBe(t);
  });

  it("stays fast on a whole pasted TeX source", () => {
    const src = "\\begin{align} a_{i,j} &= \\sum_{k=0}^{n} b_{i,k} c_{k,j} + \\frac{\\alpha x^2 + \\beta y^2}{\\gamma z_0 + 1} \\\\\n".repeat(200);
    const t0 = process.cpuUsage();
    expect(undoubleTex(src)).toBe(src);
    const u = process.cpuUsage(t0);
    expect((u.user + u.system) / 1000).toBeLessThan(1000);
  });

  it("reads the paste into formulas as Markdown text and as HTML paragraphs", () => {
    const schema = mdSchema();
    for (const [pasted, want] of DOUBLED) {
      const tex = [...want.matchAll(/\$([^$]+)\$/g)].map((m) => m[1]);
      const md = parseMd(undoubleTex(pasted));
      const fromMd: string[] = [];
      JSON.stringify(md, (k, v) => { if (v?.type === "inlineMath") fromMd.push(v.attrs.latex); return v; });
      expect(fromMd).toEqual(tex);
      const box = document.createElement("div");
      box.innerHTML = `<p>${pasted}</p>`;
      const fixed = mathInSlice(PMParser.fromSchema(schema).parseSlice(box), schema)!;
      const nodes: PMNode[] = [];
      fixed.content.descendants((n) => { nodes.push(n); });
      expect(nodes.filter((n) => n.type.name === "inlineMath").map((n) => n.attrs.latex)).toEqual(tex);
      expect(nodes.filter((n) => n.isText).map((n) => n.text).join("")).not.toMatch(/×|\\times/);
    }
  });
});
