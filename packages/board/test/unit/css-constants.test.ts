// Numbers the board's TypeScript and its stylesheets both use, where neither can read the other's without a cost (a layout read,
// a variable missing on the first paint, an export without it): each pair is kept equal here, reading the stylesheet as text
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyBoard, turnNoteInto, type Board } from "@codeboard/core";
import { CODE_ROW_H, TAB_SIZE } from "../../src/state/measure";
import { PAPER_M, PAPER_SCALE, PAPER_SLICE } from "../../src/state/ink";

const styles = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
const themes = readFileSync(new URL("../../src/themes.css", import.meta.url), "utf8");

/** The declarations of every rule whose whole selector is sel (at the top level or in an at-rule), later ones winning */
function rule(css: string, sel: string): Record<string, string> {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out: Record<string, string> = {};
  let found = false;
  for (const m of css.matchAll(new RegExp(`(?:^|[\\n{}])\\s*${esc}\\s*\\{([^{}]*)\\}`, "g"))) {
    found = true;
    for (const d of m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
      const i = d.indexOf(":");
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
  }
  if (!found) throw new Error(`no rule ${sel}`);
  return out;
}
const px = (v: string | undefined) => {
  const m = /^(-?[\d.]+)px$/.exec(v ?? "");
  if (!m) throw new Error(`not a px length: ${v}`);
  return +m[1];
};

describe("code card geometry", () => {
  it("draws a code line CODE_ROW_H tall: the code's line height, a line number's and a row background's height", () => {
    const lh = /\/\s*([\d.]+)px\b/.exec(rule(styles, ".code").font)?.[1];
    expect(Number(lh)).toBe(CODE_ROW_H);
    expect(px(rule(styles, ".no").height)).toBe(CODE_ROW_H);
    expect(px(rule(styles, ".rowbg").height)).toBe(CODE_ROW_H);
  });

  it("puts tab stops every TAB_SIZE columns, as the code's tab-size does", () => {
    expect(Number(rule(styles, ".src")["tab-size"])).toBe(TAB_SIZE);
  });

  it("draws a Line Selection with a Highlight band's geometry", () => {
    const sel = rule(styles, ".lselb"),
      band = rule(styles, ".hx-band .hxb");
    for (const p of ["left", "right", "border-radius"]) expect(sel[p], p).toBe(band[p]);
  });
});

describe("Ink Wash card paper", () => {
  const paper = rule(themes, ":root.look-ink-wash .card:not(.text):not(.nobg)::before");

  it("reaches PAPER_M outside the card", () => {
    expect(px(paper.inset)).toBe(-PAPER_M);
  });

  it("slices the sheet at PAPER_SLICE, in the PNG's pixels (PAPER_SCALE times) and on screen", () => {
    const m = /var\(--deckle\)\s+([\d.]+)\s+fill\s*\/\s*([\d.]+)px\b/.exec(paper["border-image"]);
    expect(m && [+m[1], +m[2]]).toEqual([PAPER_SLICE * PAPER_SCALE, PAPER_SLICE]);
  });
});

describe("Note ↔ Text keeps the words in place", () => {
  /** Where an untitled Note's place moves when it turns into a Text (core's turnNoteInto) */
  function moved(): { dx: number; dy: number } {
    const b: Board = {
      ...emptyBoard("b", "B"),
      cards: [{ id: "n", kind: "note", md: "words", look: "note" }],
      place: { n: { x: 100, y: 100, w: 280 } },
    };
    turnNoteInto(b, "n", "text");
    return { dx: b.place.n.x - 100, dy: b.place.n.y - 100 };
  }

  it("moves by the Note's padding less the Text's, and under the Note's header", () => {
    const note = rule(styles, ".card.note .nbody").padding.split(/\s+/).map(px),
      text = rule(styles, ".card.text").padding.split(/\s+/).map(px),
      head = px(rule(styles, ".chead").height);
    // padding: top, right / left (Note: top x bottom; Text: y x)
    expect(moved()).toEqual({ dx: note[1] - text[1], dy: head + note[0] - text[0] });
  });
});

describe("narrow window", () => {
  it("moves the Newspaper masthead above the toolbar at the width the toolbar moves left", () => {
    const at = (css: string, sel: string) => {
      const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return Number(new RegExp(`@media \\(max-width: (\\d+)px\\) \\{\\s*${esc} \\{`).exec(css)?.[1]);
    };
    expect(at(themes, ":root.look-newspaper .mast")).toBe(at(styles, ".bbar"));
  });
});
