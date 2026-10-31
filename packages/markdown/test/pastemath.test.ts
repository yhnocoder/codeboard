// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DOMParser as PMParser, type Node as PMNode } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";
import { mdSchema, parseMd, pastedMd, serializeMd, texBrackets } from "../src/schema";
import { mathInSlice } from "../src/editor/pastemath";

// A chat app's answer with formulas next to CJK text and punctuation, \text{…} with dots,
// single letters, and "(1,2)" between two formulas
const PARA =
  "偏移为 $\\text{threadIdx.y} \\times 4 + \\text{threadIdx.x}$。例如，元素 (1,2) 的偏移是 $1 \\times 4 + 2 = 6$。相比之下，偏移变为 $\\text{threadIdx.x} \\times 3 + \\text{threadIdx.y}$，同一个元素 (1,2) 的偏移就是 $2 \\times 3 + 1 = 7$。";
const PARA_TEX = [
  "\\text{threadIdx.y} \\times 4 + \\text{threadIdx.x}",
  "1 \\times 4 + 2 = 6",
  "\\text{threadIdx.x} \\times 3 + \\text{threadIdx.y}",
  "2 \\times 3 + 1 = 7",
];
const ROWS =
  "推广到 $M$ 行 $N$ 列的矩阵，先用 $\\text{row} = \\text{blockIdx.y} \\times \\text{blockDim.y} + \\text{threadIdx.y}$、$\\text{col} = \\text{blockIdx.x}$ 算出全局坐标：";
const ROWS_TEX = [
  "M",
  "N",
  "\\text{row} = \\text{blockIdx.y} \\times \\text{blockDim.y} + \\text{threadIdx.y}",
  "\\text{col} = \\text{blockIdx.x}",
];

const flat = (ns: JSONContent[] | undefined, out: JSONContent[] = []): JSONContent[] => {
  for (const n of ns ?? []) {
    out.push(n);
    flat(n.content, out);
  }
  return out;
};
const texOf = (doc: JSONContent) =>
  flat(doc.content)
    .filter((n) => n.type === "inlineMath")
    .map((n) => n.attrs!.latex);
const textOf = (doc: JSONContent) =>
  flat(doc.content)
    .filter((n) => n.type === "text")
    .map((n) => n.text)
    .join("");

