import { describe, it, expect } from "vitest";
import { parseWebMeta, charsetOf } from "../src/web";

describe("parseWebMeta", () => {
  it("prefers og tags and resolves relative URLs", () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="FlashAttention-3: Fast &amp; Accurate">
      <meta name="description" content="plain desc"><meta property='og:description' content="We develop three &#8230; techniques">
      <meta property="og:site_name" content="arXiv"><meta property="og:image" content="/static/og.png">
      <link rel="icon" href="/favicon-16.png" sizes="16x16"><link rel="icon" href="/favicon-32.png" sizes="32x32">
    </head><body><meta property="og:title" content="ignored"></body></html>`;
    expect(parseWebMeta(html, "https://arxiv.org/abs/2407.08608")).toEqual({
      title: "FlashAttention-3: Fast & Accurate",
      desc: "We develop three … techniques",
      site: "arXiv",
      image: "https://arxiv.org/static/og.png",
      icon: "https://arxiv.org/favicon-32.png",
    });
  });
  it("falls back to <title>, meta description and /favicon.ico", () => {
    const m = parseWebMeta(
      `<head><TITLE>\n  Triton  Language\nReference </TITLE><meta name="Description" content="Docs"></head>`,
      "https://triton-lang.org/main/index.html",
    );
    expect(m).toEqual({
      title: "Triton Language Reference",
      desc: "Docs",
      site: undefined,
      image: undefined,
      icon: "https://triton-lang.org/favicon.ico",
    });
  });
  it("honours <base> and twitter tags, drops non-http images", () => {
    const m = parseWebMeta(
      `<head><base href="https://cdn.x.io/a/"><meta name="twitter:title" content="T"><meta name="twitter:image" content="img.jpg"><link rel="shortcut icon" href="data:image/png;base64,AA"></head>`,
      "https://x.io/p",
    );
    expect(m.title).toBe("T");
    expect(m.image).toBe("https://cdn.x.io/a/img.jpg");
    expect(m.icon).toBe("https://x.io/favicon.ico");
  });
  it("decodes every named entity", () => {
    const m = parseWebMeta(
      `<head><title>Caf&eacute; &copy; 2024 &mdash; &#x4e2d; &unknown;</title><meta name="description" content="&lt;b&gt; &hearts;"></head>`,
      "https://a.com/",
    );
    expect(m.title).toBe("Café © 2024 — 中 &unknown;");
    expect(m.desc).toBe("<b> ♥");
  });
  it("ignores tags inside comments and scripts, and > inside attribute values", () => {
    const m = parseWebMeta(
      `<head>
      <!-- <meta property="og:title" content="commented out"> -->
      <script>document.write('<meta property="og:description" content="from a script">')</script>
      <meta property="og:title" content="a > b"><meta name="description" content="real">
    </head>`,
      "https://a.com/",
    );
    expect(m.title).toBe("a > b");
    expect(m.desc).toBe("real");
  });
  it("stops at </head> or <body>", () => {
    expect(
      parseWebMeta(`<head><title>T</title></head><meta name="description" content="after head">`, "https://a.com/")
        .desc,
    ).toBeUndefined();
    expect(
      parseWebMeta(`<title>T</title><body><meta name="description" content="in body">`, "https://a.com/").desc,
    ).toBeUndefined();
  });
});

describe("charsetOf", () => {
  it("takes the response header first, then <meta charset> or http-equiv", () => {
    expect(charsetOf("text/html; charset=GBK", `<meta charset="utf-8">`)).toBe("gbk");
    expect(charsetOf(null, `<meta charset="Shift_JIS">`)).toBe("shift_jis");
    expect(charsetOf("text/html", `<meta http-equiv="Content-Type" content="text/html; charset=EUC-KR">`)).toBe(
      "euc-kr",
    );
    expect(charsetOf(null, "<title>x</title>")).toBe("utf-8");
  });
});
