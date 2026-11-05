// @vitest-environment jsdom
// Size-aware image sources (picture.ts): the resolver lists an image's smaller copies, and each image shows the smallest one still
// sharp at its laid-out width times the display scale, stepping up (never down) as either grows, decoded before the swap. The
// Markdown, the editor's document and an export keep the address as written; only what is shown changes
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { createMarkdown, coreOf, type Markdown } from "../src/markdown";
import { pickCopy, type ResolvedImage } from "../src/picture";
import { parseMd, serializeMd, sourceExtensions } from "../src/schema";
import { sourceDoc, sourceMd } from "../src/editor/srcdoc";
import { mdPlugin } from "../src/editor/md";
import { atomWidget } from "../src/editor/widgets";
import type { Atom } from "../src/editor/spans";

const SRC = "assets/0123456789abcdef-2400x1200.png";
const NOTE = `A screenshot:\n\n![run](${SRC} "The run")\n\nand text.`;

/** ResizeObserver that the test drives: lay(img, w) reports img laid out w CSS px wide */
let observed: { cb: ResizeObserverCallback; els: Set<Element> }[] = [];
class FakeRO {
  els = new Set<Element>();
  constructor(cb: ResizeObserverCallback) {
    observed.push({ cb, els: this.els });
  }
  observe(e: Element) {
    this.els.add(e);
  }
  unobserve(e: Element) {
    this.els.delete(e);
  }
  disconnect() {
    this.els.clear();
  }
}
function lay(img: Element, width: number) {
  for (const o of observed)
    if (o.els.has(img))
      o.cb([{ target: img, contentRect: { width, height: width / 2 } } as unknown as ResizeObserverEntry], {} as never);
}
/** The image as loaded (decoded and drawn): what is on screen from then on */
function loaded(img: HTMLImageElement) {
  Object.defineProperty(img, "complete", { configurable: true, get: () => true });
  Object.defineProperty(img, "naturalWidth", { configurable: true, get: () => 100 });
}

let decodes: { src: string; done: () => void }[] = [];
beforeEach(() => {
  observed = [];
  decodes = [];
  vi.stubGlobal("ResizeObserver", FakeRO);
  // decode() waits until the test lets it finish
  HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
    return new Promise<void>((done) => decodes.push({ src: this.src, done }));
  };
});
afterEach(() => vi.unstubAllGlobals());

