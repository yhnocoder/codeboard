import { describe, it, expect } from "vitest";
import { urlPath, classifyPaste, parseRepoInput } from "../src";

describe("urlPath", () => {
  it("is the path, query and hash, empty for the root", () => {
    expect(urlPath("https://docs.internal.company/wiki/kv-cache-design?tab=notes")).toBe("/wiki/kv-cache-design?tab=notes");
    expect(urlPath("https://a.com/")).toBe("");
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
  it("a whole SVG document becomes an image; SVG inside other text stays text", () => {
    expect(classifyPaste(`<?xml version="1.0"?>\n<!-- Figma -->\n<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24"/></svg>\n`).kind).toBe("svg");
    expect(classifyPaste(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"/>`).kind).toBe("svg");
    expect(classifyPaste(`const icon = <svg viewBox="0 0 8 8"><path d="M0 0"/></svg>;`).kind).not.toBe("svg");
    expect(classifyPaste(`<svg viewBox="0 0 8 8">\n  <path d="M0 0"/>`).kind).not.toBe("svg");
    expect(classifyPaste(`<svgfoo></svgfoo>`).kind).not.toBe("svg");
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
