// Card links (Copy Link): read back from what the host writes and from Markdown's ways of writing an address
import { describe, expect, it } from "vitest";
import { cardLink, parseCardLink } from "../src/cardlink";

describe("card links", () => {
  it("names the board and the item of the host's paths", () => {
    expect(parseCardLink(cardLink(".codeboard/bA.json", "c1"))).toEqual({ board: "bA", item: "c1" });
    expect(parseCardLink(cardLink(".codeboard/group/bA.json"))).toEqual({ board: "bA" });
    expect(parseCardLink(".codeboard/cards/sh.json#sh")).toEqual({ item: "sh" });
    expect(parseCardLink("/home/u/.config/Code/boards/bA.json#s-1")).toEqual({ board: "bA", item: "s-1" });
    expect(parseCardLink("C:\\Users\\u\\boards\\bA.json#c1")).toEqual({ board: "bA", item: "c1" });
  });
  it("reads an address written in angle brackets or %-encoded", () => {
    expect(parseCardLink("</home/u/My Boards/bA.json#c1>")).toEqual({ board: "bA", item: "c1" });
    expect(parseCardLink("/home/u/My%20Boards/bA.json#c1")).toEqual({ board: "bA", item: "c1" });
  });
  it("is null for anything else", () => {
    for (const s of [
      "https://example.com/bA.json#c1",
      "file:///x/bA.json#c1",
      "docs/notes.md",
      "bA.json#not an id",
      ".codeboard/cards/sh.json#other",
      "%E0%A4%A",
      "",
    ])
      expect(parseCardLink(s), s).toBe(null);
  });
});
