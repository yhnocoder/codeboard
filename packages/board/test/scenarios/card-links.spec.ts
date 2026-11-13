// Links to cards (Copy Link, core cardlink.ts), put on words in a Note:
//  cardLinkCopyAndPaste      on the real host: a card's Copy Link, words in a Note selected by a drag and the link pasted on
//                            them, the Note left: the words stay as written and read as a link; the card in view, a click
//                            on the link selects it (no preview)
//  cardLinkClicks            at rest a link to a card far from the view previews it as a [[reference]] does (resting on it
//                            shows nothing), to a Section selects the Section, to a board opens it; one whose item is gone
//                            looks as a broken reference and a click on it does nothing; a web address still opens in the
//                            browser
//  cardLinkWhileEditing      in the editor a click on a link to a card previews it and the caret stays; a link to a Section
//                            opens its link box, whose Open goes there
//  cardLinkPaste             in the editor a link pasted on selected words links them (spaces in the address in <brackets>,
//                            web addresses too); a link to a card pasted on nothing is a [[reference]] to it
//  cardLinkThroughLinkBox    words selected by a drag, the toolbar's Link, a copied card link pasted in the address field and
//                            ↵: the address is written as copied (no https:// before it), and a click on the link previews
//                            the card, with nothing sent to open in the browser
//  refOtherBoardPreview      on the real host: a [[reference]] to a card on another board, and a link to it, preview the card
//                            (drawn from what the host sends, with its file, line and version) without opening that board, at
//                            rest and while editing, nothing flashing as it comes; the preview's arrow opens that board at the card
//  refSubBoardPreview        a [[reference]] to a card inside a sub-board previews it without entering; the arrow enters
//  refDoubleClickSource      on the real host: a double-click on a [[reference]] (another board's, drawn with its seal; one in a
//                            sub-board; a far one) at rest opens its source in the editor, the caret after [[, opening nothing;
//                            while the Note is edited the same
//  refFastClicks             four fast clicks on such a reference open its source and nothing else (no board opened or entered,
//                            no card added); three fast clicks on the preview's arrow go to the card once
//  refNearDoubleClickSource  at rest a double-click on a reference to a card near the view opens its source with the camera
//                            where it was (one click goes there once the double-click window is over)
//  refNearFastClicks         four fast clicks on a reference to a card near the view open its source: the camera stays and no
//                            click lands on the board's empty space (whose double-click adds a card)
//  refWhileEditorLoads       a click on a reference in the text a Note shows while its editor's code loads opens nothing
//  noteLinkTip               resting on a link in a Note shows its whole address (a long one drawn as its site too) as the
//                            board's tips do, after the tip delay, nothing flashing; leaving it or the wheel hides it; a link to a
//                            card shows none
//  refListLikePalette        the Note editor's [[ list marks its highlighted row as ⌘K's list does (a band, the accent's bar,
//                            the words as they are), with the pointer on that row too, in Warm Ink light and Ink Wash dark
import * as fs from "node:fs";
import type { Page } from "@playwright/test";
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import { put, shot, symCard, findSym, type Host } from "../harness";
import { PEEK_DELAY, TIP_DELAY } from "../../src/state/timing";
import { test, open, check, light, until, idle, hold, focusSettled, hostBoards } from "../fixtures";
import { watch } from "../watch";

const NOTE = [
  "# Card links",
  "",
  "The [step loop](.codeboard/b1.json#k1) asks the [manager](<.codeboard/my boards/b1.json#nc>) for blocks.",
  "",
  "- [the prefill group](.codeboard/b1.json#g1)",
  "- [kernels board](.codeboard/bk.json)",
  "- [gone card](.codeboard/b1.json#nothere)",
  "- [the site](https://example.com/nano)",
  "",
  "last line here, end",
].join("\n");
const CODE = Array.from({ length: 24 }, (_, i) =>
  i % 4 === 0 ? `def step_${i}(seq):` : `    total += seq.len * ${i}`,
);

