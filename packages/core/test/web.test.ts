import { describe, it, expect } from "vitest";
import { parseWebMeta, urlPath, charsetOf, decodeEntities, classifyPaste, parseRepoInput } from "../src";

describe("parseWebMeta", () => {
  it("prefers og tags and resolves relative URLs", () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="FlashAttention-3: Fast &amp; Accurate">
      <meta name="description" content="plain desc"><meta property='og:description' content="We develop three &#8230; techniques">
      <meta property="og:site_name" content="arXiv"><meta property="og:image" content="/static/og.png">
      <link rel="icon" href="/favicon-16.png" sizes="16x16"><link rel="icon" href="/favicon-32.png" sizes="32x32">
    </head><body><meta property="og:title" content="ignored"></body></html>`;
    expect(parseWebMeta(html, "https://arxiv.org/abs/2407.08608")).toEqual({
      title: "FlashAttention-3: Fast & Accurate", desc: "We develop three … techniques", site: "arXiv",
      image: "https://arxiv.org/static/og.png", icon: "https://arxiv.org/favicon-32.png",
    });
  });
  it("falls back to <title>, meta description and /favicon.ico", () => {
    const m = parseWebMeta(`<head><TITLE>\n  Triton  Language\nReference </TITLE><meta name="Description" content="Docs"></head>`, "https://triton-lang.org/main/index.html");
    expect(m).toEqual({ title: "Triton Language Reference", desc: "Docs", site: undefined, image: undefined, icon: "https://triton-lang.org/favicon.ico" });
  });
  it("honours <base> and twitter tags, drops non-http images", () => {
    const m = parseWebMeta(`<head><base href="https://cdn.x.io/a/"><meta name="twitter:title" content="T"><meta name="twitter:image" content="img.jpg"><link rel="shortcut icon" href="data:image/png;base64,AA"></head>`, "https://x.io/p");
    expect(m.title).toBe("T");
    expect(m.image).toBe("https://cdn.x.io/a/img.jpg");
    expect(m.icon).toBe("https://x.io/favicon.ico");
  });
  it("small helpers", () => {
    expect(urlPath("https://docs.internal.company/wiki/kv-cache-design?tab=notes")).toBe("/wiki/kv-cache-design?tab=notes");
    expect(urlPath("https://a.com/")).toBe("");
    expect(charsetOf("text/html; charset=GBK", "")).toBe("gbk");
    expect(charsetOf(null, `<meta charset="Shift_JIS">`)).toBe("shift_jis");
    expect(decodeEntities("a &lt;b&gt; &#x4e2d; &unknown;")).toBe("a <b> 中 &unknown;");
  });
});

describe("paste: links and GitHub", () => {
  it("several URLs → one Link List", () => {
    expect(classifyPaste("https://a.com/x\n  https://b.org/y \n\nhttps://a.com/x")).toEqual({ kind: "links", urls: ["https://a.com/x", "https://b.org/y"] });
    expect(classifyPaste("https://a.com/x\nnot a url").kind).toBe("note");
  });
  it("blob links to code files become GitHub Code cards; docs stay bookmarks", () => {
    expect(classifyPaste("https://github.com/yhnocoder/tongtu/blob/bde7213/CLAUDE.md#L3-L10").kind).toBe("github");
    expect(classifyPaste("https://github.com/a/b/blob/main/src/x.py").kind).toBe("github");
    expect(classifyPaste("https://github.com/a/b/blob/main/README.md").kind).toBe("web");
    expect(classifyPaste("https://github.com/a/b/tree/main/src").kind).toBe("web");
    expect(classifyPaste("https://github.com/a/b").kind).toBe("web");
  });
  it("parses repo input for From GitHub…", () => {
    expect(parseRepoInput("vllm-project/vllm")).toEqual({ owner: "vllm-project", name: "vllm", ref: undefined, path: undefined });
    expect(parseRepoInput("https://github.com/vllm-project/vllm.git")).toMatchObject({ owner: "vllm-project", name: "vllm" });
    expect(parseRepoInput("github.com/a/b/tree/v0.6.0/vllm/attention/")).toEqual({ owner: "a", name: "b", ref: "v0.6.0", path: "vllm/attention" });
    expect(parseRepoInput("https://github.com/a/b/blob/main/x/y.py#L3-L9")).toEqual({ owner: "a", name: "b", ref: "main", path: "x/y.py", start: 3, end: 9 });
    expect(parseRepoInput("git@github.com:a/b.git")).toMatchObject({ owner: "a", name: "b" });
    expect(parseRepoInput("just words")).toBeNull();
  });
});
