// Typora 式转换（reconvert）：整段插入后按 Markdown 重解析；一次撤销 / 重做
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo, redo, closeHistory } from "@tiptap/pm/history";
import { baseExtensions, parseMd, serializeMd } from "../../src/md/schema";
import { codeSpanAtEnd, reconvert } from "../../src/md/editor/typora";

const schema = getSchema(baseExtensions);
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
