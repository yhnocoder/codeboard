// An SVG that animates without script (CSS keyframes in its own <style>, SMIL <animate>…) is drawn inline in a shadow root, not
// through <img>, so the board can read and drive its timeline. Inline, the SVG is part of the page: it is cleaned again here, more
// strictly than for storing it (md/images.ts cleanSvg): no script, event attributes or foreignObject (DOMPurify), nothing loaded
// from elsewhere (only #fragment and data: image references), no @import, and no selector that reaches outside its shadow root
import DOMPurify from "dompurify";

const SVG_NS = "http://www.w3.org/2000/svg";
/** SMIL elements DOMPurify's SVG profile leaves out; kept when what they animate cannot be a link or a handler */
export const SMIL_TAGS = ["animate", "set"];
const ANIMATING = "animate, set, animateTransform, animateMotion";
/** An animation element that would animate a link or an event attribute */
const unsafeTarget = (el: Element) => /^(?:on|(?:xlink:)?href$)/i.test((el.getAttribute("attributeName") ?? "").trim());

/** SMIL elements whose target attribute is a link or a handler go (DOMPurify does not look at attributeName) */
export function dropUnsafeSmil(root: Element) {
  for (const el of [...root.querySelectorAll(ANIMATING)]) if (unsafeTarget(el)) el.remove();
}

const okRef = (v: string) => /^\s*(?:#|data:image\/(?:png|jpe?g|gif|webp);)/i.test(v);
/** CSS with nothing that loads: no @import, url() only to #fragments and data: images; no :host / ::slotted (outside its root) */
export function inertCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (m, _q, u: string) => (okRef(u) ? m : "none"))
    .replace(/:host(?:-context)?\b|::slotted\b/gi, ":not(*)");
}

/** Whether a (cleaned) SVG animates by itself: CSS animations or SMIL */
const animates = (svg: Element) =>
  !!svg.querySelector(ANIMATING) ||
  [...svg.querySelectorAll("style")].some((s) => /@keyframes\b/i.test(s.textContent ?? "")) ||
  [...svg.querySelectorAll("[style]")].some((e) => /\banimation(?:-name)?\s*:/i.test(e.getAttribute("style") ?? ""));

/**
 * The SVG text as markup safe to put into a shadow root, when it animates; null for a still SVG (it stays an <img>) or one that
 * cannot be read
 */
export function inlineSvg(text: string): string | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== "svg" || doc.getElementsByTagNameNS("*", "parsererror").length)
    return null;
  const body = DOMPurify.sanitize(root, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: SMIL_TAGS,
    FORBID_TAGS: ["foreignObject", "script"],
    RETURN_DOM: true,
  });
  const svg = [...body.childNodes].find(
    (e): e is SVGSVGElement => e instanceof Element && e.namespaceURI === SVG_NS && e.localName === "svg",
  );
  if (!svg || !animates(svg)) return null;
  dropUnsafeSmil(svg);
  for (const el of [svg, ...svg.querySelectorAll("*")]) {
    for (const a of [...el.attributes]) {
      if (/^(?:xlink:)?href$/i.test(a.name) && !okRef(a.value)) el.removeAttribute(a.name);
      else if (a.name === "style") el.setAttribute("style", inertCss(a.value));
    }
    if (el.localName === "style") el.textContent = inertCss(el.textContent ?? "");
  }
  return new XMLSerializer().serializeToString(svg);
}

/** Times in an SVG's SMIL attributes (dur="2s", begin="0.5s"), in ms; NaN for what is not a plain clock value */
export function clockMs(v: string | null): number {
  const m = /^\s*([\d.]+)\s*(ms|s|min|h)?\s*$/.exec(v ?? "");
  if (!m) return NaN;
  return Number(m[1]) * ({ ms: 1, s: 1000, min: 60000, h: 3600000 }[m[2] ?? "s"] ?? 1000);
}
