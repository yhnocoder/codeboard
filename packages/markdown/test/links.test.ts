import { describe, expect, it } from "vitest";
import { hrefSource, linkHref, linkText } from "../src/editor/links";
import type { Refs } from "../src/view";

describe("a link's text written between [ and ]", () => {
  it("keeps brackets that pair up and escapes ones that do not", () => {
    expect(linkText("see [1] here")).toBe("see [1] here");
    expect(linkText("a ] b")).toBe("a \\] b");
    expect(linkText("[draft")).toBe("\\[draft");
    expect(linkText("x] [y")).toBe("x\\] \\[y");
    expect(linkText("kept \\] as is")).toBe("kept \\] as is");
  });
});

describe("the address a link is written with", () => {
  const refs = {
    resolve: () => null,
    link: (h: string) => (/(^|[\\/])[\w-]+\.json(#[\w-]+)?$/.test(h) ? "x" : null),
  } as unknown as Refs;
  it("keeps a link to an item and any path as written", () => {
    expect(linkHref(".codeboard/bmvst.json#cmw1", refs)).toBe(".codeboard/bmvst.json#cmw1");
    expect(linkHref("/home/u/my boards/b1.json#n1", refs)).toBe("/home/u/my boards/b1.json#n1");
    expect(linkHref("b1.json", refs)).toBe("b1.json");
    expect(linkHref("./notes/readme.md", refs)).toBe("./notes/readme.md");
    expect(linkHref("~/x/y", refs)).toBe("~/x/y");
    expect(linkHref("docs/intro", refs)).toBe("docs/intro");
    expect(linkHref("C:\\work\\b1.json#n1", refs)).toBe("C:\\work\\b1.json#n1");
  });
  it("gives a web site written without its scheme https://, and keeps any scheme", () => {
    expect(linkHref("example.com/a?b", refs)).toBe("https://example.com/a?b");
    expect(linkHref("www.example.org", refs)).toBe("https://www.example.org");
    expect(linkHref("docs.rs/tokio", refs)).toBe("https://docs.rs/tokio");
    expect(linkHref("http://example.com", refs)).toBe("http://example.com");
    expect(linkHref("mailto:a@b.c", refs)).toBe("mailto:a@b.c");
    expect(linkHref("  ", refs)).toBe("");
  });
  it("puts an address with spaces or parentheses in <angle brackets>", () => {
    expect(hrefSource("/a b/c.json#n")).toBe("</a b/c.json#n>");
    expect(hrefSource("https://x.org/a")).toBe("https://x.org/a");
  });
});
