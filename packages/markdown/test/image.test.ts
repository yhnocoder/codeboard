// @vitest-environment jsdom
// Images in Markdown: ![alt](path) round-trips unchanged; the static render asks the page's resolver for the displayed address and
// size (width / height reserve the space before the image decodes) and decodes lazily
import { afterEach, describe, expect, it } from "vitest";
import { parseMd, serializeMd } from "../src/schema";
import { renderMd } from "../src/render";
import { setAssetBase, setImageResolver } from "../src/image";

const rt = (s: string) => serializeMd(parseMd(s));
const imgOf = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; return d.querySelector("img")!; };

afterEach(() => setImageResolver(null));

describe("image Markdown round trip", () => {
  it("keeps ![alt](path) as typed: relative, absolute, with a title, next to text", () => {
    for (const s of ["![](assets/0123456789abcdef-640x480.png)", "![screen shot](assets/a.png)", "![x](https://a.b/c.png \"Title\")", "before ![a](assets/a.png) after", "![a](assets/a.png)![b](assets/b.png)"]) {
      expect(rt(s)).toBe(s);
    }
  });
  it("writes an inserted image (what a paste adds) as ![](path)", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "see " }, { type: "image", attrs: { src: "assets/0123456789abcdef-12x7.gif", alt: "" } }] }] };
    expect(serializeMd(doc)).toBe("see ![](assets/0123456789abcdef-12x7.gif)");
    expect(parseMd(serializeMd(doc)).content![0].content![1]).toMatchObject({ type: "image", attrs: { src: "assets/0123456789abcdef-12x7.gif", alt: "" } });
  });
  it("never puts image bytes into the Markdown for a path", () => {
    expect(rt("![](assets/x.png)")).not.toContain("base64");
  });
});

describe("image render", () => {
  it("leaves the address alone without a resolver, and decodes lazily", () => {
    const im = imgOf(renderMd("![cat](assets/c.png)"));
    expect(im.getAttribute("src")).toBe("assets/c.png");
    expect(im.getAttribute("alt")).toBe("cat");
    expect(im.getAttribute("loading")).toBe("lazy");
    expect(im.getAttribute("decoding")).toBe("async");
    expect(im.getAttribute("draggable")).toBe("false");
    expect(im.hasAttribute("width")).toBe(false);
  });
  it("uses the resolver's address and size, so the space is reserved before the image loads", () => {
    setImageResolver((src) => {
      const m = /^assets\/(.*-(\d+)x(\d+)\.\w+)$/.exec(src);
      return m ? { src: `https://res.test/a/${m[1]}`, width: +m[2], height: +m[3] } : undefined;
    });
    const im = imgOf(renderMd("![](assets/0123456789abcdef-640x480.png)"));
    expect(im.getAttribute("src")).toBe("https://res.test/a/0123456789abcdef-640x480.png");
    expect([im.getAttribute("width"), im.getAttribute("height")]).toEqual(["640", "480"]);
    const ext = imgOf(renderMd("![](https://a.b/c.png)"));
    expect(ext.getAttribute("src")).toBe("https://a.b/c.png");
    expect(ext.hasAttribute("width")).toBe(false);
  });
  it("renders again when the resolver changes (no stale address from the cache)", () => {
    setAssetBase("https://one.test");
    expect(imgOf(renderMd("![](assets/k.png)")).getAttribute("src")).toBe("https://one.test/k.png");
    setAssetBase("https://two.test");
    expect(imgOf(renderMd("![](assets/k.png)")).getAttribute("src")).toBe("https://two.test/k.png");
    setAssetBase("");
    expect(imgOf(renderMd("![](assets/k.png)")).getAttribute("src")).toBe("assets/k.png");
  });
});