function board(): Board {
  const b = emptyBoard("b1", "links");
  const seg = {
    id: "s1",
    src: { kind: "free" },
    path: "",
    lang: "python",
    start: 1,
    end: CODE.length,
    text: CODE.slice(),
    version: { kind: "none" },
  };
  put(b, { id: "k1", kind: "code", title: "schedule", segments: [seg] } as unknown as CodeCard, 3000, 60, 460);
  put(
    b,
    { id: "nc", kind: "note", look: "note", md: "## Block Manager\n\nHands out KV cache blocks." } as NoteCard,
    3000,
    640,
    320,
  );
  put(b, { id: "n0", kind: "note", look: "note", md: NOTE } as NoteCard, 40, 60, 520);
  b.sections.push({ id: "g1", title: "Prefill stage", x: 1150, y: 40, w: 300, h: 260 });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
async function openLinks(): Promise<Host> {
  const h = await open({ board: board(), light, w: 1300, h: 860 });
  await h.post({
    type: "boards",
    boards: [
      { id: "b1", name: "links", cards: 3 },
      { id: "bk", name: "Kernels", cards: 3 },
    ],
  });
  await idle(h);
  return h;
}

const nv = (qual: string) => {
  const s = findSym(qual);
  return symCard(s.f, s.s);
};

const N = '.card[data-id="n0"]';
const link = (pg: Page, text: string, editing = false) =>
  pg.locator(`${N} ${editing ? ".md-pm" : ".nbody"} a.md-link`, { hasText: text }).first();
const peeks = (pg: Page) => pg.locator(".cpeek").count();
const caret = (pg: Page) =>
  pg
    .locator(".md-pm")
    .evaluate(
      (e) => (e as unknown as { editor: { state: { selection: { from: number } } } }).editor.state.selection.from,
    );
const source = (pg: Page) =>
  pg.locator(".md-pm").evaluate((e) =>
    (
      e as unknown as {
        editor: {
          state: { doc: { textBetween(a: number, b: number, s: string): string; content: { size: number } } };
        };
      }
    ).editor.state.doc.textBetween(
      0,
      (e as unknown as { editor: { state: { doc: { content: { size: number } } } } }).editor.state.doc.content.size,
      "\n",
    ),
  );
/** Double-click the Note's last line: editing, the caret at its end */
async function edit(h: Host) {
  const pg = h.page;
  const b = (await pg.locator(`${N} .nbody p`).last().boundingBox())!;
  await pg.mouse.dblclick(b.x + b.width - 4, b.y + b.height / 2);
  await pg.locator(".md-pm:focus").waitFor();
  await focusSettled(pg);
  await idle(h);
}
/** A paste of text as the page gets it from the clipboard */
const paste = (pg: Page, text: string) =>
  pg.locator(".md-pm").evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
/** Drag over the word w as shown in the editor: the press at its first letter, the release after its last */
async function dragOver(pg: Page, w: string) {
  const r = await pg.locator(".md-pm").evaluate((root, w) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.textContent!.indexOf(w);
      if (i < 0) continue;
      const a = document.createRange(),
        b = document.createRange();
      a.setStart(n, i);
      a.setEnd(n, i + 1);
      b.setStart(n, i + w.length - 1);
      b.setEnd(n, i + w.length);
      const ra = a.getBoundingClientRect(),
        rb = b.getBoundingClientRect();
      // a link's hidden address may hold the word too
      if (!ra.width) continue;
      return { x0: ra.left + 1, x1: rb.right - 1, y: (ra.top + ra.bottom) / 2 };
    }
    return null;
  }, w);
  if (!r) throw new Error(`no "${w}" in the editor`);
  await pg.mouse.move(r.x0, r.y, { steps: 4 });
  await pg.mouse.down();
  await pg.mouse.move(r.x1, r.y, { steps: 8 });
  await pg.mouse.up();
}

test("cardLinkCopyAndPaste", async () => {
  const B = emptyBoard("bLink", "Engine");
  const step = nv("LLMEngine.step");
  put(B, step, 520, 120);
  B.cards.push({ id: "nL", kind: "note", md: "## Reading\n\nThe engine loop runs each step.", look: "note" });
  B.place.nL = { x: 80, y: 120, w: 320 };
  const run = await hostBoards([B], { page: { light, w: 1300, h: 820 } });
  const copied: string[] = [];
  run.ws.ui.copy = async (text) => void copied.push(text);
  const h = await run.open("bLink");
  const pg = h.page;
  await pg.locator(`.card[data-id="${step.id}"] .chead`).click({ button: "right", position: { x: 200, y: 12 } });
  await pg.locator(".ctx:not(.closing) button", { hasText: /^Copy Link$/ }).click();
  const copy = await until(h, "Copy Link copies the card's link", () => copied[0]);
  const toast = await pg.locator(".toast").last().innerText();
  // the Note: editing, "loop" selected by a drag, the link pasted on it
  const NL = '.card[data-id="nL"]';
  const last = (await pg.locator(`${NL} .nbody p`).last().boundingBox())!;
  await pg.mouse.dblclick(last.x + last.width - 4, last.y + last.height / 2);
  await pg.locator(".md-pm:focus").waitFor();
  await focusSettled(pg);
  await dragOver(pg, "loop");
  await until(h, "the drag selects the word", async () => pg.evaluate(() => getSelection()?.toString() === "loop"));
  await paste(pg, copy);
  const written = await source(pg);
  await pg.keyboard.press("Escape");
  await pg.locator(`${NL} .nbody a.md-cardlink`).waitFor();
  await idle(h);
  const a = pg.locator(`${NL} .nbody a.md-cardlink`);
  const shown = { text: await a.innerText(), missing: await a.evaluate((e) => e.classList.contains("missing")) };
  await a.click();
  await pg.locator(`.card.sel[data-id="${step.id}"]`).waitFor();
  await idle(h);
  await shot(h, "card-link-near");
  const near = await peeks(pg);
  const file = run.host.store.fileOf("bLink")!;
  check(
    "cardLinkCopyAndPaste Copy Link copies the card's link; pasted on selected words it links them to the card",
    copy === `${file}#${step.id}` &&
      toast.includes("Copied link") &&
      written.includes(`The engine [loop](${/\s/.test(copy) ? `<${copy}>` : copy}) runs each step.`) &&
      fs.existsSync(file),
    { copy, toast, written },
  );
  check(
    "cardLinkCopyAndPaste the link keeps its words; the card in view, a click on it selects the card",
    shown.text === "loop" && !shown.missing && near === 0,
    { shown, near },
  );
});