/** An instance whose resolver lists copies at 400, 800 and 1600 (made: the widths whose copy exists) */
function setup(made = [400, 800, 1600]) {
  let scale = 1;
  const asked: [string, number][] = [];
  const have = new Set(made);
  const resolve = (src: string): ResolvedImage | undefined =>
    src.startsWith("assets/")
      ? {
          src: `/full/${src.slice(7)}`,
          width: 2400,
          height: 1200,
          copies: [400, 800, 1600].map((w) => ({ width: w, src: have.has(w) ? `/copy/${w}.png` : undefined })),
        }
      : undefined;
  const md = createMarkdown({
    images: resolve,
    displayScale: () => scale,
    makeImageCopy: (src, w) => void asked.push([src, w]),
  });
  return {
    md,
    asked,
    have,
    setScale: (s: number) => (scale = s),
  };
}
function show(md: Markdown, src = NOTE) {
  const el = document.createElement("div");
  el.className = "md";
  document.body.append(el);
  const html = md.render(src);
  el.innerHTML = html;
  md.hydrate(el, html);
  return { el, img: el.querySelector("img")! };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("picking a copy", () => {
  it("takes the smallest copy at least the size seen, with headroom; the original past the largest", () => {
    const c = [{ width: 400 }, { width: 800 }, { width: 1600 }];
    expect(pickCopy(c, 300)?.width).toBe(400);
    expect(pickCopy(c, 347)?.width).toBe(400);
    expect(pickCopy(c, 348)?.width).toBe(800); // 348 × 1.15 > 400
    expect(pickCopy(c, 960)?.width).toBe(1600);
    expect(pickCopy(c, 1500)).toBeUndefined();
    expect(pickCopy([], 100)).toBeUndefined();
    expect(pickCopy(undefined, 100)).toBeUndefined();
  });
});

describe("the resolver contract", () => {
  it("keeps the address as written in the Markdown and in the rendered HTML, with the original as src", () => {
    const { md } = setup();
    expect(serializeMd(parseMd(NOTE))).toBe(NOTE);
    const html = md.render(NOTE);
    const d = document.createElement("div");
    d.innerHTML = html;
    const img = d.querySelector("img")!;
    // the HTML (cached by source, what an export renders) has the original; the copy is picked once it is on the page
    expect(img.getAttribute("src")).toBe("/full/0123456789abcdef-2400x1200.png");
    expect(img.dataset.src).toBe(SRC);
    expect(img.getAttribute("width")).toBe("2400");
    expect(html).not.toContain("/copy/");
  });

  it("shows a copy sized to the image as laid out, and keeps the original's size and address on it", () => {
    const { md } = setup();
    const { img } = show(md);
    // before layout: a first guess (480 px), set before the image starts loading
    expect(img.getAttribute("src")).toBe("/copy/800.png");
    expect(img.dataset.full).toBe("/full/0123456789abcdef-2400x1200.png");
    expect(img.dataset.src).toBe(SRC);
    // laid out 300 px wide, nothing loaded yet: it may still go down
    lay(img, 300);
    expect(img.getAttribute("src")).toBe("/copy/400.png");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["2400", "1200"]);
  });

  it("steps up when zoomed in, decoding first, and never back down while on the page", async () => {
    const { md, setScale } = setup();
    const { img } = show(md);
    lay(img, 300);
    loaded(img);
    setScale(2.5); // 750 device px: the 1600 copy
    md.updateImages();
    // still the old one until the next decodes
    expect(img.getAttribute("src")).toBe("/copy/400.png");
    expect(decodes.map((d) => d.src)).toEqual([expect.stringContaining("/copy/1600.png")]);
    decodes[0].done();
    await flush();
    expect(img.getAttribute("src")).toBe("/copy/1600.png");
    // zoomed in past the largest copy: the original
    setScale(6);
    md.updateImages();
    decodes[1].done();
    await flush();
    expect(img.getAttribute("src")).toBe("/full/0123456789abcdef-2400x1200.png");
    // zoomed out again: it keeps what it has
    setScale(1);
    md.updateImages();
    expect(decodes).toHaveLength(2);
    expect(img.getAttribute("src")).toBe("/full/0123456789abcdef-2400x1200.png");
    // the Markdown it came from is unchanged
    expect(img.dataset.src).toBe(SRC);
  });

  it("a Note drawn again starts from the width its image had", () => {
    const { md } = setup();
    const a = show(md);
    lay(a.img, 300);
    a.el.remove();
    const b = show(md);
    expect(b.img.getAttribute("src")).toBe("/copy/400.png");
  });

  it("asks for a copy not made yet, shows the original meanwhile, and takes the copy once it is there", async () => {
    const { md, asked, have } = setup([1600]);
    const { img } = show(md);
    lay(img, 300);
    // 400 is wanted: the larger copy that is there stands in
    expect(asked).toEqual([
      [SRC, 800],
      [SRC, 400],
    ]);
    expect(img.getAttribute("src")).toBe("/copy/1600.png");
    loaded(img);
    have.add(400);
    md.updateImages();
    decodes.at(-1)!.done();
    await flush();
    expect(img.getAttribute("src")).toBe("/copy/400.png");
  });

  it("with no copy made at all, shows the original until one is", () => {
    const { md, asked } = setup([]);
    const { img } = show(md);
    expect(img.getAttribute("src")).toBe("/full/0123456789abcdef-2400x1200.png");
    expect(asked).toEqual([[SRC, 800]]);
  });

  it("an image off screen keeps its source until it comes on screen", async () => {
    let on = false;
    const md = createMarkdown({
      images: (src) => ({
        src: `/full/${src}`,
        width: 2400,
        height: 1200,
        copies: [400, 800].map((w) => ({ width: w, src: `/copy/${w}.png` })),
      }),
      displayScale: () => 3,
      imageVisible: () => on,
    });
    const { el, img } = show(md);
    lay(img, 100); // 345 device px: 400
    expect(img.getAttribute("src")).toBe("/copy/400.png");
    loaded(img);
    lay(img, 200); // wants 800, but off screen
    md.updateImages();
    expect(decodes).toHaveLength(0);
    on = true;
    md.updateImages(el);
    expect(decodes.map((d) => d.src)).toEqual([expect.stringContaining("/copy/800.png")]);
  });

  it("a copy that fails to load gives way to the original", () => {
    const { md } = setup();
    const { img } = show(md);
    lay(img, 300);
    img.dispatchEvent(new Event("error"));
    expect(img.isConnected).toBe(true);
    expect(img.getAttribute("src")).toBe("/full/0123456789abcdef-2400x1200.png");
    // the original failing too: the placeholder
    img.dispatchEvent(new Event("error"));
    expect(img.isConnected).toBe(false);
  });

  it("an image the resolver does not know, or one without a known size, shows as resolved", () => {
    const md = createMarkdown({
      images: (src) =>
        src.startsWith("a/") ? { src: `/x/${src}`, copies: [{ width: 400, src: "/c.png" }] } : undefined,
    });
    const a = show(md, "![](a/b.png)").img;
    lay(a, 100);
    expect(a.getAttribute("src")).toBe("/x/a/b.png");
    const b = show(md, "![](https://e.x/p.png)").img;
    expect(b.getAttribute("src")).toBe("https://e.x/p.png");
    expect(b.dataset.src).toBeUndefined();
  });

  it("an image shown before its copies are known takes its copy once they are, then only steps up", async () => {
    let known = false;
    const md = createMarkdown({
      images: (src) => ({
        src: `/full/${src}`,
        width: 2400,
        height: 1200,
        copies: known ? [400, 800, 1600].map((w) => ({ width: w, src: `/copy/${w}.png` })) : undefined,
      }),
      displayScale: () => 1,
    });
    const img = document.createElement("img");
    document.body.append(img);
    md.showImage(img, SRC);
    lay(img, 600);
    expect(img.getAttribute("src")).toBe(`/full/${SRC}`);
    loaded(img);
    known = true;
    md.updateImages();
    expect(decodes.map((d) => d.src)).toEqual([expect.stringContaining("/copy/800.png")]);
    decodes[0].done();
    await flush();
    expect(img.getAttribute("src")).toBe("/copy/800.png");
    // from then on it steps up only: a narrower layout keeps the 800 copy
    lay(img, 200);
    expect(img.getAttribute("src")).toBe("/copy/800.png");
    expect(decodes).toHaveLength(1);
  });

  it("showImage picks the source of an <img> of the page's own the same way", async () => {
    const { md, setScale } = setup();
    const img = document.createElement("img");
    document.body.append(img);
    const stop = md.showImage(img, SRC);
    lay(img, 600); // 690 device px
    expect(img.getAttribute("src")).toBe("/copy/800.png");
    expect(img.dataset.full).toBe("/full/0123456789abcdef-2400x1200.png");
    loaded(img);
    stop();
    setScale(4);
    md.updateImages();
    expect(decodes).toHaveLength(0);
  });
});

