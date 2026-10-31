import { describe, expect, it } from "vitest";
import { blockInfo, flat, type Span } from "../src/editor/spans";

// What the editor draws for a paragraph's source: where each span is, which characters are its markers, the text inside
const at = (text: string, sp: Span) => ({
  text: text.slice(sp.from, sp.to),
  marks: sp.marks.map(([a, b]) => text.slice(a, b)),
  inner: sp.inner ? text.slice(sp.inner[0], sp.inner[1]) : null,
  kind: sp.atom?.type ?? sp.tag?.nodeName ?? "esc",
});
const all = (text: string, headings = true) => flat(blockInfo(text, headings).spans).map((sp) => at(text, sp));

describe("decoration ranges of a paragraph's source", () => {
  it("heading prefix, only outside table cells", () => {
    expect(blockInfo("## T **b**")).toMatchObject({ level: 2, prefix: 3 });
    expect(blockInfo("## T", false)).toMatchObject({ level: 0, prefix: 0 });
    expect(blockInfo("\\## not")).toMatchObject({ level: 0 });
    expect(all("## T **b**")).toEqual([{ text: "**b**", marks: ["**", "**"], inner: "b", kind: "strong" }]);
  });
  it("nested formatting: markers of each level, inner text", () => {
    expect(all("a **b *c* d** e")).toEqual([
      { text: "**b *c* d**", marks: ["**", "**"], inner: "b *c* d", kind: "strong" },
      { text: "*c*", marks: ["*", "*"], inner: "c", kind: "em" },
    ]);
    expect(
      all("==h== ~~s~~ H~2~O x^2^ <u>u</u> <kbd>K</kbd>").map((s) => [s.kind, s.marks.join(" "), s.inner]),
    ).toEqual([
      ["mark", "== ==", "h"],
      ["s", "~~ ~~", "s"],
      ["sub", "~ ~", "2"],
      ["sup", "^ ^", "2"],
      ["u", "<u> </u>", "u"],
      ["kbd", "<kbd> </kbd>", "K"],
    ]);
  });
  it("code spans keep their content unparsed; links mark [ and ](url)", () => {
    expect(all("`**x**` and [t **b**](https://u)")).toEqual([
      { text: "`**x**`", marks: ["`", "`"], inner: "**x**", kind: "code" },
      { text: "[t **b**](https://u)", marks: ["[", "](https://u)"], inner: "t **b**", kind: "a" },
      { text: "**b**", marks: ["**", "**"], inner: "b", kind: "strong" },
    ]);
  });
  it("atoms: formulas, images, emoji, refs, footnotes, <br>, notes, inline HTML", () => {
    const t = '$x$ $$y$$ ![a](i.png "c"){width=40%} :smile: [[R]] [^1] <br> {w|n} <span>h</span>';
    expect(all(t).map((s) => [s.kind, s.text])).toEqual([
      ["math", "$x$"],
      ["math", "$$y$$"],
      ["image", '![a](i.png "c"){width=40%}'],
      ["emoji", ":smile:"],
      ["ref", "[[R]]"],
      ["fn", "[^1]"],
      ["br", "<br>"],
      ["annot", "{w|n}"],
      ["html", "<span>h</span>"],
    ]);
    const img = flat(blockInfo(t).spans).find((s) => s.atom?.type === "image")!.atom!;
    expect(img).toMatchObject({ type: "image", src: "i.png", alt: "a", title: "c", width: 40 });
    if (img.type !== "image") throw new Error();
    expect(t.slice(img.url[0], img.url[1])).toBe("i.png");
    expect(t.slice(img.widthAt![0], img.widthAt![1])).toBe("{width=40%}");
    expect(t.slice(0, img.altTo).endsWith("![a")).toBe(true);
  });
  it("escapes: the backslash is the marker; an escaped $ is never a formula", () => {
    expect(all("a \\* b \\$5 and $x$")).toEqual([
      { text: "\\*", marks: ["\\"], inner: "*", kind: "esc" },
      { text: "\\$", marks: ["\\"], inner: "$", kind: "esc" },
      { text: "$x$", marks: ["$", "$"], inner: "x", kind: "math" },
    ]);
    expect(all("pay $5 and $6")).toEqual([]);
  });
  it("CJK text right before ** and an HTML comment shown as source", () => {
    expect(all("中文**粗体**中文")[0]).toMatchObject({ kind: "strong", inner: "粗体" });
    const c = flat(blockInfo("a <!-- n --> b").spans)[0];
    expect(c.plain).toBe(true);
  });
});
