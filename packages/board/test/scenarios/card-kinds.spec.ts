// The consistency matrix: one board with a card of every kind (code, free code, Note, Text, Image, Web, sub-board card) and a
// Section, in Warm Ink and Ink Wash, light and dark. The parts every card has (corners, border, shadow, the header's line and
// fill, the title's font, the selection ring) are read from their computed style, and within one theme every kind must look
// like most kinds do, except the differences in ALLOW, each with why (probes.ts styleHits).
//  cardKindsConsistent — the matrix, and no ALLOW entry left that lets nothing through (unusedAllows)
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import { put, symCard, findSym, OUT } from "../harness";
import { test, check, idle, until, hostBoards } from "../fixtures";
import { styleHits, unusedAllows, type AllowEntry, type KindLook } from "../probes";

/** The card of each kind on the board, by the name the matrix gives it (the first one is what a tie is judged against) */
const KINDS: Record<string, string> = {
  code: "kCode",
  free: "kFree",
  note: "kNote",
  text: "kText",
  image: "kImage",
  web: "kWeb",
  board: "kBoard",
};

/**
 * Differences between kinds that are meant: part, kind, the themes it holds in (all when left out), why. A difference not here
 * fails the scenario (one check per theme, part and kind, so tiers.json `known` can name one); an entry that lets nothing
 * through fails it too, so the list says what the board does now.
 */
const ALLOW: AllowEntry[] = [
  // #158: Warm Ink draws a code card's header line only while its code is scrolled (.hdl); the other kinds keep theirs
  { part: "headLine", kind: "note", in: "warm-ink", why: "Notes keep their header line: Linda 11-03" },
  {
    part: "titleFont",
    kind: "note",
    in: "warm-ink",
    why: "a code card's title is a symbol, set in the code font; a Note's title is prose, in the UI font",
  },
  // Text: words on the board (styles.css .card.text), no card around them
  { part: "corners", kind: "text", why: "a Text card's dashed selection frame has small corners of its own" },
  { part: "selRing", kind: "text", why: "a Text card shows its selection as a dashed frame, not the card ring" },
  { part: "paper", kind: "text", in: "ink-wash", why: "a Text card has no paper: the board shows through" },
  { part: "fill", kind: "text", why: "a Text card has no fill: the board shows through" },
  { part: "ring", kind: "text", in: "warm-ink", why: "a Text card has no card edge" },
  { part: "shadow", kind: "text", in: "warm-ink", why: "a Text card casts no card shadow" },
  // Image: without a background it is the picture on the board (.card.nobg): no fill, edge or shadow
  { part: "fill", kind: "image", why: "an Image card without a background is the picture on the board (.nobg)" },
  { part: "ring", kind: "image", in: "warm-ink", why: "an Image card without a background has no edge (.nobg)" },
  {
    part: "shadow",
    kind: "image",
    in: "warm-ink",
    why: "an Image card without a background casts no card shadow (.nobg)",
  },
  { part: "paper", kind: "image", in: "ink-wash", why: "an Image card without a background has no paper (.nobg)" },
  // a sub-board card is a frame holding a preview of the board (BoardBody.tsx), its name outside
  {
    part: "corners",
    kind: "board",
    why: "a sub-board card is a frame: its corners are 1.76 times a card's (styles.css .card.board)",
  },
  { part: "ring", kind: "board", why: "a sub-board card's frame has a hairline around it (styles.css .card.board)" },
  // a Section is a frame around cards, its title a label above it
  {
    part: "corners",
    kind: "section",
    in: "warm-ink",
    why: "a Section frame's corners are a card's plus 1px, around them",
  },
  { part: "titleFont", kind: "section", why: "a Section's title is a label over the frame, in the theme's label font" },
  {
    part: "titleColor",
    kind: "section",
    in: "warm-ink",
    why: "a Section's title label is muted, the cards' titles are ink",
  },
];

