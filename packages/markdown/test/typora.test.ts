import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo, redo, closeHistory } from "@tiptap/pm/history";
import { parseMd, sourceExtensions } from "../src/schema";
import { enterBlock } from "../src/editor/typora";
import { sourceDoc, sourceMd } from "../src/editor/srcdoc";
import { blockInfo, flat, type Span } from "../src/editor/spans";

// Paragraphs hold their Markdown source: typing never rewrites them, and what the parser reads in the text is drawn.
// These are the old typing-rule cases, checked against the source model: the stored text is exactly what was typed,
// and the spans (what inline.ts draws) show the formatting the old rules produced.
const schema = getSchema(sourceExtensions);
function state(md: string) {
  const doc = schema.nodeFromJSON(sourceDoc(md));
  const s = EditorState.create({ doc, schema, plugins: [history()] });
  return s.apply(s.tr.setSelection(TextSelection.atEnd(s.doc)));
}
const mdOf = (s: EditorState) => sourceMd(s.doc.toJSON());
const run = (s: EditorState, cmd: typeof undo) => { let out = s; cmd(s, (tr) => { out = s.apply(tr); }); return out; };
/** What a paragraph's source draws: tag names and atom types, in order */
const drawn = (text: string, headings = true) => flat(blockInfo(text, headings).spans).map((sp: Span) => sp.atom?.type ?? sp.tag?.nodeName ?? "esc");
const innerOf = (text: string, sp: Span) => (sp.inner ? text.slice(sp.inner[0], sp.inner[1]) : "");
const TAG: Record<string, string> = { bold: "strong", italic: "em", strike: "s", code: "code", highlight: "mark", subscript: "sub", superscript: "sup", underline: "u", link: "a" };
/** The formatting the static render shows for a paragraph's source (the editor draws the same) */
function shown(text: string): string[] {
  const out = new Set<string>();
  const walk = (ns: { marks?: { type: string }[]; content?: unknown[] }[] | undefined) => { for (const n of ns ?? []) { for (const m of n.marks ?? []) out.add(TAG[m.type] ?? m.type); walk(n.content as typeof ns); } };
  walk(parseMd(text).content as Parameters<typeof walk>[0]);
  return [...out].sort();
}
const tags = (text: string) => [...new Set(flat(blockInfo(text).spans).flatMap((sp) => (sp.tag ? [sp.tag.nodeName] : [])))].sort();
function accept(s: EditorState, text: string) {
  return s.apply(closeHistory(s.tr).insertText(text, s.selection.head));
}

describe("accepting inserted text (ghost text, paste of one line)", () => {
  it("keeps inserted spans as source and draws them as math, bold and code", () => {
    const s = accept(state("see"), " $a$ and **b** with `c`");
    expect(mdOf(s)).toBe("see $a$ and **b** with `c`");
    expect(drawn(s.doc.firstChild!.textContent)).toEqual(["math", "strong", "code"]);
  });
  it("finishes math the user started", () => {
    const s = accept(state("x $\\frac{"), "a}{b}$ done");
    expect(drawn(s.doc.firstChild!.textContent)).toEqual(["math"]);
    expect(mdOf(s)).toBe("x $\\frac{a}{b}$ done");
  });
  it("one undo reverts the accept, redo brings it back", () => {
    const s0 = state("x $\\frac{");
    const s1 = accept(s0, "a}{b}$ done");
    const u = run(s1, undo);
    expect(mdOf(u)).toBe(mdOf(s0));
    const r = run(u, redo);
    expect(mdOf(r)).toBe("x $\\frac{a}{b}$ done");
  });
  it("keeps the caret where it logically was", () => {
    const s = accept(state("a"), " **b** c");
    expect(s.doc.textBetween(s.selection.head, s.doc.content.size)).toBe("");
  });
  it("a whole $$…$$ paragraph becomes a math block on Enter", () => {
    let s = accept(state(""), "$$y$$");
    expect(enterBlock(s, (tr) => { s = s.apply(tr); })).toBe(true);
    expect(s.doc.firstChild!.type.name).toBe("blockMath");
  });
});

