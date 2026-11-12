import { describe, expect, it } from "vitest";
import { isAssetName } from "../src/storage/names";

describe("isAssetName", () => {
  it("accepts the names assets are stored under", () => {
    for (const n of [
      "0123456789abcdef.png",
      "0123456789abcdef-640x480.jpg",
      "a.svg",
      "my_image-2.final.webp",
      "-x",
      "x.",
    ])
      expect(isAssetName(n), n).toBe(true);
  });

  it("refuses empty names, path separators, dot names and other characters", () => {
    for (const n of [
      "",
      ".",
      "..",
      ".hidden.png",
      "../board.json",
      "sub/a.png",
      "sub\\a.png",
      "/abs.png",
      "C:a.png",
      "a b.png",
      "图.png",
      "a.png\n",
    ])
      expect(isAssetName(n), JSON.stringify(n)).toBe(false);
  });
});
