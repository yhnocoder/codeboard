import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { baseExtensions, parseMd, sourceExtensions } from "../src/schema";
import { balancedSource, clipboardText } from "../src/editor/clipboard";
import { sourceDoc } from "../src/editor/srcdoc";
import type { Node as PMNode } from "@tiptap/pm/model";

// The editor's paragraphs are their Markdown source, so a copy is the source characters selected: the markers come along
// exactly when they are selected (they show around the caret), and what is pasted back reads as what was seen.
const schema = getSchema(sourceExtensions),
  base = getSchema(baseExtensions);
/** The slice of the source text `sel` (found once in the document's text) */
function copy(md: string, sel: string) {
  const doc = schema.nodeFromJSON(sourceDoc(md));
  let flat = "";
  const pos: number[] = [];
  doc.descendants((n, p) => {
    if (n.isText)
      for (let i = 0; i < n.text!.length; i++) {
        flat += n.text![i];
        pos.push(p + i);
      }
  });
  const i = flat.indexOf(sel);
  expect(i, `"${sel}" in ${md}`).toBeGreaterThanOrEqual(0);
  expect(flat.indexOf(sel, i + 1), `"${sel}" once in ${md}`).toBe(-1);
  const from = pos[i],
    to = pos[i + sel.length - 1] + 1;
  // what ProseMirror puts on the clipboard: the selection's content, with its parents (selection.content())
  return clipboardText(doc.slice(from, to, true));
}
/** The formatting the pasted text reads as */
const marksIn = (md: string) => {
  const out = new Set<string>();
  const doc: PMNode = base.nodeFromJSON(parseMd(md));
  doc.descendants((n) => {
    for (const m of n.marks) out.add(m.type.name);
  });
  return [...out].sort();
};

describe("copying part of a formatted span", () => {
  const cases: [string, string, string, string[]][] = [
    ["==Plain words== here", "==Plain words==", "==Plain words==", ["highlight"]],
    ["**Plain words** here", "**Plain words**", "**Plain words**", ["bold"]],
    ["*Plain words* here", "*Plain words*", "*Plain words*", ["italic"]],
    ["~~Plain words~~ here", "~~Plain words~~", "~~Plain words~~", ["strike"]],
    ["`Plain words` here", "`Plain words`", "`Plain words`", ["code"]],
    [
      "[Plain words](https://e.com/p) here",
      "[Plain words](https://e.com/p)",
      "[Plain words](https://e.com/p)",
      ["link"],
    ],
    // inside a span: just the characters (the markers are not selected)
    ["==a $x$ b== c", " $x$ b", " $x$ b", []],
    ["==aa $x$ bb== c", "a $x$ b", "a $x$ b", []],
    // runs out of the span into plain text, and across nested marks
    ["==Plain words== here", "words== he", "words== he", []],
    ["==a **bold** b== c", "==a **bold** b==", "==a **bold** b==", ["bold", "highlight"]],
    ["==a **bold** b== c", "**bold** b", "**bold** b", ["bold"]],
  ];
  for (const [md, sel, want, marks] of cases) {
    it(`${md} → "${sel}"`, () => {
      const text = copy(md, sel);
      expect(text).toBe(want);
      expect(marksIn(text)).toEqual(marks);
    });
  }
  it("across blocks: the blocks' Markdown", () => {
    expect(copy("# Title\n\npara **b** end", "tlepara **b**")).toBe("tle\n\npara **b**");
  });
});

describe("copying from a source that shows", () => {
  const img = 'A ![](a.svg "Fig 5.1: memory types"){width=83%} b';
  const cut = (t: string, sel: string, shown: number | null) => {
    const i = t.indexOf(sel);
    return balancedSource(t, i, i + sel.length, true, shown);
  };
  it("an image whose source line is open: just the characters", () => {
    expect(cut(img, "memory types", img.indexOf("types"))).toBe("memory types");
    expect(cut(img, "A ![](a.s", img.indexOf("a.s"))).toBe("A ![](a.s");
  });
  it("a drawn image (its source hidden): the whole of it", () => {
    expect(cut(img, "A ![](a.s", null)).toBe('A ![](a.svg "Fig 5.1: memory types"){width=83%}');
  });
  it("an inline formula whose TeX shows: just the characters", () => {
    const t = "f $a+b+c$ g";
    expect(cut(t, "b+c", t.indexOf("b+c"))).toBe("b+c");
    expect(cut(t, "b+c", null)).toBe("$a+b+c$");
  });
  it("part of a link's address: just the characters; part of its text: the link", () => {
    const t = "see [the link](https://e.com/page) ok";
    expect(cut(t, "e.com/pa", t.indexOf("e.com"))).toBe("e.com/pa");
    expect(cut(t, "he li", t.indexOf("he li"))).toBe("[he li](https://e.com/page)");
  });
});
