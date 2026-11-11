// A copy of a card's element (an export, a card's preview) takes off the classes in CARD_STATE_CLASSES: every class the board gives
// a card's element is either listed there or one of what the card is (LOOK)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CARD_STATE_CLASSES } from "../../src/cardsel";

/** Classes from what the card is, which a copy keeps */
const LOOK = ["locked", "autoh", "nobg", "lost", "gen"];

const card = readFileSync(new URL("../../src/cards/Card.tsx", import.meta.url), "utf8");

/** The keys of the card element's classList (the first classList after class="card"); a computed key is the card's kind */
function classListKeys(): string[] {
  const start = card.indexOf("classList={{", card.indexOf('class="card"'));
  const body = card.slice(start, card.indexOf("}}", start));
  return [...body.matchAll(/^\s*(?:"([\w-]+)"|([\w-]+)):/gm)].map((m) => m[1] ?? m[2]);
}
/** Classes Card.tsx adds by hand (the ping) */
const added = (text: string) => [...text.matchAll(/classList\.add\("([\w-]+)"\)/g)].map((m) => m[1]);

describe("card state classes", () => {
  const given = [...classListKeys(), ...added(card)];

  it("covers every class the board gives a card's element, or keeps it as part of the card's look", () => {
    expect(given.length).toBeGreaterThan(20);
    expect(given.filter((c) => !CARD_STATE_CLASSES.includes(c) && !LOOK.includes(c))).toEqual([]);
  });

  it("lists only classes the board gives a card's element", () => {
    expect(CARD_STATE_CLASSES.filter((c) => !given.includes(c))).toEqual([]);
  });
});
