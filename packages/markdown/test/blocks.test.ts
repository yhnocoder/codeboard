// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { ResolvedPos } from "@tiptap/pm/model";
import katex from "katex";
import { parseMd, serializeMd, baseExtensions, mdSchema } from "../src/schema";
import { renderMd } from "../src/render";

describe("$$…$$ in the middle of a line", () => {
  it("renders inline, typeset with \\displaystyle; a $$ block on its own lines stays a display block", () => {
    const h = renderMd("3 $$\\sum_i x_i$$ end");
    expect(h).not.toContain("katex-display");
    expect(h).toContain(katex.renderToString("\\displaystyle \\sum_i x_i", { displayMode: false, throwOnError: false, output: "html" }));
    expect(renderMd("$$\n\\sum_i x_i\n$$")).toContain("katex-display");
    expect(serializeMd(parseMd("3 $$\\sum_i x_i$$ end"))).toBe("3 $$\\sum_i x_i$$ end");
  });
});

describe("gap cursor around code blocks", () => {
  const valid = ($p: ResolvedPos) => (GapCursor as unknown as { valid($p: ResolvedPos): boolean }).valid($p);
  const doc = mdSchema().nodeFromJSON(parseMd("```c\na\n```\n\n```c\nb\n```\n\ntext\n\n```c\nc\n```"));
  const at = (i: number) => { let p = 0; for (let k = 0; k < i; k++) p += doc.child(k).nodeSize; return doc.resolve(p); };
  it("stops between two code blocks and before a code block that starts the document", () => {
    expect(valid(at(1))).toBe(true);
    expect(valid(at(0))).toBe(true);
  });
  it("does not stop next to a paragraph (the cursor goes into its text)", () => {
    expect(valid(at(2))).toBe(false);
    expect(valid(at(3))).toBe(false);
  });
});

const schema = getSchema(baseExtensions);
const para = (t?: string): JSONContent => (t ? { type: "paragraph", content: [{ type: "text", text: t }] } : { type: "paragraph" });
const item = (kind: string, t?: string): JSONContent => ({ type: kind === "taskList" ? "taskItem" : "listItem", ...(kind === "taskList" ? { attrs: { checked: false } } : {}), content: [para(t)] });
const list = (kind: string, ...texts: (string | undefined)[]): JSONContent => ({ type: "doc", content: [{ type: kind, content: texts.map((t) => item(kind, t)) }] });
/** 文档里每个列表项的字（空项是 ""），列表外的块记成 "<类型>" */
const items = (d: JSONContent): string[] => (d.content ?? []).flatMap((b) =>
  /List$/.test(b.type!) ? (b.content ?? []).map((li) => (li.content?.[0]?.content ?? []).map((x) => x.text ?? "").join("")) : [`<${b.type}>`]);

describe("empty list items", () => {
  for (const kind of ["orderedList", "bulletList", "taskList"]) {
    for (const texts of [["a", undefined], [undefined, "b"], ["a", undefined, "c"], [undefined]]) {
      it(`${kind} ${JSON.stringify(texts.map((t) => t ?? ""))} survives save and reload`, () => {
        const md = serializeMd(list(kind, ...texts));
        const back = parseMd(md);
        expect(back.content!.map((b) => b.type)).toEqual([kind]);
        expect(items(back)).toEqual(texts.map((t) => t ?? ""));
        // 读回来的文档合 schema（空项里有一个空段落），再写一次一字不变
        expect(() => schema.nodeFromJSON(back).check()).not.toThrow();
        expect(serializeMd(back)).toBe(md);
      });
    }
  }
  it("writes an empty item as the bare marker", () => {
    expect(serializeMd(list("orderedList", "a", undefined))).toBe("1. a\n2.");
    expect(serializeMd(list("bulletList", undefined, "b"))).toBe("-\n- b");
    expect(serializeMd(list("taskList", "a", undefined))).toBe("- [ ] a\n- [ ]");
  });
  it("reads a bare marker after an item as an empty item, not as text of the item above", () => {
    expect(items(parseMd("1. a\n2."))).toEqual(["a", ""]);
    expect(items(parseMd("1. a\n2. \n3. c"))).toEqual(["a", "", "c"]);
    expect(items(parseMd("- [ ] a\n- [ ]"))).toEqual(["a", ""]);
    expect(renderMd("1. a\n2.")).not.toContain("2.");
    expect(renderMd("1. a\n2.").match(/<li>/g)).toHaveLength(2);
  });
  it("keeps ordered lists that are not empty as they were", () => {
    for (const s of ["1. a\n2. b", "3. a\n4. b", "1. a\n   1. b\n2. c", "- [x] a\n  - [ ] b\n- [ ] c", "- a\n  1. b"]) expect(serializeMd(parseMd(s))).toBe(s);
    // 段落中间的 "2. y" 不起列表（CommonMark：不从 1 开始的有序列表不打断段落）
    expect(items(parseMd("x\n2. y"))).toEqual(["<paragraph>"]);
  });
});