test("cardLinkClicks", async () => {
  const h = await openLinks();
  const pg = h.page;
  const looks = await pg
    .locator(`${N} .nbody a.md-link`)
    .evaluateAll((as) =>
      as.map(
        (a) =>
          `${a.textContent}:${a.classList.contains("md-cardlink") ? "card" : "web"}${a.classList.contains("missing") ? ":missing" : ""}`,
      ),
    );
  await link(pg, "step loop").hover();
  await hold(h, PEEK_DELAY * 2, "resting on a link to a card must not preview it");
  const onHover = await peeks(pg);
  await link(pg, "step loop").click();
  await pg.locator(".cpeek.show").waitFor();
  const shown = (await pg.locator(".cpeek").textContent()) ?? "";
  await link(pg, "manager").click();
  await until(h, "a click on another link previews its card instead", async () =>
    ((await pg.locator(".cpeek.show").textContent()) ?? "").includes("Hands out KV cache blocks"),
  );
  await pg.keyboard.press("Escape");
  await until(h, "Esc closes the preview", async () => (await peeks(pg)) === 0);
  let n = h.sent.length;
  await link(pg, "kernels board").click();
  await until(h, "a link to a board opens it", () =>
    h.sent.slice(n).some((m) => m.type === "openBoard" && (m as { id?: string }).id === "bk"),
  );
  const gone = link(pg, "gone card");
  const goneLook = await gone.evaluate((e) => ({ cursor: getComputedStyle(e).cursor, tip: e.getAttribute("title") }));
  n = h.sent.length;
  await gone.click();
  await hold(h, 300, "a click on a link whose card is gone must do nothing");
  const goneDid = {
    peeks: await peeks(pg),
    sent: h.sent
      .slice(n)
      .filter((m) => m.type !== "log")
      .map((m) => m.type),
  };
  n = h.sent.length;
  await link(pg, "the site").click();
  await until(h, "a web address opens in the browser", () => h.sent.slice(n).some((m) => m.type === "openLink"));
  // last: the camera goes to the Section
  await link(pg, "the prefill group").click();
  await pg.locator('.sect.sel[data-sect="g1"]').waitFor();
  const sectionPeek = await peeks(pg);
  check(
    "cardLinkClicks links to cards read as links with their own words; a broken one as a broken reference",
    JSON.stringify(looks) ===
      JSON.stringify([
        "step loop:card",
        "manager:card",
        "the prefill group:card",
        "kernels board:card",
        "gone card:card:missing",
        "the site:web",
      ]),
    looks,
  );
  check(
    "cardLinkClicks a click on a link to a card previews it; to a Section or a board goes there; a broken one does nothing",
    onHover === 0 &&
      shown.includes("def step_0") &&
      sectionPeek === 0 &&
      goneLook.cursor === "default" &&
      !!goneLook.tip &&
      goneDid.peeks === 0 &&
      !goneDid.sent.some((t) => t === "openLink" || t === "openBoard"),
    { onHover, shown: shown.slice(0, 60), sectionPeek, goneLook, goneDid },
  );
  await h.close();
});

test("cardLinkWhileEditing", async () => {
  const h = await openLinks();
  const pg = h.page;
  await edit(h);
  const before = await caret(pg);
  const looks = await pg
    .locator(`${N} .md-pm a.md-link`)
    .evaluateAll((as) =>
      as.map(
        (a) =>
          `${a.classList.contains("md-cardlink") ? "card" : "web"}${a.classList.contains("missing") ? ":missing" : ""}`,
      ),
    );
  await link(pg, "step loop", true).click();
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  await shot(h, "card-link-preview-editing");
  const opened = {
    caret: await caret(pg),
    focused: await pg.locator(".md-pm:focus").count(),
    text: ((await pg.locator(".cpeek").textContent()) ?? "").slice(0, 40),
    drawn: await pg.locator(`${N} .md-pm p`).first().innerText(),
  };
  await pg.keyboard.press("Escape");
  await until(h, "Esc closes the preview", async () => (await peeks(pg)) === 0);
  const editing = await pg.locator(".md-pm:focus").count();
  // a Section: its link box, whose Open goes there
  await link(pg, "the prefill group", true).click();
  await pg.locator(".md-bubble .md-linkbox").waitFor({ timeout: 5000 });
  const box = await pg
    .locator(".md-bubble .md-linkbox input")
    .evaluateAll((is) => is.map((i) => (i as HTMLInputElement).value));
  await pg.locator(".md-bubble .md-linkbtn", { hasText: "Open" }).click();
  await pg.locator('.sect.sel[data-sect="g1"]').waitFor();
  check(
    "cardLinkWhileEditing a click on a link to a card previews it and the caret stays",
    JSON.stringify(looks) === JSON.stringify(["card", "card", "card", "card", "card:missing", "web"]) &&
      opened.caret === before &&
      opened.focused === 1 &&
      opened.text.includes("schedule") &&
      !opened.drawn.includes("](") &&
      editing === 1,
    { looks, before, opened, editing },
  );
  check(
    "cardLinkWhileEditing a link to a Section opens its box; Open goes to the Section",
    box[0] === "the prefill group" && box[1] === ".codeboard/b1.json#g1",
    box,
  );
  await h.close();
});