function board(): { M: Board; Sub: Board } {
  const M = emptyBoard("bKinds", "card kinds");
  const s = findSym("Scheduler.schedule");
  const code = symCard(s.f, s.s);
  code.id = KINDS.code;
  put(M, code, 40, 40, 460);
  const free: CodeCard = {
    id: KINDS.free,
    kind: "code",
    title: "free code",
    segments: [
      {
        id: "sFree",
        src: { kind: "free" },
        path: "",
        lang: "python",
        start: 1,
        end: 3,
        text: ["def add(a, b):", "    s = a + b", "    return s"],
        version: { kind: "none" },
      },
    ],
  };
  put(M, free, 540, 40, 360);
  put(
    M,
    { id: KINDS.note, kind: "note", look: "note", title: "A Note", md: "Words in a Note." } as NoteCard,
    940,
    40,
    300,
  );
  put(M, { id: KINDS.text, kind: "note", look: "text", md: "Words on the board" } as NoteCard, 940, 260, 300);
  const img = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#6091cd"/></svg>')}`;
  put(M, { id: KINDS.image, kind: "image", src: img, alt: "a picture", title: "An image" } as never, 40, 560, 300);
  put(
    M,
    {
      id: KINDS.web,
      kind: "web",
      url: "https://example.com/page",
      meta: { title: "A page", desc: "What the page says.", site: "example.com", at: 1 },
    } as never,
    380,
    560,
    320,
  );
  put(M, { id: KINDS.board, kind: "board", board: "bSub" } as never, 740, 600, 320);
  M.place[KINDS.board].h = 220; // a frame has no size of its own
  M.sections.push({ id: "sec", title: "A Section", x: 1280, y: 40, w: 360, h: 300 });
  M.cam = { x: 0, y: 0, z: 0.9 };
  const Sub = emptyBoard("bSub", "a sub-board");
  Sub.cards.push({ id: "subN", kind: "note", look: "note", md: "## inside\nwords" } as NoteCard);
  Sub.place.subN = { x: 40, y: 40, w: 260 };
  return { M, Sub };
}

/** Runs in the page: the shared parts of each card in KINDS, and the Section's corners and title */
function readParts(kinds: Record<string, string>) {
  const cs = (e: Element | null, pseudo?: string) => (e ? getComputedStyle(e, pseudo) : null);
  const none = (w: string, st: string, c: string) =>
    !parseFloat(w) || st === "none" || st === "hidden" || /^(transparent|rgba\([^)]*, 0\))$/.test(c);
  const line = (s: CSSStyleDeclaration | null, side: "Top" | "Bottom") => {
    if (!s) return null;
    const w = s[`border${side}Width`],
      st = s[`border${side}Style`],
      c = s[`border${side}Color`];
    return none(w, st, c) ? "none" : `${w} ${st} ${c}`;
  };
  // a shadow's layers that draw nothing (fully transparent) left out: "none" and "transparent 0 0 0 0" look the same
  const shadow = (s: CSSStyleDeclaration | null) => {
    const layers = (s?.boxShadow ?? "none").split(/,(?![^(]*\))/).map((l) => l.trim());
    const seen = layers.filter((l) => l !== "none" && !/^(transparent|rgba\([^)]*, 0\))\s/.test(l));
    return seen.length ? seen.join(", ") : "none";
  };
  // the font used: the first family of the stack (all of them are bundled with the board), its size and weight
  const font = (s: CSSStyleDeclaration | null) =>
    s ? `${s.fontFamily.split(",")[0].trim()} ${s.fontSize} ${s.fontWeight}` : null;
  const out: { kind: string; parts: Record<string, string | null> }[] = [];
  for (const [kind, id] of Object.entries(kinds)) {
    const card = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
    if (!card) {
      out.push({ kind, parts: { missing: "missing" } });
      continue;
    }
    const s = cs(card)!;
    const head = card.querySelector(":scope > .cface > .chead");
    const title = head?.querySelector(".ctitle") ?? null;
    const before = cs(card, "::before")!,
      after = cs(card, "::after")!;
    out.push({
      kind,
      parts: {
        corners: `${s.borderTopLeftRadius} ${s.getPropertyValue("corner-top-left-shape") || s.getPropertyValue("corner-shape")}`,
        border: line(s, "Top"),
        // the card's edge and its soft shadow are drawn by ::after and ::before (styles.css --sh-ring / --sh-soft); Ink Wash's
        // paper is ::before's border image
        ring: shadow(after),
        shadow: shadow(before),
        paper: before.borderImageSource !== "none" ? "paper" : "none",
        fill:
          /rgba\([^)]*, 0\)|transparent/.test(s.backgroundColor) && before.borderImageSource === "none"
            ? "none"
            : "filled",
        headLine: head ? line(cs(head), "Bottom") : null,
        headFill: head ? cs(head)!.backgroundColor : null,
        titleFont: title ? font(cs(title)) : null,
        titleColor: title ? cs(title)!.color : null,
      },
    });
  }
  const sect = document.querySelector<HTMLElement>('.sect[data-sect="sec"]');
  const sname = document.querySelector('.slabel[data-sect="sec"] .sname');
  if (sect) {
    const s = cs(sect)!;
    out.push({
      kind: "section",
      parts: {
        corners: `${s.borderTopLeftRadius} ${s.getPropertyValue("corner-top-left-shape") || s.getPropertyValue("corner-shape")}`,
        titleFont: font(cs(sname)),
        titleColor: sname ? cs(sname)!.color : null,
      },
    });
  }
  return out;
}

