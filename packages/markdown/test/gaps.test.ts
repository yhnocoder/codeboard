// @vitest-environment jsdom
// The spacing between paragraphs and the blocks next to them comes from classes the static render and the editor give
// (gaps.ts), in place of sibling rules: both mark the elements those rules matched
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { sourceExtensions } from "../src/schema";
import { createMarkdown } from "../src/markdown";
import { sourceDoc } from "../src/editor/srcdoc";
import { gapsPlugin } from "../src/editor/gaps";

const markdown = createMarkdown();

const MD = "a\n\nb\n\n- l\n\nc\n\n## h\n\nd\n\n> e\n>\n> f\n\n```\ncode\n```\ng";

/** Each top-level block's first characters (or element) with the class it got */
function staticClasses(md: string) {
  const d = document.createElement("div");
  d.innerHTML = markdown.render(md);
  return [...d.children].map((e) => `${e.tagName.toLowerCase()}:${e.className}`);
}
function editorClasses(md: string) {
  const schema = getSchema(sourceExtensions),
    plugin = gapsPlugin();
  const st = EditorState.create({ doc: schema.nodeFromJSON(sourceDoc(md)), plugins: [plugin] });
  const set = plugin.getState(st) as DecorationSet;
  const out: string[] = [];
  st.doc.forEach((n, pos) => {
    const d = set.find(pos, pos + n.nodeSize).find((x) => x.from === pos && x.to === pos + n.nodeSize);
    out.push(
      `${n.type.name}:${(d as unknown as { type: { attrs: { class?: string } } } | undefined)?.type.attrs.class ?? ""}`,
    );
  });
  return out;
}

/** Every decoration of plugin in st, as from-to:class */
function dump(st: EditorState, plugin: ReturnType<typeof gapsPlugin>) {
  return (plugin.getState(st) as DecorationSet)
    .find()
    .map((d) => `${d.from}-${d.to}:${(d as unknown as { type: { attrs: { class: string } } }).type.attrs.class}`)
    .sort();
}

describe("paragraph spacing classes", () => {
  it("static render: a paragraph after a paragraph, a block after a paragraph, a paragraph after a block", () => {
    expect(staticClasses(MD)).toEqual([
      "p:",
      "p:md-pp",
      "ul:md-gap",
      "p:md-gap",
      "h2:",
      "p:",
      "blockquote:md-gap",
      "pre:md-code",
      "p:md-gap",
    ]);
    expect(staticClasses("a\n\n```py\nx\n```")).toEqual(["p:", "pre:md-gap md-code"]);
  });
  it("a paragraph inside a quote is spaced from the one before it", () => {
    const d = document.createElement("div");
    d.innerHTML = markdown.render("> e\n>\n> f");
    expect([...d.querySelectorAll("blockquote > p")].map((p) => p.className)).toEqual(["", "md-pp"]);
  });
  it("something drawn as nothing (an HTML comment) leaves its neighbours next to each other", () => {
    expect(staticClasses("a\n\n<!-- x -->\n\nb")).toEqual(["p:", "p:md-pp"]);
  });
  it("the editor marks the same blocks (headings are paragraphs drawn as h2 there)", () => {
    expect(editorClasses(MD)).toEqual([
      "paragraph:",
      "paragraph:md-pp",
      "bulletList:md-gap",
      "paragraph:md-gap",
      "paragraph:",
      "paragraph:",
      "blockquote:md-gap",
      "codeBlock:",
      "paragraph:md-gap",
    ]);
  });
  it("the editor's classes after edits are those of the edited document drawn afresh", () => {
    const schema = getSchema(sourceExtensions),
      plugin = gapsPlugin();
    let st = EditorState.create({ doc: schema.nodeFromJSON(sourceDoc(MD)), plugins: [plugin] });
    /** The position just inside the n-th top-level block */
    const at = (n: number) => {
      let pos = 0;
      for (let i = 0; i < n; i++) pos += st.doc.child(i).nodeSize;
      return pos + 1;
    };
    /** Where the quote starts */
    const quote = () => {
      let at = -1;
      st.doc.forEach((n, pos) => {
        if (n.type.name === "blockquote") at = pos;
      });
      return at;
    };
    const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
    const edits: ((tr: Transaction) => unknown)[] = [
      (tr) => tr.insertText("x", at(1)), // typing
      (tr) => tr.insertText("## ", at(0)), // a paragraph turns into a heading
      (tr) => tr.delete(at(0), at(0) + 3), // and back
      (tr) => tr.split(at(1) + 1), // Enter in a paragraph
      (tr) => tr.join(at(2) - 1), // Backspace at the start of the next one
      (tr) => tr.delete(at(2) - 1, at(3) - 1), // the list goes
      (tr) => tr.insert(at(1) - 1, [p("y"), p(""), p("## z")]), // paste
      (tr) => tr.insertText("w", quote() + 3), // inside the quote
      (tr) => tr.split(quote() + 3), // Enter inside the quote
      (tr) => tr.delete(quote() + 1, quote() + 4), // its first paragraph goes
      (tr) => tr.delete(quote(), quote() + st.doc.nodeAt(quote())!.nodeSize + 6), // the quote and the code block go
      (tr) => tr.insertText("v", 1).insertText("u", st.doc.content.size - 1), // two places in one step
      (tr) => tr.setSelection(TextSelection.create(tr.doc, 1)), // no change
    ];
    for (const edit of edits) {
      const tr = st.tr;
      edit(tr);
      st = st.apply(tr);
      expect(dump(st, plugin)).toEqual(dump(EditorState.create({ doc: st.doc, plugins: [plugin] }), plugin));
    }
  });
  it("one paragraph still renders inline; two stay blocks", () => {
    expect(markdown.renderInline("a *b*")).toBe("a <em>b</em>");
    expect(markdown.renderInline("a\n\nb")).toBe('<p>a</p><p class="md-pp">b</p>');
  });
});