describe("the editor", () => {
  it("keeps the address as written in its document and shows the image the same way", () => {
    const { md } = setup();
    const schema = getSchema(sourceExtensions);
    const doc = schema.nodeFromJSON(sourceDoc(NOTE));
    // the editor's document is the Markdown source: the address comes back as written
    expect(sourceMd(doc.toJSON())).toBe(NOTE);
    const state = EditorState.create({ doc, plugins: [mdPlugin(coreOf(md))] });
    const at = NOTE.indexOf("![");
    const atom = {
      type: "image",
      src: SRC,
      alt: "run",
      title: "The run",
      width: null,
      frame: null,
      loop: false,
      altTo: at + 5,
      url: [at + 7, at + 7 + SRC.length],
      widthAt: null,
      broken: false,
    } as unknown as Atom;
    const el = atomWidget(
      atom,
      `![run](${SRC} "The run")`,
      () => at,
      () => {},
    )({ state } as unknown as EditorView, () => at);
    document.body.append(el);
    const img = el.querySelector("img")!;
    expect(img.dataset.src).toBe(SRC);
    expect(img.getAttribute("src")).toBe("/copy/800.png");
    lay(img, 300);
    expect(img.getAttribute("src")).toBe("/copy/400.png");
    expect(sourceMd(state.doc.toJSON())).toBe(NOTE);
  });
});
