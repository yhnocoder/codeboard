// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { parseMd, serializeMd, sourceExtensions } from "../src/schema";
import { renderMd } from "../src/render";
import { applyMdLayout } from "../src/layout";
import { layoutOf, sameLayout, sourceDoc, sourceMd } from "../src/editor/srcdoc";
import { docAt, mdAt } from "../src/editor/srcmode";

const schema = getSchema(sourceExtensions);
const SAMPLES = [
  '# T\n\npara **b** *i* `c` $x$ [l](https://u) ![a](i.png "cap"){width=40%}',
  "- a\n- b\n  - c\n\n1. x\n2. y",
  "> q **b**\n\n- [ ] t\n- [x] d",
  "| a | b |\n| :- | -: |\n| x\\|y | `a|b` |\n| **c** | |",
  "```py\nx = 1\n```\n\n$$\nE=mc^2\n$$",
  "ref[^1] and[^2]\n\n[^1]: the note\n[^2]: two\n    more",
  "a \\* b and \\$5 and 2*3*4",
  "<details>\n<summary>S</summary>\n\nbody\n\n</details>",
  "[toc]\n\n---\n\ntext :smile: [[Ref]] {a|note} ==hl== H~2~O x^2^ <u>u</u> <kbd>K</kbd>",
  "\\# not heading\n\n1\\. not list",
  "x\n\n\n\ny",
  "中文**粗体**中文",
];

describe("source document round trips", () => {
  it("reads and writes back the same Markdown as the saved format (no migration needed)", () => {
    for (const md of SAMPLES) {
      const doc = schema.nodeFromJSON(sourceDoc(md));
      expect(sourceMd(doc.toJSON()), md).toBe(serializeMd(parseMd(md)));
      // and again: stable
      expect(sourceMd(sourceDoc(sourceMd(doc.toJSON()))), md).toBe(sourceMd(doc.toJSON()));
    }
  });
  it("paragraphs and headings hold their source as plain text, blocks stay nodes", () => {
    const d = sourceDoc("## T **b**\n\n- x $y$\n\n```js\nz\n```");
    expect(d.content!.map((n) => n.type)).toEqual(["paragraph", "bulletList", "codeBlock"]);
    expect(d.content![0].content).toEqual([{ type: "text", text: "## T **b**" }]);
  });
  it("a hard break is written as <br>, which renders the same", () => {
    const md = sourceMd(sourceDoc("a  \nb"));
    expect(md).toBe("a<br>b");
    expect(renderMd(md)).toBe(renderMd("a  \nb"));
  });
});

describe("layout: column widths, row heights and code wrap as card data", () => {
  const md = "| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nx\n```\n\n| c |\n| - |\n| 3 |";
  it("round trips through the document by position", () => {
    const layout = { tables: [{ cols: [120, null], rows: [null, 48] }], wrap: [0] };
    const doc = schema.nodeFromJSON(sourceDoc(md, layout));
    expect(layoutOf(doc)).toEqual(layout);
    expect(sourceMd(doc.toJSON())).toBe(serializeMd(parseMd(md))); // not in the Markdown
    expect(layoutOf(schema.nodeFromJSON(sourceDoc(md)))).toBeNull();
    expect(sameLayout(null, undefined)).toBe(true);
  });
  it("the static render applies it, and honours column alignment", () => {
    const el = document.createElement("div");
    el.innerHTML = `<div>${renderMd(md)}</div>`;
    applyMdLayout(el, { tables: [{ cols: [120, 80], rows: [null, 48] }], wrap: [0] });
    const t = el.querySelector("table")!;
    expect([...t.querySelectorAll("colgroup col")].map((c) => (c as HTMLElement).style.width)).toEqual([
      "120px",
      "80px",
    ]);
    expect(t.style.width).toBe("200px");
    expect(t.rows[1].style.height).toBe("48px");
    expect(el.querySelector("pre")!.classList.contains("wrap")).toBe(true);
    applyMdLayout(el, null);
    expect([...t.querySelectorAll("colgroup col")].map((c) => (c as HTMLElement).style.width)).toEqual(["", ""]);
    expect(el.querySelector("pre")!.classList.contains("wrap")).toBe(false);
    expect(renderMd("| a | b | c |\n| :- | :-: | -: |\n| 1 | 2 | 3 |")).toMatch(
      /text-align: ?left[\s\S]*text-align: ?center[\s\S]*text-align: ?right/,
    );
  });
});

describe("source mode caret mapping", () => {
  it("maps a caret into the Markdown and back", () => {
    const doc = schema.nodeFromJSON(sourceDoc("# Title\n\n- item **b**\n\n| a |\n| - |\n| cell |"));
    let pos = -1;
    doc.descendants((n, p) => {
      if (pos < 0 && n.isText && n.text!.includes("cell")) pos = p + 2;
    });
    const { md, at } = mdAt(doc, pos);
    expect(md.slice(at - 2, at + 2)).toBe("cell");
    const back = docAt(doc, md, at);
    expect(back.pos).toBe(pos);
    // a caret between the two * of ** falls back to the word start
    const i = md.indexOf("**b") + 1,
      b2 = docAt(doc, md, i);
    expect(b2.pos).not.toBeNull();
  });
});
