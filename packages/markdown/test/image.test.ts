// @vitest-environment jsdom
// Images in Markdown: ![alt](path) round-trips unchanged; the static render asks the page's resolver for the displayed address and
// size (width / height reserve the space before the image decodes) and decodes lazily
import { beforeEach, describe, expect, it } from "vitest";
import { parseMd, serializeMd } from "../src/schema";
import { createMarkdown, type Markdown } from "../src/markdown";
import { imageCaption, setImageCaption, setTableCaption, tableCaption } from "../src/caption";
import { mdBlockStarts } from "../src/schema";
import { sourceDoc, sourceMd } from "../src/editor/srcdoc";

const rt = (s: string) => serializeMd(parseMd(s));
const imgOf = (html: string) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.querySelector("img")!;
};

let markdown: Markdown;
beforeEach(() => {
  markdown = createMarkdown();
});

describe("image Markdown round trip", () => {
  it("keeps ![alt](path) as typed: relative, absolute, with a title, next to text", () => {
    for (const s of [
      "![](assets/0123456789abcdef-640x480.png)",
      "![screen shot](assets/a.png)",
      '![x](https://a.b/c.png "Title")',
      "before ![a](assets/a.png) after",
      "![a](assets/a.png)![b](assets/b.png)",
    ]) {
      expect(rt(s)).toBe(s);
    }
  });
  it("writes an inserted image (what a paste adds) as ![](path)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            { type: "image", attrs: { src: "assets/0123456789abcdef-12x7.gif", alt: "" } },
          ],
        },
      ],
    };
    expect(serializeMd(doc)).toBe("see ![](assets/0123456789abcdef-12x7.gif)");
    expect(parseMd(serializeMd(doc)).content![0].content![1]).toMatchObject({
      type: "image",
      attrs: { src: "assets/0123456789abcdef-12x7.gif", alt: "" },
    });
  });
  it("never puts image bytes into the Markdown for a path", () => {
    expect(rt("![](assets/x.png)")).not.toContain("base64");
  });
});

