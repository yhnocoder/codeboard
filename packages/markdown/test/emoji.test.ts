import { describe, expect, it } from "vitest";
import { gemoji } from "gemoji";
import { GEMOJI } from "../src/emoji-data";

describe("emoji shortcodes", () => {
  it("emoji-data.ts is every gemoji name (run node tools/emoji/gen.mjs after bumping gemoji)", () => {
    expect(GEMOJI).toEqual(Object.fromEntries(gemoji.flatMap((g) => g.names.map((n) => [n, g.emoji]))));
  });
});
