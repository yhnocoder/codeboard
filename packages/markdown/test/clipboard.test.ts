import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { baseExtensions, parseMd } from "../src/schema";
import { clipboardText } from "../src/editor/clipboard";
import type { Node as PMNode } from "@tiptap/pm/model";

const schema = getSchema(baseExtensions);
/** md 文档里的 sel 这几个字（只出现一次，可以跨过公式：公式算一个位置，写成 \u0000）的那一片 */
function copy(md: string, sel: string) {
  const doc = schema.nodeFromJSON(parseMd(md));
  // 文档里每个位置上的字：字就是字，公式、表情这样的行内节点是一个 \u0000
  let flat = "";
  const pos: number[] = [];
  doc.descendants((n, p) => {
    if (n.isText) for (let i = 0; i < n.text!.length; i++) { flat += n.text![i]; pos.push(p + i); }
    else if (n.isInline) { flat += "\u0000"; pos.push(p); }
  });
  const i = flat.indexOf(sel);
  expect(i, `"${sel}" in ${md}`).toBeGreaterThanOrEqual(0);
  expect(flat.indexOf(sel, i + 1), `"${sel}" once in ${md}`).toBe(-1);
  const from = pos[i], to = pos[i + sel.length - 1] + 1;
  // what ProseMirror puts on the clipboard: the selection's content, with its parents (selection.content())
  return clipboardText(doc.slice(from, to, true));
}
/** 粘回来（文字按 Markdown 解析）后，sel 的那些字身上的格式 */
const marksIn = (md: string) => {
  const out = new Set<string>();
  const doc: PMNode = schema.nodeFromJSON(parseMd(md));
  doc.descendants((n) => { for (const m of n.marks) out.add(m.type.name); });
  return [...out].sort();
};

describe("copying part of a formatted span", () => {
  const cases: [string, string, string, string[]][] = [
    ["==Plain words== here", "ain wor", "==ain wor==", ["highlight"]],
    ["**Plain words** here", "ain wor", "**ain wor**", ["bold"]],
    ["*Plain words* here", "ain wor", "*ain wor*", ["italic"]],
    ["~~Plain words~~ here", "ain wor", "~~ain wor~~", ["strike"]],
    ["`Plain words` here", "ain wor", "`ain wor`", ["code"]],
    ["[Plain words](https://e.com/p) here", "ain wor", "[ain wor](https://e.com/p)", ["link"]],
    // starts in the middle of a highlight and takes the formula inside it
    // a leading space goes outside the opening marker (== x== would not be a highlight)
    ["==a $x$ b== c", " \u0000 b", " ==$x$ b==", ["highlight"]],
    ["==aa $x$ bb== c", "a \u0000 b", "==a $x$ b==", ["highlight"]],
    // runs out of the span into plain text, and across nested marks
    ["==Plain words== here", "words he", "==words== he", ["highlight"]],
    ["==a **bold** b== c", "a bold b", "==a **bold** b==", ["bold", "highlight"]],
    ["==a **bold** b== c", "old b", "==**old** b==", ["bold", "highlight"]],
  ];
  for (const [md, sel, want, marks] of cases) {
    it(`${md} → "${sel.replace("\u0000", "$x$")}"`, () => {
      const text = copy(md, sel);
      expect(text).toBe(want);
      expect(marksIn(text)).toEqual(marks);
    });
  }
});