test("cardLinkPaste", async () => {
  const h = await openLinks();
  const pg = h.page;
  await edit(h);
  const lastLine = () =>
    pg
      .locator(".md-pm")
      .evaluate(
        (e) =>
          (e as unknown as { editor: { state: { doc: { lastChild: { textContent: string } } } } }).editor.state.doc
            .lastChild.textContent,
      );
  // on selected words: a link; an address with spaces in <brackets>; a web address the same way
  await dragOver(pg, "here");
  await paste(pg, "/home/u/my boards/b1.json#nc");
  const spaced = await lastLine();
  await dragOver(pg, "line");
  await paste(pg, "https://example.com/x");
  const web = await lastLine();
  // on nothing: a reference to the card
  await pg.keyboard.press("End");
  await paste(pg, ".codeboard/b1.json#k1");
  const bare = await lastLine();
  await pg.keyboard.press("Escape");
  await pg.locator(`${N} .nbody p`).last().locator("a.md-cardlink").waitFor();
  const drawn = await pg
    .locator(`${N} .nbody p`)
    .last()
    .evaluate((p) =>
      [...p.querySelectorAll(".md-ref, a.md-link")].map(
        (a) =>
          `${a.textContent}:${a.classList.contains("md-cardlink") ? "card" : a.classList.contains("md-ref") ? "ref" : "web"}`,
      ),
    );
  check(
    "cardLinkPaste a card's link pasted on nothing is a reference to it; pasted on words it links them",
    spaced === "last line [here](</home/u/my boards/b1.json#nc>), end" &&
      web === "last [line](https://example.com/x) [here](</home/u/my boards/b1.json#nc>), end" &&
      bare === `${web}[[schedule#^k1]] ` &&
      JSON.stringify(drawn) === JSON.stringify(["line:web", "here:card", "schedule:ref"]),
    { bare, spaced, web, drawn },
  );
  await h.close();
});

test("cardLinkThroughLinkBox", async () => {
  const h = await openLinks();
  const pg = h.page;
  await edit(h);
  await dragOver(pg, "here");
  await until(h, "the drag selects the word", async () => pg.evaluate(() => getSelection()?.toString() === "here"));
  await pg.locator('.md-bubble button[data-tip="Link"]').click();
  const field = pg.locator(".md-bubble .md-linkin");
  await field.waitFor();
  // what Copy Link put on the clipboard, pasted into the address field
  await pg.keyboard.insertText(".codeboard/b1.json#k1");
  await pg.keyboard.press("Enter");
  await until(h, "the box closes", async () => (await pg.locator(".md-bubble .md-linkin").count()) === 0);
  const written = await source(pg);
  await pg.keyboard.press("Escape");
  await until(h, "the Note is saved", () =>
    (h.board().cards.find((c) => c.id === "n0") as NoteCard).md.includes("[here]("),
  );
  const md = (h.board().cards.find((c) => c.id === "n0") as NoteCard).md;
  const n = h.sent.length;
  const a = link(pg, "here");
  await a.click();
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  const peek = (await pg.locator(".cpeek").textContent()) ?? "";
  const opened = h.sent.slice(n).filter((m) => m.type === "openLink").length;
  check(
    "cardLinkThroughLinkBox a card link given in the link box is written as copied and previews its card",
    written.includes("last line [here](.codeboard/b1.json#k1), end") &&
      md.includes("[here](.codeboard/b1.json#k1)") &&
      !md.includes("https://.codeboard") &&
      (await a.evaluate((e) => e.classList.contains("md-cardlink") && !e.classList.contains("missing"))) &&
      peek.includes("def step_0") &&
      opened === 0,
    { written, md, peek: peek.slice(0, 60), opened },
  );
  await h.close();
});

/** Engine (bA) with a Note referring to a card on Kernels (bK) and to one inside its sub-board Sub (bS), shown in a frame */
async function elsewhere(theme?: string, scale?: number) {
  const step = nv("LLMEngine.step");
  const K = emptyBoard("bK", "Kernels");
  put(K, step, 60, 60);
  const S = emptyBoard("bS", "Sub");
  put(
    S,
    { id: "nS", kind: "note", look: "note", md: "## Inner\n\nDeep inside the sub-board." } as NoteCard,
    60,
    60,
    320,
  );
  const A = emptyBoard("bA", "Engine");
  const md = [
    "## Reading",
    "",
    `The step is [[Kernels › LLMEngine.step#^bK/${step.id}]], the inner one [[Sub › Inner#^nS]].`,
    "",
    `Also [the step loop](.codeboard/bK.json#${step.id}).`,
    "",
    "last line",
  ].join("\n");
  put(A, { id: "nA", kind: "note", look: "note", md } as NoteCard, 80, 120, 460);
  A.cards.push({ id: "frS", kind: "board", board: "bS" });
  A.place.frS = { x: 640, y: 120, w: 360, h: 260 };
  const run = await hostBoards([A, K, S], {
    page: {
      light: theme ? theme === "warm-ink" : light,
      w: 1300,
      h: 820,
      ...(scale ? { scale } : {}),
      ...(theme ? { settings: { theme } as never } : {}),
    },
  });
  const h = await run.open("bA");
  const pg = h.page;
  const NA = '.card[data-id="nA"]';
  const chip = (t: string, editing = false) =>
    pg.locator(`${NA} ${editing ? ".md-pm" : ".nbody"} .md-ref`, { hasText: t }).first();
  await until(h, "both references find their cards", async () =>
    pg.evaluate(
      (n) =>
        [...document.querySelectorAll(`${n} .nbody .md-ref`)].filter(
          (e) => !e.classList.contains("missing") && !e.classList.contains("gone"),
        ).length === 2,
      NA,
    ),
  );
  await idle(h);
  return { run, h, pg, step, NA, chip };
}

