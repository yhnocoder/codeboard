// @vitest-environment jsdom
// Animated SVGs drawn inline in a Note (md/animsvg.ts): which SVGs count as animated, what the cleaning keeps (styles, keyframes,
// SMIL, theme variables, data-steps) and takes out (script, handlers, foreignObject, outside references, @import, :host),
// and that storing an SVG (md/images.ts cleanSvg) keeps its SMIL but not one that animates a link
import { describe, expect, it } from "vitest";
import { clockMs, inertCss, inlineSvg } from "../../src/md/animsvg";
import { cleanSvg } from "../../src/md/images";

const svg = (body: string, attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"${attrs}>${body}</svg>`;

describe("inlineSvg", () => {
  it("takes SVGs that animate by CSS keyframes, an animation in a style attribute, or SMIL", () => {
    expect(inlineSvg(svg("<style>@keyframes a{to{opacity:0}} rect{animation:a 1s}</style><rect/>"))).not.toBeNull();
    expect(inlineSvg(svg('<rect style="animation: a 1s infinite"/>'))).not.toBeNull();
    expect(inlineSvg(svg('<circle r="2"><animate attributeName="r" values="1;2" dur="1s"/></circle>'))).not.toBeNull();
    expect(
      inlineSvg(svg('<rect><animateTransform attributeName="transform" type="rotate" dur="2s"/></rect>')),
    ).not.toBeNull();
  });
  it("leaves a still SVG, and what is not an SVG, as images", () => {
    expect(inlineSvg(svg('<rect width="5" height="5"/>'))).toBeNull();
    expect(inlineSvg("<html><body>x</body></html>")).toBeNull();
    expect(inlineSvg("not svg")).toBeNull();
  });
  it("keeps the style, keyframes, theme variables, SMIL and data-steps", () => {
    const out = inlineSvg(
      svg(
        '<style>.a{fill:var(--ink,#1f1e1b);animation:m 2s infinite}@keyframes m{to{opacity:0}}</style><rect class="a"/><circle><animate attributeName="r" values="1;2" dur="1s"/><set attributeName="fill" to="red" begin="1s"/></circle>',
        ' data-steps="8"',
      ),
    )!;
    expect(out).toContain("var(--ink,#1f1e1b)");
    expect(out).toContain("@keyframes m");
    expect(out).toMatch(/<animate [^>]*attributeName="r"/);
    expect(out).toMatch(/<set [^>]*attributeName="fill"/);
    expect(out).toContain('data-steps="8"');
  });
  it("takes out script, handlers, foreignObject and SMIL that animates a link or a handler", () => {
    const out = inlineSvg(
      svg(
        '<style>@keyframes m{}</style><script>alert(1)</script><rect onclick="x()" onload="y()"/><foreignObject><div>x</div></foreignObject>' +
          '<a href="#k"><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="xlink:href" values="javascript:x"/>' +
          '<animate attributeName="onclick" values="x()"/></a>',
        ' onload="z()"',
      ),
    )!;
    expect(out).not.toMatch(/script|onclick|onload|foreignObject|javascript|attributeName="(?:xlink:)?href"/i);
  });
  it("loads nothing from elsewhere: outside hrefs, url() and @import go, fragments and data: images stay", () => {
    const out = inlineSvg(
      svg(
        '<style>@import url("https://x.test/a.css"); .a{fill:url(https://x.test/p.svg#g);animation:m 1s} .b{fill:url(#g)} @keyframes m{}</style>' +
          '<image href="https://x.test/a.png"/><image href="data:image/png;base64,AAAA"/><use href="#g"/>' +
          "<rect style=\"fill:url('http://x.test/q')\"/>",
      ),
    )!;
    expect(out).not.toMatch(/x\.test|@import/);
    expect(out).toContain("url(#g)");
    expect(out).toContain('href="data:image/png;base64,AAAA"');
  });
  it("keeps its CSS inside its shadow root: :host and ::slotted match nothing", () => {
    expect(inertCss(":host{position:fixed} :host-context(body) rect{x:1} ::slotted(p){}")).not.toMatch(
      /:host|::slotted/,
    );
  });
});

describe("cleanSvg keeps SMIL for an animated SVG it stores", () => {
  it("keeps animate and set, drops one that animates a link", () => {
    const out = cleanSvg(
      svg(
        '<circle r="2"><animate attributeName="r" values="1;2" dur="1s"/></circle><set attributeName="href" to="javascript:x"/>',
      ),
    )!;
    expect(out).toMatch(/<animate [^>]*attributeName="r"/);
    expect(out).not.toMatch(/javascript|attributeName="href"/);
  });
});

describe("clockMs", () => {
  it("reads SMIL clock values", () => {
    expect(clockMs("2s")).toBe(2000);
    expect(clockMs("500ms")).toBe(500);
    expect(clockMs("1.5")).toBe(1500);
    expect(clockMs("indefinite")).toBeNaN();
    expect(clockMs(null)).toBeNaN();
  });
});
