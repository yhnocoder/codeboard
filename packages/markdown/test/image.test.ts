// @vitest-environment jsdom
// Images in Markdown: ![alt](path) round-trips unchanged; the static render asks the page's resolver for the displayed address and
// size (width / height reserve the space before the image decodes) and decodes lazily
import { afterEach, describe, expect, it } from "vitest";
import { parseMd, serializeMd } from "../src/schema";
import { renderMd } from "../src/render";
import { setAssetBase, setImageResolver } from "../src/image";
import { imageCaption, setImageCaption } from "../src/caption";

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

describe("image width", () => {
  const img = (s: string) => parseMd(s).content![0].content!.find((n) => n.type === "image")!;
  it("reads {width=N%} after an image as its width and writes it back the same", () => {
    for (const s of ["![a](assets/a.png){width=40%}", "see ![a](assets/a.png){width=33.5%} here", "![x](https://a.b/c.png \"Title\"){width=100%}", "[![a](assets/a.png){width=20%}](https://l.test)", "**![a](assets/a.png){width=20%}** b"]) {
      expect(rt(s)).toBe(s);
    }
    expect(img("![a](assets/a.png){width=40%}").attrs).toMatchObject({ src: "assets/a.png", alt: "a", width: 40 });
    expect(img("![a](assets/a.png)").attrs!.width).toBeNull();
  });
  it("writes an image's width (what a resize sets) and nothing for a full-width one", () => {
    const doc = (width: number | null) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "image", attrs: { src: "assets/a.png", alt: "", width } }] }] });
    expect(serializeMd(doc(25))).toBe("![](assets/a.png){width=25%}");
    expect(serializeMd(doc(null))).toBe("![](assets/a.png)");
    expect(img(serializeMd(doc(25))).attrs!.width).toBe(25);
  });
  it("leaves other braces as text: out of range, not right after the image, or escaped", () => {
    for (const s of ["![a](assets/a.png){width=150%}", "![a](assets/a.png){width=0%}", "![a](assets/a.png) {width=40%}", "![a](assets/a.png){height=40%}"]) {
      expect(rt(s)).toBe(s);
      expect(img(s).attrs!.width).toBeNull();
    }
    expect(img("![a](assets/a.png)\\{width=40%}").attrs!.width).toBeNull();
  });
  it("escapes text that would read back as the width of the image before it", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "image", attrs: { src: "assets/a.png", alt: "" } }, { type: "text", text: "{width=40%} literal" }] }] };
    const md = serializeMd(doc);
    expect(md).toBe("![](assets/a.png)\\{width=40%} literal");
    expect(parseMd(md).content![0].content).toMatchObject([{ type: "image", attrs: { width: null } }, { type: "text", text: "{width=40%} literal" }]);
  });
  it("renders the width as a percentage of the body, centered", () => {
    const im = imgOf(renderMd("![](assets/w.png){width=40%}"));
    expect(im.style.width).toBe("40%");
    expect(im.classList.contains("sized")).toBe(true); // centered (markdown.css)
    expect(imgOf(renderMd("![](assets/w.png)")).hasAttribute("style")).toBe(false);
  });
  it("keeps the paragraph around a sized image in a list item or table cell, marked p.md-psized to center it", () => {
    const host = document.createElement("div");
    host.innerHTML = renderMd("- ![](assets/w.png){width=40%}\n- ![](assets/w.png)\n\n| a |\n| - |\n| [![](assets/w.png){width=40%}](https://a.b) |");
    const [sized, full] = [...host.querySelectorAll("li")];
    expect(sized.firstElementChild!.tagName).toBe("P");
    expect(sized.firstElementChild!.classList.contains("md-psized")).toBe(true);
    expect(full.firstElementChild!.tagName).toBe("IMG");
    expect(host.querySelector("td > p.md-psized img.sized")).not.toBeNull();
    expect(host.querySelectorAll("p.md-psized").length).toBe(2);
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

describe("image captions (the title)", () => {
  it("round-trips captions, escaping quotes and backslashes, with a width after", () => {
    for (const s of ['![a](assets/a.png "Figure 1: a warp")', '![](assets/a.png "say \\"hi\\" \\\\ x")', '![a](assets/a.png "Fig. 2 (left)"){width=40%}', 'see ![a](https://a.b/c.png "c") here']) expect(rt(s)).toBe(s);
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "image", attrs: { src: "assets/a.png", alt: "", title: 'two\nlines "q"' } }] }] };
    expect(serializeMd(doc)).toBe('![](assets/a.png "two lines \\"q\\"")');
    expect(parseMd(serializeMd(doc)).content![0].content![0].attrs!.title).toBe('two lines "q"');
  });
  it("renders the caption under the image (static), with the width on the figure, and none for an empty title", () => {
    const d = document.createElement("div");
    d.innerHTML = renderMd('![a](assets/a.png "Figure 1"){width=40%}');
    const fig = d.querySelector(".md-fig")!;
    expect(fig.querySelector(".md-cap")!.textContent).toBe("Figure 1");
    expect(fig.classList.contains("sized")).toBe(true);
    expect((fig as HTMLElement).style.width).toBe("40%");
    expect(fig.querySelector("img")!.hasAttribute("title")).toBe(false);
    expect(fig.querySelector("img")!.hasAttribute("style")).toBe(false);
    d.innerHTML = renderMd('![a](assets/a.png "  ")');
    expect(d.querySelector(".md-fig")).toBeNull();
    expect(d.querySelector("img")).not.toBeNull();
  });
  it("sets, changes and removes the caption of the nth image with that address, touching nothing else", () => {
    const md = "# T\n\n`![x](assets/a.png)` and\n\n```\n![y](assets/a.png)\n```\n\n![first (1)](assets/a.png)\n\nmid *text*  \n![second](<assets/a.png> 'old'){width=50%}";
    expect(imageCaption(md, "assets/a.png", 0)).toBe("");
    expect(imageCaption(md, "assets/a.png", 1)).toBe("old");
    expect(imageCaption(md, "assets/a.png", 2)).toBeNull();
    const one = setImageCaption(md, "assets/a.png", 0, 'A "quoted" one');
    expect(one).toBe(md.replace("![first (1)](assets/a.png)", '![first (1)](assets/a.png "A \\"quoted\\" one")'));
    expect(imageCaption(one, "assets/a.png", 0)).toBe('A "quoted" one');
    const two = setImageCaption(md, "assets/a.png", 1, "new");
    expect(two).toBe(md.replace("![second](<assets/a.png> 'old')", '![second](<assets/a.png> "new")'));
    expect(setImageCaption(two, "assets/a.png", 1, " ")).toBe(md.replace("![second](<assets/a.png> 'old')", "![second](<assets/a.png>)"));
    expect(setImageCaption(md, "assets/zzz.png", 0, "x")).toBe(md);
  });
});
