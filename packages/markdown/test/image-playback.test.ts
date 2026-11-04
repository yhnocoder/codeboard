// @vitest-environment jsdom
// An animated image's playback in its Markdown: {frame=N loop=true} next to {width=N%} in the attribute block after the image.
// Read, written back unchanged, shown as data attributes, rewritten for one image only, and kept by a width change in the editor
import { describe, expect, it } from "vitest";
import { parseMd, serializeMd } from "../src/schema";
import { createMarkdown } from "../src/markdown";
import { imageAttrsAt, imageAttrsEnd, imageAttrsText } from "../src/imageattrs";
import { imagePlayback, setImagePlayback } from "../src/imageplay";
import { blockInfo, flat } from "../src/editor/spans";

const rt = (s: string) => serializeMd(parseMd(s));
const img = (s: string) => parseMd(s).content![0].content!.find((n) => n.type === "image")!;

describe("image attribute block", () => {
  it("reads width, frame and loop in any order", () => {
    expect(imageAttrsAt("{width=40% frame=3 loop=true} x")).toEqual({
      attrs: { width: 40, frame: 3, loop: true },
      raw: "{width=40% frame=3 loop=true}",
    });
    expect(imageAttrsAt("{loop=true  frame=12}")?.attrs).toEqual({ width: null, frame: 12, loop: true });
    expect(imageAttrsAt("{frame=2}")?.attrs).toEqual({ width: null, frame: 2, loop: false });
  });
  it("takes nothing that is not all attributes it knows: those stay text", () => {
    for (const s of [
      "{}",
      "{width=150%}",
      "{frame=0}",
      "{frame=x}",
      "{loop=yes}",
      "{loop}",
      "{frame=2 frame=3}",
      "{frame=2 color=red}",
      "{frame=2",
    ])
      expect(imageAttrsAt(s), s).toBeUndefined();
  });
  it("writes width first, then frame, then loop, and nothing for none", () => {
    expect(imageAttrsText({ width: 40, frame: 3, loop: true })).toBe("{width=40% frame=3 loop=true}");
    expect(imageAttrsText({ loop: true })).toBe("{loop=true}");
    expect(imageAttrsText({ width: null, frame: null, loop: false })).toBe("");
  });
  it("finds the block that ends an image's source", () => {
    const raw = "![a](u.gif){frame=4 loop=true}";
    expect(imageAttrsEnd(raw)).toEqual({ attrs: { width: null, frame: 4, loop: true }, at: raw.indexOf("{") });
    expect(imageAttrsEnd("![a](u.gif)")).toBeUndefined();
  });
});

describe("animated image playback in Markdown", () => {
  it("round-trips the attributes as typed and reads them onto the image", () => {
    for (const s of [
      "![a](assets/a.gif){frame=3}",
      "![a](assets/a.gif){loop=true}",
      '![a](assets/a.svg "Fig. 1"){width=40% frame=7 loop=true}',
      "see ![a](assets/a.gif){width=20% loop=true} here",
    ])
      expect(rt(s)).toBe(s);
    expect(img("![a](a.gif){loop=true frame=3}").attrs).toMatchObject({ frame: 3, loop: true, width: null });
    expect(img("![a](a.gif)").attrs).toMatchObject({ frame: null, loop: false });
  });
  it("keeps a block it does not know as text after the image", () => {
    const s = parseMd("![a](a.gif){frame=3 speed=2}").content![0].content!;
    expect(s[0].attrs).toMatchObject({ frame: null, loop: false });
    expect(s[1]).toMatchObject({ type: "text", text: "{frame=3 speed=2}" });
  });
  it("escapes text after an image that would read back as its attributes", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "image", attrs: { src: "a.gif", alt: "" } },
            { type: "text", text: "{loop=true} literal" },
          ],
        },
      ],
    };
    expect(serializeMd(doc)).toBe("![](a.gif)\\{loop=true} literal");
    expect(img(serializeMd(doc)).attrs!.loop).toBe(false);
  });
  it("shows them as data attributes on the image (static render)", () => {
    const d = document.createElement("div");
    d.innerHTML = createMarkdown().render('![a](a.gif "cap"){frame=5 loop=true}\n\n![b](b.gif)');
    const [a, b] = d.querySelectorAll("img");
    expect([a.getAttribute("data-frame"), a.hasAttribute("data-loop")]).toEqual(["5", true]);
    expect([b.hasAttribute("data-frame"), b.hasAttribute("data-loop")]).toEqual([false, false]);
  });
});

describe("setImagePlayback", () => {
  const md = "Intro **x**\n\n![](assets/a.gif)\n\nThen ![](assets/a.gif){width=40%} and `![](assets/a.gif)`\n";
  it("rewrites only the nth image's block, leaving the rest as typed", () => {
    expect(setImagePlayback(md, "assets/a.gif", 0, { frame: 4 })).toBe(
      "Intro **x**\n\n![](assets/a.gif){frame=4}\n\nThen ![](assets/a.gif){width=40%} and `![](assets/a.gif)`\n",
    );
    expect(setImagePlayback(md, "assets/a.gif", 1, { loop: true, frame: 2 })).toBe(
      "Intro **x**\n\n![](assets/a.gif)\n\nThen ![](assets/a.gif){width=40% frame=2 loop=true} and `![](assets/a.gif)`\n",
    );
  });
  it("frame 1 and loop off take their attribute away", () => {
    const s = "![](a.gif){width=30% frame=4 loop=true}";
    expect(setImagePlayback(s, "a.gif", 0, { frame: 1, loop: false })).toBe("![](a.gif){width=30%}");
    expect(setImagePlayback("![](a.gif){frame=4}", "a.gif", 0, { frame: null })).toBe("![](a.gif)");
  });
  it("reads them back, and leaves Markdown without that image alone", () => {
    const s = setImagePlayback(md, "assets/a.gif", 1, { frame: 9 });
    expect(imagePlayback(s, "assets/a.gif", 1)).toEqual({ width: 40, frame: 9, loop: false });
    expect(imagePlayback(s, "assets/a.gif", 0)).toEqual({ width: null, frame: null, loop: false });
    expect(setImagePlayback(md, "assets/b.gif", 0, { frame: 2 })).toBe(md);
    expect(setImagePlayback(md, "assets/a.gif", 0, { frame: null })).toBe(md);
  });
});

describe("the editor's image source", () => {
  it("takes the whole attribute block as the image's, with frame and loop", () => {
    const t = "x ![a](i.gif){width=40% frame=3 loop=true} y";
    const a = flat(blockInfo(t).spans).find((s) => s.atom?.type === "image")!;
    expect(t.slice(a.from, a.to)).toBe("![a](i.gif){width=40% frame=3 loop=true}");
    if (a.atom?.type !== "image") throw new Error();
    expect(a.atom).toMatchObject({ width: 40, frame: 3, loop: true });
    expect(t.slice(...a.atom.widthAt!)).toBe("{width=40% frame=3 loop=true}");
  });
});
