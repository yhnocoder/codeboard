import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { sourceExtensions } from "../src/schema";
import { sourceDoc } from "../src/editor/srcdoc";
import { balancedSource } from "../src/editor/clipboard";
import { spanEdgeOut } from "../src/editor/spans";
import { toggleWrap } from "../src/editor/inline";
import { visibleRange } from "../src/editor/visible";

// The editor's paragraphs are Markdown source: copying part of a span, wrapping a selection and mapping a selection made on
// the static render all work on source offsets, with the spans' markers kept balanced
const schema = getSchema(sourceExtensions);
const docOf = (md: string) => schema.nodeFromJSON(sourceDoc(md));

describe("balancedSource: part of a paragraph with the markers of the spans it cuts into", () => {
  const cut = (text: string, sel: string) => {
    const a = text.indexOf(sel);
    return balancedSource(text, a, a + sel.length, true);
  };
  it("inside one span: its markers around the part", () => {
    expect(cut("==Plain words== here", "ain wor")).toBe("==ain wor==");
    expect(cut("a **bold words** b", "old wor")).toBe("**old wor**");
    expect(cut("see [link words](https://e.com/p) now", "ink wor")).toBe("[ink wor](https://e.com/p)");
  });
  it("starting inside a span and running out of it: only its closing side is added", () => {
    expect(cut("==Plain words== here", "words== he")).toBe("==words== he");
    expect(cut("x **bold** tail", "ld** ta")).toBe("**ld** ta");
  });
  it("nested spans: outer markers outside, inner inside", () => {
    expect(cut("==a **bold** b== c", "old** b")).toBe("==**old** b==");
  });
  it("a cut through a drawn formula takes all of it", () => {
    const t = "==aa $x^2$ bb== end";
    expect(balancedSource(t, t.indexOf("a $x"), t.indexOf("^2"), true)).toBe("==a $x^2$==");
  });
  it("the whole span selected: unchanged", () => {
    expect(cut("a **bold** b", "**bold**")).toBe("**bold**");
  });
});

describe("toggleWrap: markers around the selection", () => {
  const run = (md: string, sel: string, open: string) => {
    let state = EditorState.create({ doc: docOf(md) });
    const at = md.indexOf(sel) + 1;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at, at + sel.length)));
    let out = state;
    toggleWrap(
      state,
      (tr: Transaction) => {
        out = state.apply(tr);
      },
      open,
    );
    const s = out.selection;
    return { text: out.doc.textContent, sel: out.doc.textBetween(s.from, s.to) };
  };
  it("plain words", () => {
    expect(run("a note here", "note", "==")).toEqual({ text: "a ==note== here", sel: "note" });
  });
  it("a selection ending inside bold takes the whole bold, so the markers never interleave", () => {
    expect(run("Plain words in a note with **bold** inside", "note with **bold", "==").text).toBe(
      "Plain words in a ==note with **bold**== inside",
    );
    expect(run("a **bold** and more", "old** and", "==").text).toBe("a ==**bold** and== more");
  });
  it("inside a span: just the part", () => {
    expect(run("a **bold words** b", "words", "==").text).toBe("a **bold ==words==** b");
  });
  it("already wrapped: unwraps", () => {
    expect(run("a ==note== here", "note", "==")).toEqual({ text: "a note here", sel: "note" });
  });
});

describe("visibleRange: a range counted on the static render, in the editor's source", () => {
  const pick = (md: string, shown: string, word: string) => {
    const doc = docOf(md),
      from = shown.indexOf(word);
    const r = visibleRange(doc, { from, to: from + word.length, text: word });
    return r && doc.textBetween(r.from, r.to);
  };
  it("markers and heading prefixes don't count", () => {
    expect(pick("# Title\n\nsome **bold** text", "Titlesome bold text", "bold")).toBe("bold");
    expect(pick("# Title\n\nsome **bold** text", "Titlesome bold text", "Title")).toBe("Title");
  });
  it("a drawn formula is one character", () => {
    expect(pick("a $x^2$ b and c", "a ￼ b and c", "and")).toBe("and");
    expect(pick("a $x^2$ b", "a ￼ b", "￼")).toBe("$x^2$");
  });
  it("text that differs gives null", () => {
    const doc = docOf("some text");
    expect(visibleRange(doc, { from: 0, to: 4, text: "nope" })).toBeNull();
  });
});

describe("spanEdgeOut: an offset at the edge of a span's text goes outside its markers", () => {
  const out = (text: string, at: string, after = true) => {
    const i = text.indexOf(at) + (after ? at.length : 0);
    return text.slice(0, spanEdgeOut(text, i, true));
  };
  it("before the closing markers: after them", () => {
    expect(out("**Prefill, then decode.**", "decode.")).toBe("**Prefill, then decode.**");
    expect(out("x ***bi*** y", "bi")).toBe("x ***bi***");
  });
  it("after the opening markers: before them", () => {
    expect(out("a **bold** b", "**")).toBe("a ");
  });
  it("inside the text or outside any span: unchanged", () => {
    expect(out("a **bold** b", "**bo")).toBe("a **bo");
    expect(out("plain text", "plain")).toBe("plain");
  });
});
