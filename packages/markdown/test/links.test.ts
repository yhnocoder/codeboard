import { describe, expect, it } from "vitest";
import { linkText } from "../src/editor/links";

describe("a link's text written between [ and ]", () => {
  it("keeps brackets that pair up and escapes ones that do not", () => {
    expect(linkText("see [1] here")).toBe("see [1] here");
    expect(linkText("a ] b")).toBe("a \\] b");
    expect(linkText("[draft")).toBe("\\[draft");
    expect(linkText("x] [y")).toBe("x\\] \\[y");
    expect(linkText("kept \\] as is")).toBe("kept \\] as is");
  });
});
