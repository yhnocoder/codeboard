// Typora 式转换（reconvert）：整段插入后按 Markdown 重解析；一次撤销 / 重做
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo, redo, closeHistory } from "@tiptap/pm/history";
import { baseExtensions, parseMd, serializeMd } from "../../src/md/schema";
import { Typora, codeSpanAtEnd, reconvert, retype } from "../../src/md/editor/typora";

const schema = getSchema([...baseExtensions, Typora]);
function state(md: string) {
  const doc = schema.nodeFromJSON(parseMd(md));
  let s = EditorState.create({ doc, schema, plugins: [history()] });
  return s.apply(s.tr.setSelection(TextSelection.atEnd(s.doc)));
}
const mdOf = (s: EditorState) => serializeMd(s.doc.toJSON()).trim();
const run = (s: EditorState, cmd: typeof undo) => { let out = s; cmd(s, (tr) => { out = s.apply(tr); }); return out; };
function accept(s: EditorState, text: string) {
  return s.apply(reconvert(closeHistory(s.tr).insertText(text, s.selection.head)));
}

describe("reconvert", () => {
  it("turns inserted spans into marks and math", () => {
    const s = accept(state("see"), " $a$ and **b** with `c`");
    expect(mdOf(s)).toBe("see $a$ and **b** with `c`");
    expect(s.doc.firstChild!.childCount).toBeGreaterThan(3);
    expect(s.storedMarks).toEqual([]);
  });
  it("finishes math the user started", () => {
    const s = accept(state("x $\\frac{"), "a}{b}$ done");
    let math = 0;
    s.doc.descendants((n) => { if (n.type.name === "inlineMath") math++; });
    expect(math).toBe(1);
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
  it("a whole $$…$$ paragraph becomes a math block", () => {
    const s = accept(state(""), "$$y$$");
    expect(s.doc.firstChild!.type.name).not.toBe("paragraph");
  });
});

describe("code span typing rule", () => {
  it("pairs runs of the same length", () => {
    expect(codeSpanAtEnd("a `x`")?.replaceWith).toBe("x");
    expect(codeSpanAtEnd("a ``x ` y``")?.replaceWith).toBe("x ` y");
    expect(codeSpanAtEnd("a `` x ``")?.replaceWith).toBe("x");
  });
  it("waits while a longer run is still open", () => {
    expect(codeSpanAtEnd("a ``x ` y`")).toBeNull();
    expect(codeSpanAtEnd("a `")).toBeNull();
    expect(codeSpanAtEnd("a \\`x`")).toBeNull();
  });
});

describe("typing rule: re-parse what is before the caret (retype)", () => {
  /** 一段打好的字（还没转换过），光标往回挪 back 个字（默认段尾），再打一个字 */
  function type(text: string, ch: string, back = 0) {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]);
    let s = EditorState.create({ doc, schema });
    s = s.apply(s.tr.setSelection(TextSelection.atEnd(s.doc)));
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, s.selection.head - back)));
    const tr = s.tr.insertText(ch);
    const changed = retype(tr);
    return { changed, s: s.apply(tr) };
  }
  it("turns finished syntax into marks, math, links, refs", () => {
    for (const [md, ch, want] of [
      ["x ==hi=", "=", "x ==hi=="], ["H~2", "~", "H~2~"], ["x^2", "^", "x^2^"], ["a $x", "$", "a $x$"], ["a $$y$", "$", "a $$y$$"],
      ["[t](https://x.y/a", ")", "[t](https://x.y/a)"], ["***bi**", "*", "***bi***"], ["<u>u</u", ">", "<u>u</u>"], ["hi :tada", ":", "hi :tada:"], ["see [[C]", "]", "see [[C]]"],
    ] as const) {
      const { changed, s } = type(md, ch);
      expect(changed, md).toBe(true);
      expect(mdOf(s)).toBe(want);
      expect(s.doc.textBetween(s.selection.head, s.doc.content.size)).toBe("");
      expect(s.storedMarks).toEqual([]);
    }
  });
  it("leaves text the parser keeps literal", () => {
    for (const [md, ch] of [["$5 and ", "$"], ["a ~ b ", "~"], ["$$x", "$"], ["x :nosuch", ":"], ["a 1:100", ":"]] as const) expect(type(md, ch).changed, md).toBe(false);
  });
  it("waits while a longer run of the same marker is still being typed", () => {
    for (const [md, ch] of [["**b", "*"], ["~~ab", "~"], ["***bi*", "*"], ["***bi", "*"]] as const) expect(type(md, ch).changed, md).toBe(false);
  });
  it("keeps text after the caret and typed escapes", () => {
    const a = type("x ==a= tail", "=", 5);
    expect(mdOf(a.s)).toBe("x ==a== tail");
    expect(a.s.doc.textBetween(a.s.selection.head, a.s.doc.content.size)).toBe(" tail");
    // 打字时的 \* 是转义：重解析以后还是那一对
    let s = state("a");
    s = s.apply(s.tr.insert(s.selection.head, [schema.text("\\", [schema.marks.mdEsc.create()]), schema.text("*b ==c=")]));
    const tr = s.tr.insertText("=");
    expect(retype(tr)).toBe(true);
    const after = s.apply(tr);
    expect(mdOf(after)).toBe("a\\*b ==c==");
    expect(after.doc.rangeHasMark(0, after.doc.content.size, schema.marks.mdEsc)).toBe(true);
  });
  it("only converts the span ending at the caret (text undone to plain stays plain)", () => {
    const a = type("$a$ and $b", "$");
    expect(a.changed).toBe(true);
    expect(mdOf(a.s)).toBe("\\$a$ and $b$");
    expect(type("==a== x ==b=", "=").s.doc.firstChild!.firstChild!.text).toBe("==a== x ");
  });
  it("leaves bold, italic and strike to TipTap's own rules", () => {
    for (const [md, ch] of [["x **b*", "*"], ["x *i", "*"], ["x ~~s~", "~"], ["x ~a b", "~"]] as const) expect(type(md, ch).changed, md).toBe(false);
  });
  it("does not create footnotes", () => {
    expect(type("see [[x]] and [^1", "]").changed).toBe(false);
  });
});
