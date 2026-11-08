import { describe, expect, it } from "vitest";
import { emptyBoard, SECTION_PAD } from "@codeboard/core";
import { sceneSection } from "../scene";

describe("a Section in the scene", () => {
  it("keeps its own rect beside the frame grown around its cards' estimates, so the shell can grow it around them as drawn", () => {
    const b = emptyBoard("b1", "Test");
    b.sections.push({ id: "g", title: "Group", x: 0, y: 0, w: 100, h: 80 });
    b.cards.push({ id: "n", kind: "note", md: "# One\n\ntext", look: "note" });
    b.place.n = { x: 40, y: 60, w: 380, section: "g" };
    const s = sceneSection(b, b.sections[0]);
    expect(s.own).toEqual({ x: 0, y: 0, w: 100, h: 80 });
    // the frame reaches past the card by core's padding on the right and below
    expect(s.x + s.w).toBe(40 + 380 + SECTION_PAD.r);
    expect(s.h).toBeGreaterThan(80);
    expect(s.count).toBe(1);
  });
});
