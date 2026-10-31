// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DOMParser as PMParser, type Node as PMNode } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";
import { mdSchema, parseMd, pastedMd, serializeMd } from "../src/schema";
import { marksInSlice } from "../src/editor/pastemarks";
import { htmlSource } from "../src/editor/pastemarks";

// Notes with three ==highlights== in CJK text, one closing right before 。
const SIMT = [
  "同一 warp 中的线程会被分配到同一个处理分区。由于 CUDA 线程调度机制把 warp 映射到处理分区，因此 ==warp 的执行行为通常称为单指令多线程（Single Instruction, Multiple Thread，SIMT）==。",
  "SIMT 的一个重要优点是，之后由 SM 把线程分组为 warp，==透明地使用 SIMD 硬件==。这不同于传统 CPU SIMD 编程：增加了另一层编程复杂度。3",
  "不过，warp 大小可能因实现而异；截至目前，==所有 CUDA 设备都使用了类似的 32 线程 warp 配置==。",
];
const HL = ["warp 的执行行为通常称为单指令多线程（Single Instruction, Multiple Thread，SIMT）", "透明地使用 SIMD 硬件", "所有 CUDA 设备都使用了类似的 32 线程 warp 配置"];

const flat = (ns: JSONContent[] | undefined, out: JSONContent[] = []): JSONContent[] => {
  for (const n of ns ?? []) { out.push(n); flat(n.content, out); }
  return out;
};
const marked = (doc: JSONContent, mark: string) => flat(doc.content).filter((n) => n.marks?.some((m) => m.type === mark)).map((n) => n.text);

describe("pasted text/plain read as Markdown", () => {
  it("reads ==highlights== in CJK text, ~~strike~~ and a --- line, as typing them would", () => {
    const doc = pastedMd(SIMT.join("\n\n"))!;
    expect(doc).not.toBeNull();
    expect(marked(doc, "highlight")).toEqual(HL);
    expect(flat(doc.content).map((n) => n.text ?? "").join("")).not.toContain("==");
    expect(serializeMd(doc)).toBe(SIMT.join("\n\n"));
    expect(marked(pastedMd("删掉 ~~旧的说法~~ 了")!, "strike")).toEqual(["旧的说法"]);
    expect(pastedMd("前面\n\n---\n\n后面")!.content!.map((n) => n.type)).toEqual(["paragraph", "horizontalRule", "paragraph"]);
    expect(marked(pastedMd("x^2^ 和 ==y==")!, "superscript")).toEqual(["2"]);
  });

  it("keeps text the parser reads as nothing more than text, a bare URL, ranges like 3~5 or indentation, as plain text", () => {
    for (const t of ["同一 warp 中的线程。\n\n第二段", "see https://example.com/a ok", "第3~5章和7~9章", "a^b^c 次方", "诗\n\n    缩进的一行\n    又一行", "a == b and c == d"]) {
      expect(pastedMd(t), t).toBeNull();
    }
    expect(pastedMd("```\ncode\n```")!.content![0].type).toBe("codeBlock");
    expect(pastedMd("[link](https://example.com)")).not.toBeNull();
  });
});

/** What the editor makes of pasted HTML: Markdown source (htmlSource), read back the way it will be saved */
function pasteHtml(html: string): PMNode {
  const box = document.createElement("div");
  box.innerHTML = html;
  const md = htmlSource(box), first = parseMd(md).content?.[0]?.type;
  // pasted at the end of a paragraph 开头: a first paragraph joins it, a first block of another kind follows it
  return mdSchema().nodeFromJSON(parseMd(first === "paragraph" ? `开头${md}` : `开头\n\n${md}`));
}
const nodes = (doc: PMNode) => { const out: PMNode[] = []; doc.descendants((n) => { out.push(n); }); return out; };
const withMark = (doc: PMNode, mark: string) => nodes(doc).filter((n) => n.marks.some((m) => m.type.name === mark)).map((n) => n.text ?? n.type.name);

describe("pasted HTML with literal == ~~ ---", () => {
  it("turns ==…== left as text in a browser copy's paragraphs into highlights, but not in code", () => {
    const doc = pasteHtml(`${SIMT.map((p) => `<p>${p}</p>`).join("")}<p>比较 <code>a == b</code> 和 <code>==x==</code></p><pre><code>if a == b:\n  ==c==</code></pre>`);
    expect(withMark(doc, "highlight")).toEqual(HL);
    expect(withMark(doc, "code")).toEqual(["a == b", "==x=="]);
    expect(nodes(doc).find((n) => n.type.name === "codeBlock")!.textContent).toBe("if a == b:\n  ==c==");
    let text = "";
    doc.descendants((n, _p, parent) => { if (n.isText && !n.marks.some((m) => m.type.name === "code") && !parent!.type.spec.code) text += n.text; });
    expect(text).not.toContain("==");
    expect(serializeMd(doc.toJSON())).toContain(`==${HL[2]}==。`);
  });

  it("reads only == and ~~: other punctuation in the HTML's text stays literal", () => {
    const doc = pasteHtml("<p>==a *b* [c](d) $5.== 第 3~5 章 ~~旧的~~。 <strong>==粗==</strong></p>");
    expect(withMark(doc, "highlight")).toEqual(["a *b* [c](d) $5.", "粗"]);
    expect(withMark(doc, "strike")).toEqual(["旧的"]);
    expect(withMark(doc, "bold")).toEqual(["粗"]);
    expect(doc.textContent).toBe("开头a *b* [c](d) $5. 第 3~5 章 旧的。 粗");
    expect(withMark(doc, "subscript")).toEqual([]);
  });

  it("turns a paragraph of --- into a rule, also as the only thing pasted, and keeps a highlight's formula highlighted", () => {
    expect(nodes(pasteHtml("<p>前面</p><p>---</p><p>后面</p>")).map((n) => n.type.name)).toContain("horizontalRule");
    expect(nodes(pasteHtml("<p>---</p>")).map((n) => n.type.name)).toContain("horizontalRule");
    expect(nodes(pasteHtml("<p>a --- b</p>")).map((n) => n.type.name)).not.toContain("horizontalRule");
    const doc = pasteHtml("<p>==和 $x^2$ 一起==</p>");
    expect(withMark(doc, "highlight")).toEqual(["和 ", "inlineMath", " 一起"]);
  });

  it("leaves HTML without literal marks alone", () => {
    const schema = mdSchema();
    const box = document.createElement("div");
    box.innerHTML = "<p>a == b, x ~ y</p><p><mark>已经高亮</mark></p>";
    expect(marksInSlice(PMParser.fromSchema(schema).parseSlice(box), schema)).toBeNull();
  });
});