test("refOtherBoardPreview", async () => {
  const { run, h, pg, step, NA, chip } = await elsewhere();
  const n0 = h.sent.length;
  await watch(h, "refOtherBoardPreview open", { ignore: [".cpeek"], frames: 16 }, () => chip("LLMEngine.step").click());
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  await shot(h, "ref-other-board-preview");
  const shown = await pg.evaluate((n) => {
    const pk = document.querySelector<HTMLElement>(".cpeek")!,
      r = pk.getBoundingClientRect(),
      note = document.querySelector(n)!.getBoundingClientRect();
    return {
      text: pk.textContent ?? "",
      path: pk.querySelector(".chead .cpath")?.textContent ?? "",
      ver: pk.querySelector(".chead .rev")?.textContent ?? "",
      right: r.left >= note.right - 1,
    };
  }, NA);
  const opened = h.sent.slice(n0).filter((m) => m.type === "openBoard" || m.type === "enterBoard").length;
  // a second click closes it; the link to the same card previews it too, also while the Note is edited
  await chip("LLMEngine.step").click();
  await until(h, "a second click closes the preview", async () => (await pg.locator(".cpeek").count()) === 0);
  const b = (await pg.locator(`${NA} .nbody p`).last().boundingBox())!;
  await pg.mouse.dblclick(b.x + b.width - 4, b.y + b.height / 2);
  await pg.locator(".md-pm:focus").waitFor();
  await focusSettled(pg);
  await pg.locator(`${NA} .md-pm a.md-cardlink`).click();
  await pg.locator(".cpeek.show").waitFor();
  const editing = {
    text: (await pg.locator(".cpeek").textContent()) ?? "",
    focused: await pg.locator(".md-pm:focus").count(),
  };
  // the arrow opens Kernels at the card
  const n1 = h.sent.length;
  await pg.locator(".cpeek.show .cpeek-go").click();
  await until(h, "the arrow opens the other board", () =>
    h.sent.slice(n1).some((m) => m.type === "openBoard" && m.id === "bK" && m.card === step.id),
  );
  await until(h, "Kernels opens", () => run.inits.some((i) => i.id === "bK"));
  check(
    "refOtherBoardPreview a reference to a card on another board previews it, with its file and version, opening nothing",
    shown.text.includes("def step") && /\.py:\d+/.test(shown.path) && !!shown.ver.trim() && shown.right && opened === 0,
    { shown: { ...shown, text: shown.text.slice(0, 80) }, opened },
  );
  check(
    "refOtherBoardPreview the link previews it while the Note is edited; the arrow opens that board at the card",
    editing.text.includes("def step") && editing.focused === 1,
    { editing: { ...editing, text: editing.text.slice(0, 60) } },
  );
});

test("refSubBoardPreview", async () => {
  const { h, pg, chip } = await elsewhere();
  const n0 = h.sent.length;
  await watch(h, "refSubBoardPreview open", { ignore: [".cpeek"], frames: 16 }, () => chip("Inner").click());
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  const text = (await pg.locator(".cpeek").textContent()) ?? "";
  const entered = h.sent.slice(n0).filter((m) => m.type === "enterBoard" || m.type === "openBoard").length;
  const n1 = h.sent.length;
  await pg.locator(".cpeek.show .cpeek-go").click();
  await until(h, "the arrow enters the sub-board", () =>
    h.sent.slice(n1).some((m) => m.type === "enterBoard" && m.id === "bS"),
  );
  check(
    "refSubBoardPreview a reference to a card inside a sub-board previews it without entering; the arrow enters",
    text.includes("Deep inside the sub-board") && entered === 0,
    { text: text.slice(0, 80), entered },
  );
});

/** A Note on board bA with references to a card on another board (drawn with its seal), a card inside a sub-board, a card of this
 *  board near the view and one far from it */