describe("code spans", () => {
  it("pair runs of the same length", () => {
    for (const [t, want] of [["a `x`", "x"], ["a ``x ` y``", "x ` y"], ["a `` x ``", "x"]] as const) {
      const sp = flat(blockInfo(t).spans).find((x) => x.tag?.nodeName === "code")!;
      expect(innerOf(t, sp).trim(), t).toBe(want);
    }
  });
  it("wait while a longer run is still open", () => {
    // the parser's own pairing: no span opens at the `` run (the single-backtick ` y` is a span of its own, as rendered)
    const t = "a ``x ` y`";
    expect(flat(blockInfo(t).spans).every((sp) => t.slice(sp.from, sp.from + 2) !== "``")).toBe(true);
    expect(tags(t)).toEqual(shown(t));
    expect(drawn("a `")).toEqual([]);
  });
});

describe("typing: the source is what was typed, the parser decides what it draws", () => {
  /** A typed paragraph, the caret back `back` characters from its end, then one more character */
  function type(text: string, ch: string, back = 0) {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]);
    let s = EditorState.create({ doc, schema });
    s = s.apply(s.tr.setSelection(TextSelection.atEnd(s.doc)));
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, s.selection.head - back)));
    s = s.apply(s.tr.insertText(ch));
    return { s, text: s.doc.firstChild!.textContent };
  }
  it("draws finished syntax as formatting, math, links, refs", () => {
    for (const [md, ch, want, kind] of [
      ["x ==hi=", "=", "x ==hi==", "mark"], ["H~2", "~", "H~2~", "sub"], ["x^2", "^", "x^2^", "sup"], ["a $x", "$", "a $x$", "math"], ["a $$y$", "$", "a $$y$$", "math"],
      ["[t](https://x.y/a", ")", "[t](https://x.y/a)", "a"], ["***bi**", "*", "***bi***", "em"], ["<u>u</u", ">", "<u>u</u>", "u"], ["hi :tada", ":", "hi :tada:", "emoji"], ["see [[C]", "]", "see [[C]]", "ref"],
    ] as const) {
      const { s, text } = type(md, ch);
      expect(text, md).toBe(want);
      expect(drawn(text), md).toContain(kind);
      expect(s.doc.textBetween(s.selection.head, s.doc.content.size)).toBe("");
    }
  });
  it("leaves text the parser keeps literal", () => {
    for (const [md, ch] of [["$5 and ", "$"], ["a ~ b ", "~"], ["$$x", "$"], ["x :nosuch", ":"], ["a 1:100", ":"]] as const) expect(drawn(type(md, ch).text), md).toEqual([]);
  });
  it("draws no bold while a longer run of the same marker is still being typed, and only what the static render shows", () => {
    expect(drawn(type("**b", "*").text)).not.toContain("strong");
    for (const [md, ch] of [["**b", "*"], ["~~ab", "~"], ["***bi*", "*"], ["***bi", "*"]] as const) {
      const { text } = type(md, ch);
      expect(tags(text), md).toEqual(shown(text));
    }
  });
  it("keeps text after the caret and typed escapes", () => {
    const a = type("x ==a= tail", "=", 5);
    expect(mdOf(a.s)).toBe("x ==a== tail");
    expect(a.s.doc.textBetween(a.s.selection.head, a.s.doc.content.size)).toBe(" tail");
    // a typed \* is an escape: it stays, and the * is not a marker
    const b = type("a\\*b ==c=", "=");
    expect(mdOf(b.s)).toBe("a\\*b ==c==");
    expect(drawn(b.text)).toEqual(["esc", "mark"]);
  });
  it("only what is written is drawn (an earlier span stays as typed)", () => {
    expect(drawn(type("$a$ and $b", "$").text)).toEqual(["math", "math"]);
    expect(drawn(type("\\$a$ and $b", "$").text)).toEqual(["esc", "math"]);
  });
  it("typing the closing = of ==hi== highlights it and saves it back as ==hi==", () => {
    const { s, text } = type("say ==hi=", "=");
    const sp = flat(blockInfo(text).spans).find((x) => x.tag?.nodeName === "mark")!;
    expect(innerOf(text, sp)).toBe("hi");
    expect(mdOf(s)).toBe("say ==hi==");
    // a lone == (x == y) and a space inside the markers stay text
    expect(drawn(type("x == y =", "=").text)).toEqual([]);
    expect(drawn(type("x == y=", "=").text)).toEqual([]);
  });
  it("draws a strike only as the static render does, and keeps a single ~ with spaces as text", () => {
    for (const [md, ch] of [["x ~~s", "~"], ["x ~a b", "~"]] as const) expect(tags(type(md, ch).text), md).toEqual(shown(type(md, ch).text));
  });
  // the parser's own rules: right after CJK text, and with ** inside an earlier code span
  it("draws **b**, *i*, ~~s~~, ==h== and `c` after CJK text, also with ** inside an earlier code span", () => {
    for (const pre of ["指向要 free 的对象的 ", "指向要 free 的对象的"]) {
      for (const [typed, ch, want, tag] of [["**Pointer*", "*", "**Pointer**", "strong"], ["*Pointer", "*", "*Pointer*", "em"], ["~~Pointer~", "~", "~~Pointer~~", "s"], ["==Pointer=", "=", "==Pointer==", "mark"]] as const) {
        for (const withCode of [false, true]) {
          const head = `${withCode ? "(`void **`) " : ""}${pre}`;
          const doc = schema.node("doc", null, [schema.node("bulletList", null, [schema.node("listItem", null, [schema.node("paragraph", null, [schema.text(head + typed)])])])]);
          let s = EditorState.create({ doc, schema });
          s = s.apply(s.tr.setSelection(TextSelection.atEnd(s.doc)));
          s = s.apply(s.tr.insertText(ch));
          const text = s.selection.$head.parent.textContent, sp = flat(blockInfo(text).spans).filter((x) => x.tag?.nodeName === tag).pop();
          expect(sp && innerOf(text, sp), `${withCode} ${pre}${typed}${ch}`).toBe("Pointer");
          expect(mdOf(s)).toBe(`- ${head}${want}`);
        }
      }
    }
  });
  it("writes footnote references as typed", () => {
    expect(type("see [[x]] and [^1", "]").text).toBe("see [[x]] and [^1]");
  });
  it("a whole-line $$…$$ plus Enter becomes a math block, the caret in the paragraph after it", () => {
    let s = type("$$\\frac{200}{10}$", "$").s;
    expect(enterBlock(s, (tr) => { s = s.apply(tr); })).toBe(true);
    expect(s.doc.firstChild!.type.name).toBe("blockMath");
    expect(s.doc.firstChild!.attrs.latex).toBe("\\frac{200}{10}");
    expect(s.selection.$head.parent.type.name).toBe("paragraph");
    expect(s.selection.$head.index(0)).toBe(1);
    expect(mdOf(s)).toBe("$$\n\\frac{200}{10}\n$$");
  });
  it("$$…$$ in a table cell stays inline, as the cell's Markdown is", () => {
    let s = state("| a |\n| - |\n| x |");
    let cell = -1;
    s.doc.descendants((n, pos) => { if (cell < 0 && n.type.name === "tableCell") cell = pos; });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, cell + 2)).deleteRange(cell + 2, cell + 3).insertText("$$y$$", cell + 2));
    expect(enterBlock(s)).toBe(false);
    expect(drawn(s.selection.$head.parent.textContent, false)).toEqual(["math"]);
    expect(mdOf(s)).toBe("| a     |\n| ----- |\n| $$y$$ |");
  });
});
