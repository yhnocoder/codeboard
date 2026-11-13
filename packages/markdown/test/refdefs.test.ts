// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { mdBlockStarts, parseMd, serializeMd, sourceExtensions } from "../src/schema";
import { createMarkdown } from "../src/markdown";
import { sourceDoc, sourceMd } from "../src/editor/srcdoc";
import { inlinePlugin } from "../src/editor/inline";
import { inlineKey } from "../src/editor/inlinekey";

// Link reference definitions ([label]: url) and footnote definitions nothing refers to are kept as they are written, through
// the editor and through every rewrite that reads and writes a Note (serializeMd)
const schema = getSchema(sourceExtensions);
const throughEditor = (md: string) => sourceMd(schema.nodeFromJSON(sourceDoc(md)).toJSON());
const rewritten = (md: string) => serializeMd(parseMd(md));
const both = (md: string) => [throughEditor(md), rewritten(md)];

describe("definitions survive a round trip as written", () => {
  it("a footnote definition nothing refers to", () => {
    const md = "Before.\n\n[^1]: 词\n\nAfter.";
    expect(both(md)).toEqual([md, md]);
  });
  it("a link definition", () => {
    const md = "Before.\n\n[link]: https://example.com\n\nAfter.";
    expect(both(md)).toEqual([md, md]);
  });
  it("an indented block after a footnote definition is part of it, and kept with it", () => {
    const md = "Before.\n\n[^1]: 词\n\n    indented code\n\nAfter.";
    expect(both(md)).toEqual([md, md]);
  });
  it("titles, angle brackets, a run of definitions, one at the very end", () => {
    for (const md of [
      "a\n\n[a]: <https://a.example/x y> \"Title\"\n[B]: https://b.example\n  'two lines'\n[^n]: unused\n\nb",
      "text\n\n[x]: /path",
      "> quoted\n>\n> [q]: https://q.example",
      "[first]: https://one\n[first]: https://two",
    ])
      expect(both(md), md).toEqual([md, md]);
  });
  it("a footnote that is referred to is still numbered and moved to the end, around numbers already written", () => {
    const md = "a[^x] b\n\n[^x]: real\n\n[^1]: unused";
    expect(both(md)).toEqual(Array(2).fill("a[^2] b\n\n[^1]: unused\n\n[^2]: real"));
    // and stays so
    expect(both("a[^2] b\n\n[^1]: unused\n\n[^2]: real")).toEqual(
      Array(2).fill("a[^2] b\n\n[^1]: unused\n\n[^2]: real"),
    );
  });
  it("a second definition of a footnote that is referred to is kept as written", () => {
    expect(both("a[^1]\n\n[^1]: one\n\n[^1]: again")).toEqual(Array(2).fill("a[^2]\n\n[^1]: again\n\n[^2]: one"));
  });
});

describe("reference links", () => {
  const md =
    "See [full][link], [collapsed][] and [shortcut].\n\n[link]: https://a.example\n[collapsed]: https://b.example\n[shortcut]: https://c.example 'T'";
  it("stay written as references", () => {
    expect(both(md)).toEqual([md, md]);
  });
  it("still link in the static render, and the definitions show nothing", () => {
    const d = document.createElement("div");
    d.innerHTML = createMarkdown().render(md);
    expect([...d.querySelectorAll("a")].map((a) => [a.textContent, a.dataset.href])).toEqual([
      ["full", "https://a.example"],
      ["collapsed", "https://b.example"],
      ["shortcut", "https://c.example"],
    ]);
    expect(d.textContent).not.toContain("example");
    // the paragraph after the definitions is spaced from the one before them, as if they were not there
    d.innerHTML = createMarkdown().render("a\n\n[x]: https://x\n\nb");
    expect([...d.children].map((e) => [e.tagName, e.className, e.hasAttribute("hidden")])).toEqual([
      ["P", "", false],
      ["DIV", "", true],
      ["P", "md-pp", false],
    ]);
  });
  it("are drawn as links in the editor with the document's definitions, and follow their definitions as they change", () => {
    const linked = (st: EditorState) =>
      inlineKey
        .getState(st)!
        .decos.find()
        .filter((d) => (d as unknown as { type: { attrs: { href?: string } } }).type.attrs.href)
        .map((d) => [
          st.doc.textBetween(d.from, d.to),
          (d as unknown as { type: { attrs: { href: string } } }).type.attrs.href,
        ])
        // (an address written out, as in the definition itself, is drawn as a link anyway)
        .filter(([text]) => !text.startsWith("https://"));
    let st = EditorState.create({
      doc: schema.nodeFromJSON(sourceDoc("See [full][link].\n\n[link]: https://a.example")),
      plugins: [inlinePlugin()],
    });
    expect(linked(st)).toEqual([["full", "https://a.example"]]);
    const def = (s: EditorState) => s.doc.content.size - 1 - "a.example".length;
    st = st.apply(st.tr.insertText("typed", def(st), def(st) + 1));
    expect(linked(st)).toEqual([["full", "https://typed.example"]]);
    // the definition gone: plain text again
    st = st.apply(st.tr.delete(st.doc.child(0).nodeSize, st.doc.content.size));
    expect(linked(st)).toEqual([]);
  });
});

describe("block starts with definitions", () => {
  it("a run of definitions is one block, as the editor and the static render show it", () => {
    const src = "a\n\n[x]: https://x\n[y]: https://y\n\nb";
    expect(mdBlockStarts(src)?.map((s, i, all) => src.slice(s, all[i + 1] ?? src.length).trimEnd())).toEqual([
      "a",
      "[x]: https://x\n[y]: https://y",
      "b",
    ]);
    expect(parseMd(src).content!.length).toBe(3);
  });
});