/** Runs in the page with every card selected: each card's selection ring (Warm Ink: .cface::before) and its edge (::after) */
function readSelection(kinds: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [kind, id] of Object.entries(kinds)) {
    const card = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
    if (!card) continue;
    const f = card.querySelector(":scope > .cface");
    const ring = f ? getComputedStyle(f, "::before") : null;
    const on = ring && ring.content !== "none" && +ring.opacity > 0.5 ? ring.boxShadow : "none";
    const edge = getComputedStyle(card, "::after").boxShadow;
    out[kind] = `${on} | ${edge} | ${getComputedStyle(card).outlineStyle}`;
  }
  return out;
}

test("cardKindsConsistent", async () => {
  const judged: { theme: string; looks: KindLook[] }[] = [];
  const table: Record<string, unknown> = {};
  for (const theme of ["warm-ink", "ink-wash"])
    for (const light of [true, false]) {
      const { M, Sub } = board();
      const run = await hostBoards([M, Sub], { page: { light, w: 1700, h: 1000, settings: { theme } as never } });
      const h = await run.open(M.id),
        page = h.page;
      await until(h, "every kind of card is drawn", () =>
        page.evaluate(
          (ids) => ids.every((id) => document.querySelector(`.card[data-id="${id}"]`)),
          Object.values(KINDS),
        ),
      );
      await idle(h);
      const looks: KindLook[] = await page.evaluate(readParts, KINDS);
      await page.keyboard.press("ControlOrMeta+a");
      await until(h, "every card is selected", () =>
        page.evaluate((n) => document.querySelectorAll(".card.sel").length >= n, Object.keys(KINDS).length),
      );
      await idle(h);
      const sel = await page.evaluate(readSelection, KINDS);
      for (const l of looks) l.parts.selRing = sel[l.kind] ?? null;
      const name = `${theme} ${light ? "light" : "dark"}`;
      await page.screenshot({ path: path.join(OUT, `card-kinds-${theme}-${light ? "light" : "dark"}.png`) });
      if (process.env.CARD_KINDS_SHOTS) {
        await page.keyboard.press("Escape");
        await page.locator(`.card[data-id="${KINDS.image}"]`).click();
        await idle(h);
        await page.screenshot({ path: path.join(OUT, `card-kinds-image-${theme}-${light ? "light" : "dark"}.png`) });
      }
      judged.push({ theme: name, looks });
      table[name] = looks;
      const hits = styleHits(name, looks, ALLOW);
      for (const k of hits)
        check(
          `cardKindsConsistent ${name} ${k.part} ${k.kind}`,
          false,
          `looks unlike the other kinds (${k.others.join(", ")})`,
          {
            value: k.value,
            most: k.most,
          },
        );
      if (!hits.length) check(`cardKindsConsistent ${name}: every kind shares the others' look, but for ALLOW`, true);
      await page.context().close();
    }
  fs.writeFileSync(path.join(OUT, "card-kinds.json"), JSON.stringify(table, null, 1));
  const stale = unusedAllows(judged, ALLOW);
  check("cardKindsConsistent every ALLOW entry still lets a difference through", !stale.length, stale);
});
