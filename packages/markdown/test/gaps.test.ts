// @vitest-environment jsdom
// The spacing between paragraphs and the blocks next to them comes from classes the static render and the editor give
// (gaps.ts), in place of sibling rules: both mark the elements those rules matched
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { sourceExtensions } from "../src/schema";
import { renderMd, renderMdInline } from "../src/render";
import { sourceDoc } from "../src/editor/srcdoc";
import { gapsPlugin } from "../src/editor/gaps";

const MD = "a\n\nb\n\n- l\n\nc\n\n## h\n\nd\n\n> e\n>\n> f\n\n```\ncode\n```\ng";

/** Each top-level block's first characters (or element) with the class it got */
function staticClasses(md: string) {
  const d = document.createElement("div");
  d.innerHTML = renderMd(md);
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
    d.innerHTML = renderMd("> e\n>\n> f");
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
  it("one paragraph still renders inline; two stay blocks", () => {
    expect(renderMdInline("a *b*")).toBe("a <em>b</em>");
    expect(renderMdInline("a\n\nb")).toBe('<p>a</p><p class="md-pp">b</p>');
  });
});