describe("image width", () => {
  const img = (s: string) => parseMd(s).content![0].content!.find((n) => n.type === "image")!;
  it("reads {width=N%} after an image as its width and writes it back the same", () => {
    for (const s of [
      "![a](assets/a.png){width=40%}",
      "see ![a](assets/a.png){width=33.5%} here",
      '![x](https://a.b/c.png "Title"){width=100%}',
      "[![a](assets/a.png){width=20%}](https://l.test)",
      "**![a](assets/a.png){width=20%}** b",
    ]) {
      expect(rt(s)).toBe(s);
    }
    expect(img("![a](assets/a.png){width=40%}").attrs).toMatchObject({ src: "assets/a.png", alt: "a", width: 40 });
    expect(img("![a](assets/a.png)").attrs!.width).toBeNull();
  });
  it("writes an image's width (what a resize sets) and nothing for a full-width one", () => {
    const doc = (width: number | null) => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "image", attrs: { src: "assets/a.png", alt: "", width } }] }],
    });
    expect(serializeMd(doc(25))).toBe("![](assets/a.png){width=25%}");
    expect(serializeMd(doc(null))).toBe("![](assets/a.png)");
    expect(img(serializeMd(doc(25))).attrs!.width).toBe(25);
  });
  it("leaves other braces as text: out of range, not right after the image, or escaped", () => {
    for (const s of [
      "![a](assets/a.png){width=150%}",
      "![a](assets/a.png){width=0%}",
      "![a](assets/a.png) {width=40%}",
      "![a](assets/a.png){height=40%}",
    ]) {
      expect(rt(s)).toBe(s);
      expect(img(s).attrs!.width).toBeNull();
    }
    expect(img("![a](assets/a.png)\\{width=40%}").attrs!.width).toBeNull();
  });
  it("escapes text that would read back as the width of the image before it", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "image", attrs: { src: "assets/a.png", alt: "" } },
            { type: "text", text: "{width=40%} literal" },
          ],
        },
      ],
    };
    const md = serializeMd(doc);
    expect(md).toBe("![](assets/a.png)\\{width=40%} literal");
    expect(parseMd(md).content![0].content).toMatchObject([
      { type: "image", attrs: { width: null } },
      { type: "text", text: "{width=40%} literal" },
    ]);
  });
  it("renders the width as a percentage of the body, centered", () => {
    const im = imgOf(markdown.render("![](assets/w.png){width=40%}"));
    expect(im.style.width).toBe("40%");
    expect(im.classList.contains("sized")).toBe(true); // centered (markdown.css)
    expect(imgOf(markdown.render("![](assets/w.png)")).hasAttribute("style")).toBe(false);
  });
  it("keeps the paragraph around a sized image in a list item or table cell, marked p.md-psized to center it", () => {
    const host = document.createElement("div");
    host.innerHTML = markdown.render(
      "- ![](assets/w.png){width=40%}\n- ![](assets/w.png)\n\n| a |\n| - |\n| [![](assets/w.png){width=40%}](https://a.b) |",
    );
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
    const im = imgOf(markdown.render("![cat](assets/c.png)"));
    expect(im.getAttribute("src")).toBe("assets/c.png");
    expect(im.getAttribute("alt")).toBe("cat");
    expect(im.getAttribute("loading")).toBe("lazy");
    expect(im.getAttribute("decoding")).toBe("async");
    expect(im.getAttribute("draggable")).toBe("false");
    expect(im.hasAttribute("width")).toBe(false);
  });
  it("with eagerImages, loads at once and draws only decoded", () => {
    const im = imgOf(createMarkdown({ eagerImages: true }).render("![cat](assets/c.png)"));
    expect(im.hasAttribute("loading")).toBe(false);
    expect(im.getAttribute("decoding")).toBe("sync");
  });
  it("uses the resolver's address and size, so the space is reserved before the image loads", () => {
    markdown.setImageResolver((src) => {
      const m = /^assets\/(.*-(\d+)x(\d+)\.\w+)$/.exec(src);
      return m ? { src: `https://res.test/a/${m[1]}`, width: +m[2], height: +m[3] } : undefined;
    });
    const im = imgOf(markdown.render("![](assets/0123456789abcdef-640x480.png)"));
    expect(im.getAttribute("src")).toBe("https://res.test/a/0123456789abcdef-640x480.png");
    expect([im.getAttribute("width"), im.getAttribute("height")]).toEqual(["640", "480"]);
    const ext = imgOf(markdown.render("![](https://a.b/c.png)"));
    expect(ext.getAttribute("src")).toBe("https://a.b/c.png");
    expect(ext.hasAttribute("width")).toBe(false);
  });
  it("renders again when the resolver changes (no stale address from the cache)", () => {
    markdown.setAssetBase("assets", "https://one.test");
    expect(imgOf(markdown.render("![](assets/k.png)")).getAttribute("src")).toBe("https://one.test/k.png");
    markdown.setAssetBase("assets/", "https://two.test");
    expect(imgOf(markdown.render("![](assets/k.png)")).getAttribute("src")).toBe("https://two.test/k.png");
    markdown.setAssetBase("assets", "");
    expect(imgOf(markdown.render("![](assets/k.png)")).getAttribute("src")).toBe("assets/k.png");
  });
  it("resolves only addresses under the folder it is given", () => {
    markdown.setAssetBase("media/img", "/static");
    expect(imgOf(markdown.render("![](media/img/k.png)")).getAttribute("src")).toBe("/static/k.png");
    expect(imgOf(markdown.render("![](assets/k.png)")).getAttribute("src")).toBe("assets/k.png");
    expect(imgOf(markdown.render("![](media/imgs.png)")).getAttribute("src")).toBe("media/imgs.png");
    markdown.setAssetBase("media/img", "");
  });
  it("keeps each instance's addresses to itself", () => {
    const other = createMarkdown({ images: (src) => ({ src: `/other/${src}` }) });
    markdown.setAssetBase("assets", "/one");
    expect(imgOf(markdown.render("![](assets/k.png)")).getAttribute("src")).toBe("/one/k.png");
    expect(imgOf(other.render("![](assets/k.png)")).getAttribute("src")).toBe("/other/assets/k.png");
  });
});