describe("inline formulas in Markdown", () => {
  it("reads every $…$ next to CJK text and punctuation, with \\text{…}, dots and single letters", () => {
    const doc = parseMd(`${PARA}\n\n${ROWS}`);
    expect(texOf(doc)).toEqual([...PARA_TEX, ...ROWS_TEX]);
    expect(textOf(doc)).not.toContain("$");
    expect(textOf(doc)).toContain("。例如，元素 (1,2) 的偏移是 ");
  });

  it("keeps prices, escaped dollars and a $ right after a formula as text", () => {
    expect(texOf(parseMd("costs $5 and $10 today"))).toEqual([]);
    expect(texOf(parseMd("\\$x$ and \\$y\\$"))).toEqual([]);
    expect(texOf(parseMd("中文$x$中文"))).toEqual(["x"]);
  });

  it("writes literal dollars so that they read back as the same text, however they pair", () => {
    // what an HTML paste used to leave: the $ as plain text. Escaping only the $ that opens a formula left its closing $ free to
    // pair with the next formula's, which read back as one formula "。例如，元素 (1,2) 的偏移是 \$1 …"
    for (const t of [PARA, ROWS, "$a$$b$", "a $x$ b $5 and $y$", "$$x$$ then $y$"]) {
      const md = serializeMd({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
      const back = parseMd(md);
      expect(texOf(back), md).toEqual([]);
      expect(textOf(back), md).toBe(t);
    }
    // a lone $ or prices need no escaping
    expect(serializeMd(parseMd("costs $5 and $10 today"))).toBe("costs $5 and $10 today");
  });
});

/** What ProseMirror makes of pasted HTML (the editor's clipboard parser), then the editor's paste step for formulas */
function pasteHtml(html: string): PMNode {
  const schema = mdSchema();
  const box = document.createElement("div");
  box.innerHTML = html;
  const slice = PMParser.fromSchema(schema).parseSlice(box);
  const fixed = mathInSlice(slice, schema) ?? slice;
  return schema.nodes.doc.create(null, fixed.content);
}
const nodes = (doc: PMNode) => {
  const out: PMNode[] = [];
  doc.descendants((n) => {
    out.push(n);
  });
  return out;
};

describe("pasting HTML with formulas", () => {
  it("turns literal $…$ left in a chat app's paragraphs into formulas, not code spans", () => {
    const doc = pasteHtml(
      `<p><strong>Row-major</strong></p><p>${PARA}</p><p>${ROWS}</p><hr><p>用 <code>$x$</code> 和 <code>Pin[row][col]</code></p>`,
    );
    const all = nodes(doc);
    expect(all.filter((n) => n.type.name === "inlineMath").map((n) => n.attrs.latex)).toEqual([
      ...PARA_TEX,
      ...ROWS_TEX,
    ]);
    const text = all
      .filter((n) => n.isText && !n.marks.some((m) => m.type.name === "code"))
      .map((n) => n.text)
      .join("");
    expect(text).not.toContain("$");
    expect(text).toContain("。例如，元素 (1,2) 的偏移是 ");
    expect(all.filter((n) => n.marks.some((m) => m.type.name === "code")).map((n) => n.text)).toEqual([
      "$x$",
      "Pin[row][col]",
    ]);
    expect(all.some((n) => n.type.name === "horizontalRule")).toBe(true);
  });

  it("turns a paragraph of $$ … $$ into a formula block, on one line or across <br>", () => {
    for (const p of ["$$ x^2 + y $$", "$$<br>x^2 + y<br>$$"]) {
      const doc = pasteHtml(`<p>before</p><p>${p}</p>`);
      expect(doc.child(1).type.name, p).toBe("blockMath");
      expect(doc.child(1).attrs.latex, p).toBe("x^2 + y");
    }
  });

  it("reads formulas drawn by KaTeX or MathML from their TeX annotation", () => {
    const ann = (tex: string, block = false) =>
      `<math xmlns="http://www.w3.org/1998/Math/MathML"${block ? ' display="block"' : ""}><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math>`;
    const katex = (tex: string) =>
      `<span class="katex"><span class="katex-mathml">${ann(tex)}</span><span class="katex-html" aria-hidden="true">drawn</span></span>`;
    const doc = pasteHtml(
      `<p>偏移为${katex("1 \\times 4")}，第 ${ann("M")} 行</p><span class="katex-display">${katex("\\sum_i x_i")}</span><p>${ann("a+b", true)}</p>`,
    );
    const all = nodes(doc);
    expect(all.filter((n) => n.type.name === "inlineMath").map((n) => n.attrs.latex)).toEqual(["1 \\times 4", "M"]);
    expect(all.filter((n) => n.type.name === "blockMath").map((n) => n.attrs.latex)).toEqual(["\\sum_i x_i", "a+b"]);
    expect(doc.textContent).not.toContain("drawn");
  });
});

// An H100 occupancy explanation whose display formulas are LaTeX's \[ … \] on their own lines, with spaces
const OCCUPANCY = [
  "个线程。此时 occupancy 为",
  "",
  "\\[",
  " 1024/2048 = 50\\% ",
  "\\]",
  "",
  "因此，要充分利用线程槽位并达到最大 occupancy，每个 thread block 至少需要 64 个线程。",
  "",
  "假设一个 kernel 每线程使用 31 个寄存器，并配置为每 block 512 个线程。SM 同时运行",
  "",
  "\\[",
  " 2048/512 = 4 ",
  "\\]",
  "",
  "个 block，共使用",
  "",
  "\\[",
  " 2048 \\times 31 = 63,488 ",
  "\\]",
  "",
  "个寄存器。",
].join("\n");
const OCC_TEX = ["1024/2048 = 50\\%", "2048/512 = 4", "2048 \\times 31 = 63,488"];

describe("LaTeX \\( … \\) and \\[ … \\] in pasted text", () => {
  it("reads \\[ … \\] on their own lines as formula blocks and \\( … \\) next to CJK text as inline formulas", () => {
    const doc = pastedMd(OCCUPANCY)!;
    expect(doc.content!.filter((n) => n.type === "blockMath").map((n) => n.attrs!.latex)).toEqual(OCC_TEX);
    expect(textOf(doc)).not.toContain("\\[");
    expect(serializeMd(doc)).toContain("$$\n2048 \\times 31 = 63,488\n$$");
    const inl = pastedMd("偏移为\\(\\text{row} \\times N\\)，元素 \\( x_1 \\) 和 \\[a+b\\] 在行内")!;
    expect(
      flat(inl.content)
        .filter((n) => n.type === "inlineMath")
        .map((n) => [n.attrs!.latex, n.attrs!.display]),
    ).toEqual([
      ["\\text{row} \\times N", false],
      ["x_1", false],
      ["a+b", true],
    ]);
    expect(textOf(inl)).toBe("偏移为，元素  和  在行内");
  });

  it("leaves them alone in code, existing formulas, link addresses and escaped backslashes, and when unpaired", () => {
    const md = "`\\(a\\)` 和\n\n```\n\\[b\\]\n```\n\n$x \\(c\\) y$ 与 [l](u\\(d\\)) 和 \\\\(e\\) 和 \\(f 没配上";
    expect(texBrackets(md)).toBe(md);
    expect(texBrackets("- 列表 \\(a\\)\n> 引用 \\[b\\]")).toBe("- 列表 $a$\n> 引用 $$b$$");
    expect(texBrackets("不跨段 \\(a\n\nb\\)")).toBe("不跨段 \\(a\n\nb\\)");
  });

  it("works when the paste has a table, also inside its cells", () => {
    const md =
      "| 大小 | occupancy |\n| :---: | :---: |\n| 1024 | \\(50\\%\\) |\n\n即\n\n\\[\n 32 \\times 32 = 1024 \n\\]";
    expect(texBrackets(md)).toBe(
      "| 大小 | occupancy |\n| :---: | :---: |\n| 1024 | $50\\%$ |\n\n即\n\n$$\n 32 \\times 32 = 1024 \n$$",
    );
    expect(pastedMd(md)!.content!.some((n) => n.type === "blockMath")).toBe(true);
  });

  it("turns them into formulas in pasted HTML too, but not inside <code>", () => {
    const doc = pasteHtml(
      `<p>此时 occupancy 为</p><p>\\[<br> 1024/2048 = 50\\% <br>\\]</p><p>\\[ 2048/512 = 4 \\]</p><p>偏移 \\(x_1\\)，代码 <code>\\(y\\)</code></p>`,
    );
    const all = nodes(doc);
    expect(all.filter((n) => n.type.name === "blockMath").map((n) => n.attrs.latex)).toEqual(OCC_TEX.slice(0, 2));
    expect(all.filter((n) => n.type.name === "inlineMath").map((n) => n.attrs.latex)).toEqual(["x_1"]);
    expect(all.filter((n) => n.marks.some((m) => m.type.name === "code")).map((n) => n.text)).toEqual(["\\(y\\)"]);
  });
});
