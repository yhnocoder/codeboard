// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mdSchema, parseMd } from "../src/schema";
import { renderMd } from "../src/render";
import { staticTextRange, docRange } from "../src/selmap";

function setup(md: string) {
  const root = document.createElement("div");
  root.innerHTML = renderMd(md);
  document.body.append(root);
  return { root, doc: mdSchema().nodeFromJSON(parseMd(md)) };
}
/** 选中 root 里第 i 个文字节点里出现的 word */
function select(root: HTMLElement, word: string, i = 0) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) if ((n as Text).data.includes(word)) hits.push(n as Text);
  const t = hits[i], at = t.data.indexOf(word);
  const r = document.createRange();
  r.setStart(t, at); r.setEnd(t, at + word.length);
  return r;
}
const mapped = (md: string, word: string, i = 0) => {
  const { root, doc } = setup(md);
  const s = staticTextRange(root, select(root, word, i));
  const d = s && docRange(doc, s);
  return d && doc.textBetween(d.from, d.to, "", "￼");
};

describe("static selection → document range", () => {
  it("a word in a paragraph", () => expect(mapped("hello brave world", "brave")).toBe("brave"));
  it("a word after a heading, bold text and inline math", () => {
    expect(mapped("# Title\n\nsome **bold** and $x^2$ then target here", "target")).toBe("target");
  });
  it("a word after an annotation: its label is not part of the text", () => {
    expect(mapped("a {wave count|$a$#num_total} is the target", "target")).toBe("target");
    expect(mapped("a {wave count|note words} is the target", "count")).toBe("count");
  });
  it("a word in the second list item and in a code block", () => {
    expect(mapped("- one\n- two words\n\n```\nlet code = 1\n```", "words")).toBe("words");
    expect(mapped("- one\n\n```\nlet code = 1\n```", "code")).toBe("code");
  });
  it("a range across two paragraphs", () => {
    const { root, doc } = setup("first para\n\nsecond para");
    const a = select(root, "para", 0), b = select(root, "second", 0);
    const r = document.createRange();
    r.setStart(a.startContainer, a.startOffset); r.setEnd(b.endContainer, b.endOffset);
    const s = staticTextRange(root, r)!;
    const d = docRange(doc, s)!;
    expect(doc.textBetween(d.from, d.to, "\n")).toBe("para\nsecond");
  });
  it("a selection outside the root gives null", () => {
    const { root } = setup("text");
    const other = document.createElement("p");
    other.textContent = "elsewhere";
    document.body.append(other);
    const r = document.createRange();
    r.selectNodeContents(other);
    expect(staticTextRange(root, r)).toBeNull();
  });
  it("text that differs between the render and the document gives null", () => {
    const { doc } = setup("abc");
    expect(docRange(doc, { from: 0, to: 2, text: "xy" })).toBeNull();
  });
});