describe("image captions (the title)", () => {
  it("round-trips captions, escaping quotes and backslashes, with a width after", () => {
    for (const s of [
      '![a](assets/a.png "Figure 1: a warp")',
      '![](assets/a.png "say \\"hi\\" \\\\ x")',
      '![a](assets/a.png "Fig. 2 (left)"){width=40%}',
      'see ![a](https://a.b/c.png "c") here',
    ])
      expect(rt(s)).toBe(s);
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "image", attrs: { src: "assets/a.png", alt: "", title: 'two\nlines "q"' } }],
        },
      ],
    };
    expect(serializeMd(doc)).toBe('![](assets/a.png "two lines \\"q\\"")');
    expect(parseMd(serializeMd(doc)).content![0].content![0].attrs!.title).toBe('two lines "q"');
  });
  it("renders the caption under the image (static), with the width on the figure, and none for an empty title", () => {
    const d = document.createElement("div");
    d.innerHTML = markdown.render('![a](assets/a.png "Figure 1"){width=40%}');
    const fig = d.querySelector(".md-fig")!;
    expect(fig.querySelector(".md-cap")!.textContent).toBe("Figure 1");
    expect(fig.classList.contains("sized")).toBe(true);
    expect((fig as HTMLElement).style.width).toBe("40%");
    expect(fig.querySelector("img")!.hasAttribute("title")).toBe(false);
    expect(fig.querySelector("img")!.hasAttribute("style")).toBe(false);
    d.innerHTML = markdown.render('![a](assets/a.png "  ")');
    expect(d.querySelector(".md-fig")).toBeNull();
    expect(d.querySelector("img")).not.toBeNull();
  });
  it("sets, changes and removes the caption of the nth image with that address, touching nothing else", () => {
    const md =
      "# T\n\n`![x](assets/a.png)` and\n\n```\n![y](assets/a.png)\n```\n\n![first (1)](assets/a.png)\n\nmid *text*  \n![second](<assets/a.png> 'old'){width=50%}";
    expect(imageCaption(md, "assets/a.png", 0)).toBe("");
    expect(imageCaption(md, "assets/a.png", 1)).toBe("old");
    expect(imageCaption(md, "assets/a.png", 2)).toBeNull();
    const one = setImageCaption(md, "assets/a.png", 0, 'A "quoted" one');
    expect(one).toBe(md.replace("![first (1)](assets/a.png)", '![first (1)](assets/a.png "A \\"quoted\\" one")'));
    expect(imageCaption(one, "assets/a.png", 0)).toBe('A "quoted" one');
    const two = setImageCaption(md, "assets/a.png", 1, "new");
    expect(two).toBe(md.replace("![second](<assets/a.png> 'old')", '![second](<assets/a.png> "new")'));
    expect(setImageCaption(two, "assets/a.png", 1, " ")).toBe(
      md.replace("![second](<assets/a.png> 'old')", "![second](<assets/a.png>)"),
    );
    expect(setImageCaption(md, "assets/zzz.png", 0, "x")).toBe(md);
  });
});

describe("captions with inline Markdown", () => {
  it("typesets $formulas$ in an image caption, keeps the title as written, and leaves a caption that reads as a block as text", () => {
    const md = '![](assets/a.png "图 5.7：对 $M$ 和 $N$ tiling **以**利用 shared memory")';
    expect(rt(md)).toBe(md);
    const d = document.createElement("div");
    d.innerHTML = markdown.render(md);
    const cap = d.querySelector(".md-fig .md-cap")!;
    expect(cap.querySelectorAll(".katex").length).toBe(2);
    expect(cap.querySelector("strong")?.textContent).toBe("以");
    expect(cap.textContent).not.toContain("$");
    d.innerHTML = markdown.render('![](assets/a.png "1. not a list")');
    expect(d.querySelector(".md-cap")!.textContent).toBe("1. not a list");
  });
  it("gives a narrowed image's figure its share of the body width (--f), for the caption to keep the body width", () => {
    const d = document.createElement("div");
    d.innerHTML = markdown.render('![](assets/a.png "c"){width=56%}');
    expect((d.querySelector(".md-fig") as HTMLElement).style.getPropertyValue("--f")).toBe("0.56");
  });
});