async function clicksBoard() {
  const step = nv("LLMEngine.step");
  const K = emptyBoard("bK", "Kernels");
  put(K, step, 60, 60);
  const S = emptyBoard("bS", "Sub");
  put(
    S,
    { id: "nS", kind: "note", look: "note", md: "## Inner\n\nDeep inside the sub-board." } as NoteCard,
    60,
    60,
    320,
  );
  const A = emptyBoard("bA", "Engine");
  const near = nv("Scheduler.schedule"),
    far = nv("ModelRunner.run");
  put(A, near, 600, 500);
  put(A, far, 5000, 500);
  const md = [
    "## Reading",
    "",
    `The step is [[Kernels › LLMEngine.step#^bK/${step.id}]], the inner one [[Sub › Inner#^nS]], near [[here#^${near.id}]], far [[there#^${far.id}]].`,
    "",
    "last line",
  ].join("\n");
  put(A, { id: "nA", kind: "note", look: "note", md } as NoteCard, 80, 120, 460);
  A.cards.push({ id: "frS", kind: "board", board: "bS" });
  A.place.frS = { x: 640, y: 120, w: 360, h: 260 };
  A.cam = { x: 0, y: 0, z: 1 };
  // the double-click window at its widest (Debug's tune): a page busy beside other scenarios gets its presses later than a hand
  const run = await hostBoards([A, K, S], {
    page: { light: true, w: 1300, h: 820, settings: { theme: "warm-ink", tune: { dblClick: 800 } } as never },
  });
  const h = await run.open("bA");
  const pg = h.page;
  const NA = '.card[data-id="nA"]';
  await until(h, "the references find their cards", async () =>
    pg.evaluate(
      (n) =>
        [...document.querySelectorAll(`${n} .nbody .md-ref`)].filter(
          (e) => !e.classList.contains("missing") && !e.classList.contains("gone"),
        ).length === 4,
      NA,
    ),
  );
  /** The middle of reference `t` as the Note shows it (at rest or in the editor) */
  const at = async (t: string) => {
    const b = (await pg.locator(`${NA} .md-ref`, { hasText: t }).first().boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  /** Presses at p as fast as a hand clicks n times: the browser counts them (1, 2, 3…); `frames` drawn between them (a hand's
   *  clicks are some frames apart, and what a click starts moving has moved by the next). The most cards the board had after
   *  any of them (a card added by a stray double-click goes again when it is left empty) */
  const clicks = async (p: { x: number; y: number }, n: number, frames = 0) => {
    await pg.mouse.move(p.x, p.y);
    let most = 0;
    for (let i = 1; i <= n; i++) {
      if (i > 1) for (let f = 0; f < frames; f++) await pg.evaluate(() => new Promise(requestAnimationFrame));
      await pg.mouse.down({ clickCount: i });
      await pg.mouse.up({ clickCount: i });
      most = Math.max(most, await pg.locator(".world .card").count());
    }
    return most;
  };
  const went = (from: number) =>
    h.sent
      .slice(from)
      .filter((m) => m.type === "openBoard" || m.type === "enterBoard")
      .map((m) => m.type);
  /** What the page shows: the editor's caret in the source it opened, cards on the board, the camera, a preview */
  const look = () =>
    pg.evaluate((n) => {
      const pm = document.querySelector(`${n} .md-pm`),
        s = getSelection(),
        node = s?.anchorNode;
      return {
        editing: !!pm,
        caret:
          pm && node && pm.contains(node) && s!.isCollapsed ? (node.textContent ?? "").slice(0, s!.anchorOffset) : "",
        /** references whose source the editor shows */
        open: document.querySelectorAll(`${n} .md-pm .md-refsrc`).length,
        cards: document.querySelectorAll(".world .card").length,
        cam: (document.querySelector(".world") as HTMLElement).style.transform,
        peek: document.querySelectorAll(".cpeek").length,
        picked: String(getSelection()).length,
      };
    }, NA);
  /** Leaves the editing with Esc: the first closes the [[ list the opened source shows */
  const leave = async () => {
    if (await pg.locator(".md-pick.md-refs").count()) await pg.keyboard.press("Escape");
    await pg.keyboard.press("Escape");
    await until(h, "Esc leaves the editing", async () => !(await look()).editing);
  };
  return { run, h, pg, NA, at, clicks, went, look, leave };
}

test("refDoubleClickSource", async () => {
  const { h, pg, at, clicks, went, look, leave } = await clicksBoard();
  await idle(h);
  const cam = (await look()).cam;
  const rest: Record<string, Awaited<ReturnType<typeof look>> & { went: string[] }> = {};
  for (const [k, src] of [
    ["LLMEngine.step", "[[Kernels › LLMEngine.step"],
    ["Inner", "[[Sub › Inner"],
    ["ModelRunner.run", "[[there"],
  ]) {
    const n0 = h.sent.length;
    await clicks(await at(k), 2);
    await until(h, `a double-click on ${k} opens its source`, async () => (await look()).caret.endsWith("[["));
    await idle(h);
    const l = await look();
    rest[k] = { ...l, caret: l.caret.slice(-src.length - 4), went: went(n0) };
    await leave();
    await idle(h);
  }
  // while the Note is edited the same: a double-click on a reference opens its source
  const b = (await pg.locator('.card[data-id="nA"] .nbody p').last().boundingBox())!;
  await pg.mouse.dblclick(b.x + b.width - 4, b.y + b.height / 2);
  await pg.locator(".md-pm:focus").waitFor();
  await focusSettled(pg);
  const n1 = h.sent.length;
  await clicks(await at("LLMEngine.step"), 2);
  await until(h, "in the editor a double-click opens its source", async () => (await look()).caret.endsWith("[["));
  const editing = { ...(await look()), went: went(n1) };
  check(
    "refDoubleClickSource at rest a double-click on a reference (another board's, with its seal; one in a sub-board; a far one) opens its source in the editor, the caret after [[, and opens nothing",
    Object.values(rest).every(
      (r) => r.editing && r.caret.endsWith("[[") && !r.went.length && r.cam === cam && !r.picked,
    ),
    rest,
  );
  check(
    "refDoubleClickSource while the Note is edited a double-click on a reference opens its source too",
    editing.caret.endsWith("[[") && !editing.went.length,
    editing,
  );
});

test("refFastClicks", async () => {
  const { h, pg, at, clicks, went, look, leave } = await clicksBoard();
  // right away, before the editor's code has loaded: the second click starts the editing and the Note shows its text until the
  // editor is there; the third and fourth land on that text, or (on a busy page that loads it sooner) in the source the editor
  // opened, whose line they select as in any text
  const cards = (await look()).cards;
  const n0 = h.sent.length;
  await clicks(await at("LLMEngine.step"), 4);
  await until(h, "the editor opens the reference's source", async () => (await look()).open > 0);
  await idle(h);
  const other = { ...(await look()), went: went(n0) };
  await leave();
  await idle(h);
  const n1 = h.sent.length;
  // the editor is there now: the third and fourth clicks land in the source it opened (and select its line, as in any text)
  await clicks(await at("Inner"), 4);
  await until(h, "the editor opens the reference's source", async () => (await look()).open > 0);
  await idle(h);
  const sub = { ...(await look()), went: went(n1) };
  await leave();
  await idle(h);
  // the far card's preview: three fast clicks on its arrow go there once
  await clicks(await at("ModelRunner.run"), 1);
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  const cam1 = (await look()).cam;
  const go = (await pg.locator(".cpeek.show .cpeek-go").boundingBox())!;
  const most = await clicks({ x: go.x + go.width / 2, y: go.y + go.height / 2 }, 3, 4);
  await idle(h);
  const arrow = { ...(await look()), most };
  check(
    "refFastClicks four fast clicks on a reference to another board's card open its source and nothing else: no board opened, no card added",
    other.open > 0 && !other.went.length && other.cards === cards,
    other,
  );
  check(
    "refFastClicks the same on a reference into a sub-board: its source, the sub-board not entered",
    sub.open > 0 && !sub.went.length && sub.cards === cards,
    sub,
  );
  check(
    "refFastClicks three fast clicks on the preview's arrow go to the card once: no card added where the clicks land",
    arrow.cam !== cam1 && arrow.most === cards && arrow.cards === cards && !arrow.editing && !arrow.peek,
    { arrow, cam1 },
  );
});

test("refNearDoubleClickSource", async () => {
  const { h, at, clicks, went, look, leave } = await clicksBoard();
  await idle(h);
  // at rest a double-click on a reference to a card near the view opens its source, as on any other: its first click waits out
  // the double-click window before going there, so the second press lands on the reference and the camera never moves
  const { cam, cards } = await look();
  const n0 = h.sent.length;
  await clicks(await at("Scheduler.schedule"), 2);
  await until(h, "a double-click on the near reference opens its source", async () =>
    (await look()).caret.endsWith("[["),
  );
  await idle(h);
  const dbl = { ...(await look()), went: went(n0) };
  await leave();
  await idle(h);
  // one click still goes there, once the window is over
  await clicks(await at("Scheduler.schedule"), 1);
  await until(h, "one click on the near reference goes to its card", async () => (await look()).cam !== cam);
  await idle(h);
  const one = await look();
  check(
    "refNearDoubleClickSource at rest a double-click on a reference to a card near the view opens its source, the caret after [[, and the camera stays where it was",
    dbl.editing &&
      dbl.caret.endsWith("[[") &&
      dbl.cam === cam &&
      !dbl.went.length &&
      dbl.cards === cards &&
      !dbl.picked,
    { dbl, cam },
  );
  check(
    "refNearDoubleClickSource one click on it goes to the card, editing nothing",
    one.cam !== cam && !one.editing && one.cards === cards,
    one,
  );
});

test("refNearFastClicks", async () => {
  const { h, at, clicks, look } = await clicksBoard();
  await idle(h);
  // four fast clicks on a reference to a card near the view: the first two are a double-click, which opens its source; the camera
  // does not move, and no click lands on the board's empty space (whose double-click adds a card)
  const { cam, cards } = await look();
  const most = await clicks(await at("Scheduler.schedule"), 4, 4);
  await until(h, "the editor opens the reference's source", async () => (await look()).open > 0);
  await idle(h);
  const near = { ...(await look()), most };
  check(
    "refNearFastClicks four fast clicks on a reference to a card near the view open its source: the camera stays, no card added",
    near.cam === cam && near.most === cards && near.cards === cards && near.editing && near.open > 0,
    { near, cam },
  );
});

test("refWhileEditorLoads", async () => {
  const { h, pg, NA, at, went, look } = await clicksBoard();
  // right after the board opens the editor's code has not loaded: a click on the selected Note's text starts the editing, and the
  // Note shows its text until the editor is there. A click on a reference in that text is not a click on the reference: it
  // opens no other board, enters no sub-board
  const last = (await pg.locator(`${NA} .nbody p`).last().boundingBox())!;
  const p = await at("LLMEngine.step"),
    q = await at("Inner");
  // whether each press found the text the Note shows while its editor loads (the first one does; on a busy page the editor
  // may be there by the second)
  await pg.evaluate((n) => {
    const w = window as unknown as { loadingAtPress: boolean[] };
    w.loadingAtPress = [];
    addEventListener("pointerdown", () => w.loadingAtPress.push(!!document.querySelector(`${n} .md-loading`)), true);
  }, NA);
  await pg.mouse.click(last.x + 4, last.y + last.height / 2);
  await pg.mouse.click(last.x + 4, last.y + last.height / 2);
  const n0 = h.sent.length;
  await pg.mouse.click(p.x, p.y);
  await pg.mouse.click(q.x, q.y);
  const loading = await pg.evaluate(() => (window as unknown as { loadingAtPress: boolean[] }).loadingAtPress.slice(2));
  await until(h, "the editor is there, or another board opened", async () => (await look()).editing || went(n0).length);
  await idle(h);
  const l = { ...(await look()), went: went(n0), loading };
  check(
    "refWhileEditorLoads a click on a reference in the text a Note shows while its editor loads opens nothing",
    l.loading[0] === true && !l.went.length && l.editing,
    l,
  );
});

test("refListLikePalette", async () => {
  // the Note editor's [[ list marks its rows as ⌘K's list does, in Warm Ink light and Ink Wash dark: the row the keys are on a band
  // with the accent's bar and its words as they are, the band staying when the pointer rests on that row
  const seen: Record<string, unknown> = {};
  let ok = true;
  for (const [theme, lt] of [
    ["warm-ink", true],
    ["ink-wash", false],
  ] as const) {
    const b = emptyBoard("b1", "lists");
    put(
      b,
      { id: "nc", kind: "note", look: "note", md: "## Block Manager\n\nHands out blocks." } as NoteCard,
      600,
      60,
      320,
    );
    put(b, { id: "n0", kind: "note", look: "note", md: "Notes here\n\nlast" } as NoteCard, 60, 400, 420);
    const h = await open({ board: b, light: lt, w: 1300, h: 900, settings: { theme } as never });
    const pg = h.page;
    await idle(h);
    const row = (sel: string) =>
      pg
        .locator(sel)
        .first()
        .evaluate((e) => {
          const s = getComputedStyle(e);
          return { bg: s.backgroundColor, ink: s.color, bar: s.boxShadow };
        });
    const p = (await pg.locator('.card[data-id="n0"] .nbody p').last().boundingBox())!;
    await pg.mouse.dblclick(p.x + p.width - 2, p.y + p.height / 2);
    await pg.locator(".md-pm:focus").waitFor();
    await focusSettled(pg);
    await pg.keyboard.press("End");
    await pg.keyboard.type(" see [[Block");
    const sel = pg.locator(".md-pick.md-refs button.sel");
    await sel.waitFor();
    await idle(h);
    const keys = await row(".md-pick.md-refs button.sel");
    const r = (await sel.boundingBox())!;
    await pg.mouse.move(r.x + 30, r.y + r.height / 2);
    const pointer = await row(".md-pick.md-refs button.sel");
    for (let i = 0; i < 3; i++) await pg.keyboard.press("Escape");
    await idle(h);
    await pg.mouse.click(1200, 850);
    await pg.keyboard.press("ControlOrMeta+k");
    await pg.keyboard.type("Block");
    await pg.locator(".plist .cand.on").waitFor();
    await idle(h);
    const palette = await row(".plist .cand.on");
    const same = (a: typeof keys) => a.bg === palette.bg && a.ink === palette.ink && a.bar === palette.bar;
    ok &&= same(keys) && same(pointer);
    seen[`${theme}-${lt ? "light" : "dark"}`] = { keys, pointer, palette };
  }
  check("refListLikePalette the [[ list's highlighted row looks as ⌘K's, with the pointer on it too", ok, seen);
});

const LONG_URL =
  "https://example.com/nano/docs/engine/scheduler/blocks/prefill-and-decode/kv-cache?section=allocation&view=full";
test("noteLinkTip", async () => {
  // resting the pointer on a link in a Note shows its whole address (a long one written as it is is drawn as its site), as the
  // board's tips show: after the tip delay, nothing on the board moving or flashing; leaving the link, or the wheel, hides it.
  // A link to a card shows nothing (its click previews the card)
  const out: Record<string, unknown> = {};
  let ok = true;
  for (const [theme, lt] of [
    ["warm-ink", true],
    ["ink-wash", false],
  ] as const) {
    const b = emptyBoard("b1", "tips");
    const md = [
      "# Tips",
      "",
      `Read [the scheduler notes](${LONG_URL}) first.`,
      "",
      `Or as it is: ${LONG_URL}`,
      "",
      "The [step loop](.codeboard/b1.json#nc) is here.",
    ].join("\n");
    put(b, { id: "n0", kind: "note", look: "note", md } as NoteCard, 60, 60, 440);
    put(b, { id: "nc", kind: "note", look: "note", md: "## Step\n\nThe loop." } as NoteCard, 3000, 60, 320);
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light: lt, w: 1100, h: 700, settings: { theme } as never });
    const pg = h.page;
    await idle(h);
    const tip = () =>
      pg.evaluate(() => {
        const t = document.querySelector<HTMLElement>(".tip.show");
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { text: t.textContent ?? "", inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 };
      });
    const named = link(pg, "the scheduler notes"),
      bare = pg.locator(`${N} .nbody a.md-link .md-short`).first(),
      card = link(pg, "step loop");
    // the named link: the tip comes in place, nothing else on the board moving or flashing
    const r = (await named.boundingBox())!;
    await watch(h, `noteLinkTip ${theme}`, { ignore: [".tip"], frames: 50 }, () =>
      pg.mouse.move(r.x + r.width / 2, r.y + r.height / 2),
    );
    await until(h, "the tip shows", async () => !!(await tip()));
    await idle(h);
    const one = await tip();
    await shot(h, `link-tip-${theme}-${lt ? "light" : "dark"}`);
    await pg.mouse.move(r.x + r.width / 2, r.y + r.height + 120);
    await until(h, "leaving the link hides the tip", async () => !(await tip()));
    // the long address drawn as its site
    const s = (await bare.boundingBox())!;
    await pg.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await until(h, "the folded address's tip shows", async () => !!(await tip()));
    const two = await tip();
    await pg.mouse.wheel(0, 40);
    await until(h, "the wheel hides it", async () => !(await tip()));
    // a link to a card: nothing
    await pg.mouse.move(10, 600);
    const c = (await card.boundingBox())!;
    await pg.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    await hold(h, TIP_DELAY + 200, "a link to a card shows no tip");
    const three = await tip();
    ok &&= one?.text === LONG_URL && !!one.inside && two?.text === LONG_URL && !!two.inside && !three;
    out[`${theme}-${lt ? "light" : "dark"}`] = { one, two, three };
    await h.close();
  }
  check(
    "noteLinkTip resting on a link shows its whole address, the folded one's too, inside the window; a link to a card shows none",
    ok,
    out,
  );
});
