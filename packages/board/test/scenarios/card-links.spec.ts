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
import * as fs from "node:fs";
import type { Page } from "@playwright/test";
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import { put, shot, symCard, findSym, type Host } from "../harness";
import { PEEK_DELAY } from "../../src/state/timing";
import { test, open, check, light, until, idle, hold, focusSettled, hostBoards } from "../fixtures";

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