describe("table captions (a Table: line after the table)", () => {
  const T = "| a   | b   |\n| --- | --- |\n| 1   | 2   |";
  it("reads the line onto the table and writes it back the same, $formulas$ included", () => {
    const md = `Intro\n\n${T}\n\nTable: Table 2: sizes of $M$ and \`n\`\n\nAfter`;
    const doc = parseMd(md);
    expect(doc.content!.map((n) => n.type)).toEqual(["paragraph", "table", "paragraph"]);
    expect(doc.content![1].attrs!.caption).toBe("Table 2: sizes of $M$ and `n`");
    expect(rt(md)).toBe(md);
    expect(sourceMd(sourceDoc(md))).toBe(md);
    expect(mdBlockStarts(md)).toEqual([0, 7, md.indexOf("After")]);
  });
  it("is only a caption right after a table: elsewhere it stays a paragraph", () => {
    for (const md of [`Table: not one\n\n${T}`, `${T}\n\nText\n\nTable: not one`, "Table: alone"])
      expect(rt(md)).toBe(md);
    expect(parseMd(`${T}\n\nTable: x\n\nTable: y`).content!.map((n) => n.type)).toEqual(["table", "paragraph"]);
  });
  it("renders the caption under the table in a .md-tfig, spaced as a block", () => {
    const d = document.createElement("div");
    d.innerHTML = markdown.render(`Intro\n\n${T}\n\nTable: Sizes of $M$`);
    const fig = d.querySelector(".md-tfig")!;
    expect(fig.classList.contains("md-gap")).toBe(true);
    expect(fig.firstElementChild!.tagName).toBe("TABLE");
    expect(fig.lastElementChild!.className).toBe("md-cap");
    expect(fig.lastElementChild!.querySelectorAll(".katex").length).toBe(1);
    d.innerHTML = markdown.render(T);
    expect(d.querySelector(".md-tfig")).toBeNull();
  });
  it("sets, changes and removes the caption of the nth table, rewriting only the block it is in", () => {
    const md = `# *T*\n\n- list\n\n  ${T.replace(/\n/g, "\n  ")}\n\n${T}\n\nTable: old\n\nend   *x*`;
    expect(tableCaption(md, 0)).toBe("");
    expect(tableCaption(md, 1)).toBe("old");
    expect(tableCaption(md, 2)).toBeNull();
    const one = setTableCaption(md, 1, "new\n$M$");
    expect(one).toBe(md.replace("Table: old", "Table: new $M$"));
    expect(setTableCaption(one, 1, " ")).toBe(md.replace("\n\nTable: old", ""));
    const nested = setTableCaption(md, 0, "inner");
    expect(tableCaption(nested, 0)).toBe("inner");
    expect(tableCaption(nested, 1)).toBe("old");
    expect(nested.endsWith("Table: old\n\nend   *x*")).toBe(true);
    expect(setTableCaption(md, 5, "x")).toBe(md);
  });
});

describe("![alt](…) whose address does not parse", () => {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='36' height='15'><rect width='36' height='15' fill='%23f6f1e7'/></svg>";
  const bad = `before ![SM 示意图](data:image/svg+xml;utf8,${svg}) after`;
  it("draws as an image that failed to load, never as the inline <svg> it holds", () => {
    const d = document.createElement("div");
    d.innerHTML = markdown.render(bad);
    expect(d.querySelector(".md-imgerr")?.textContent).toBe("Image failed to load · SM 示意图");
    expect([...d.querySelectorAll("img, svg")].filter((e) => !e.closest(".md-imgerr")).length).toBe(0);
    expect(d.textContent).toBe("before Image failed to load · SM 示意图 after");
  });
  it("keeps its source as written", () => {
    expect(rt(bad)).toBe(bad);
  });
  it("percent-encoded, the same address is an image", () => {
    const ok = `![SM 示意图](data:image/svg+xml;utf8,${encodeURIComponent(decodeURIComponent(svg)).replace(/'/g, "%27")})`;
    expect(imgOf(markdown.render(ok))?.getAttribute("alt")).toBe("SM 示意图");
    expect(rt(ok)).toBe(ok);
  });
});
