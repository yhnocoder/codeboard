// The Mac app's formula and diagram engines, run in JavaScriptCore (no DOM, no WebKit): MathJax turns TeX into SVG, pele
// turns Mermaid into SVG, and the native renderer draws that SVG itself (CodeBoardMarkdownUI). Exposed as
// globalThis.engines; text the SVG holds is measured by the host through globalThis.measureText(text, sizePx), so widths
// are the native font's
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { render as pele } from "pele";

declare const measureText: (text: string, size: number) => number;

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
// text MathJax has no glyphs for (Chinese in \text{…}): its width measured by the host at the size the SVG writes,
// in em of the formula as MathJax asks (nodeSize(node, 1000, true) → width / 1000)
adaptor.nodeSize = (node: unknown, em = 1) => {
  const text = adaptor.textContent(node as never);
  const size = parseFloat(adaptor.getAttribute(node as never, "font-size") ?? "1000") || 1000;
  return [measureText(text, size) / em, 0];
};
// autoload and require load packages asynchronously, which a synchronous engine cannot wait for
const packages = AllPackages.filter((p: string) => p !== "autoload" && p !== "require");

type Doc = ReturnType<typeof mathjax.document>;
const docs = new Map<string, Doc>();
/** a document per preamble: its \newcommand and \def lines are read once into it */
function docFor(preamble: string): Doc {
  let d = docs.get(preamble);
  if (d) return d;
  const tex = new TeX({
    packages,
    // no automatic numbers, and \tag is taken off by the native layout (MathTag): a labelled row makes MathJax lay the
    // formula out 100 % wide around the tag, which has no size to draw at
    tags: "none",
    formatError: (_jax: unknown, err: Error) => {
      throw err;
    },
  });
  d = mathjax.document("", { InputJax: tex, OutputJax: new SVG({ fontCache: "none" }) });
  if (preamble.trim()) {
    try {
      d.convert(preamble, { display: false });
    } catch {
      // a preamble that does not read leaves its definitions out; the formulas that use them report it
    }
  }
  if (docs.size > 8) docs.clear();
  docs.set(preamble, d);
  return d;
}

(globalThis as Record<string, unknown>).engines = {
  /** TeX → the SVG MathJax makes, or { error } */
  tex(src: string, display: boolean, preamble: string): { svg?: string; error?: string } {
    try {
      const node = docFor(preamble).convert(src, { display, em: 16, ex: 8, containerWidth: 100000 });
      return { svg: adaptor.innerHTML(node) };
    } catch (e) {
      return { error: String((e as Error).message ?? e) };
    }
  },
  /** Mermaid → { svg, width, height } or { error } */
  mermaid(src: string, fontFamily: string, maxWidth: number | null) {
    try {
      const r = pele(src, {
        measurer: { width: (text: string, size: number) => measureText(text, size) },
        fontFamily,
        ...(maxWidth ? { maxWidth } : {}),
      });
      return { svg: r.svg, width: r.width, height: r.height };
    } catch (e) {
      return { error: String((e as Error).message ?? e) };
    }
  },
};
