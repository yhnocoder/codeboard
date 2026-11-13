// Links and [[references]] in a Note, at rest and while it is edited (ui/pops/cardpeek.tsx, ui/Editable.tsx, the editor's links):
//  noteRefPreview              a click on a reference to a card far from the view previews the card beside the Note (resting on it shows nothing),
//                              covering none of the Note; a second click, Esc or a click elsewhere closes it, its arrow goes to
//                              the card; references to a Section or another board go there, with no preview
//  noteRefPreviewWhileEditing  in the editor a click on a reference to a card previews it too and the caret stays where it was;
//                              Esc closes the preview and the editing goes on; a double-click opens the reference's source, and so
//                              does a click on a reference to a Section
//  noteRefPreviewNarrowWindow  in a window narrower than the preview it is made smaller, so all of it and its arrow are on screen
//  noteRefPreviewKeepsSide     a Note by the window's right edge: the preview stays on its right, moved in just enough to fit the
//                              window, never to the other side
//  noteRefPreviewDrag          dragged by its head the preview follows the pointer with nothing else moving or jumping, stays
//                              open where it was put, keeps that place as the board pans, and a click elsewhere still closes it
//  noteRefPreviewFollowsBoard  the preview stays beside its reference as the board pans; switching boards closes it
//  noteRefNearGoesThere        a reference to a card near the view (in it, or less than a screen out: actions cardNear) goes
//                              to the card instead: a card in view is selected with no camera move, one past the edge is
//                              panned to with nothing jumping, and a card further than a screen is previewed as before
//  noteRefNearWhileEditing     in the editor a click on a reference to a card near the view pans to it, the Note still being
//                              edited with its caret where it was, and no preview
//  noteLinkFoldedAddressClick  a click on a long address shown as its site, while editing, opens its link box: the page does not
//                              follow the link, and no click on an element with an address reaches the window (a VS Code webview
//                              would open it in the browser); ⌘-click opens it once
//  noteLinkBoxLeftByClick      a press on a link held as a hand holds it opens its box; a change made there is written when a
//                              click in the Note's text leaves the box, and the caret goes where that click was
//  noteLinkBoxFollowsBoard     the open link box stays under its link as the board pans
//  noteBareUrlFoldedAtRest     a long address written as it is shows as its site at rest too, so the Note keeps its height when
//                              editing starts, and a click after it puts the caret on the character clicked
//  noteRefCursors              the whole of a reference to another board shows the pointer; a reference that finds nothing does not
import type { Page } from "@playwright/test";
import { emptyBoard, DEFAULT_SETTINGS, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import { put, shot, type Host } from "../harness";
import { PEEK_DELAY } from "../../src/state/timing";
import { test, open, check, light, until, idle, hold, focusSettled, pmHasSelection } from "../fixtures";
import { watch } from "../watch";

const URL = "https://github.com/GeeeekExplorer/nano-vllm/blob/main/nanovllm/engine/scheduler.py";
const NOTE = [
  "# Reading the scheduler",
  "",
  `Short link [nano-vllm](https://github.com/GeeeekExplorer/nano-vllm) and a bare one ${URL} here.`,
  "",
  "It calls [[schedule#^k1]], which asks [[Block Manager#^nc]] for blocks.",
  "",
  "- a Section: [[Prefill stage#^g1]]",
  "- another board: [[Kernels]]",
  "- broken: [[Nowhere card]]",
  "",
  "last line",
].join("\n");
const CODE = Array.from({ length: 24 }, (_, i) =>
  i % 4 === 0 ? `def step_${i}(seq):` : `    total += seq.len * ${i}`,
);

function board(id = "b1", name = "links"): Board {
  const b = emptyBoard(id, name);
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

async function openLinks(w = 1300, z = 1, x = 0): Promise<Host> {
  const b = board();
  b.cam = { x, y: 0, z };
  const h = await open({ board: b, light, w, h: 860 });
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

const N = '.card[data-id="n0"]';
const ref = (pg: Page, text: string, editing = false) =>
  pg.locator(`${N} ${editing ? ".md-pm" : ".nbody"} .md-ref`, { hasText: text }).first();
const peeks = (pg: Page) => pg.locator(".cpeek").count();
const rect = (pg: Page, sel: string) =>
  pg
    .locator(sel)
    .first()
    .evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
    });
const caret = (pg: Page) => pg.locator(".md-pm").evaluate((e) => (e as any).editor.state.selection.from as number);
const paragraph = (pg: Page, i: number) =>
  pg.locator(".md-pm").evaluate((e, i) => (e as any).editor.state.doc.child(i).textContent as string, i);

/** Double-click the Note's last line: editing, the caret at its end */
async function edit(h: Host) {
  const pg = h.page;
  const last = pg.locator(`${N} .nbody p`).last();
  const b = (await last.boundingBox())!;
  await pg.mouse.dblclick(b.x + b.width - 4, b.y + b.height / 2);
  await pg.locator(".md-pm:focus").waitFor();
  await focusSettled(pg);
  await idle(h);
}

test("noteRefPreview", async () => {
  const h = await openLinks();
  const pg = h.page;
  await ref(pg, "schedule").hover();
  await hold(h, PEEK_DELAY * 2, "resting on a reference must not preview its card");
  const onHover = await peeks(pg);
  // the preview opens with nothing on the board moving or flashing
  await watch(h, "noteRefPreview open", { ignore: [".cpeek"], frames: 12 }, () => ref(pg, "schedule").click());
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  await shot(h, "note-ref-preview");
  const shown = await pg.evaluate((n) => {
    const pk = document.querySelector<HTMLElement>(".cpeek")!,
      r = pk.getBoundingClientRect(),
      note = document.querySelector(n)!.getBoundingClientRect(),
      chip = document.querySelector(`${n} .nbody .md-ref`)!.getBoundingClientRect();
    return {
      text: pk.textContent ?? "",
      beside: r.left >= note.right - 1 || r.right <= note.left + 1,
      level: Math.abs(r.top - chip.top) < 24,
      h: Math.round(pk.querySelector(".cpeek-stage")!.getBoundingClientRect().height),
      cut: pk.classList.contains("cut"),
      copy: !!pk.querySelector(".card") && !pk.querySelector("[data-id]"),
      go: pk.querySelectorAll(".cpeek-go").length,
    };
  }, N);
  await ref(pg, "schedule").click();
  await until(h, "a second click closes the preview", async () => (await peeks(pg)) === 0);
  await ref(pg, "schedule").click();
  await pg.locator(".cpeek.show").waitFor();
  await pg.keyboard.press("Escape");
  await until(h, "Esc closes the preview", async () => (await peeks(pg)) === 0);
  await ref(pg, "Block Manager").click();
  await pg.locator(".cpeek.show").waitFor();
  const other = (await pg.locator(".cpeek").textContent()) ?? "";
  await pg.mouse.click(400, 760);
  await until(h, "a click elsewhere closes the preview", async () => (await peeks(pg)) === 0);
  const n = h.sent.length;
  await ref(pg, "Kernels").click();
  await until(h, "the board reference opens that board", () =>
    h.sent.slice(n).some((m) => m.type === "openBoard" && m.id === "bk"),
  );
  const boardPeek = await peeks(pg);
  await ref(pg, "schedule").click();
  await pg.locator(".cpeek.show .cpeek-go").click();
  await pg.locator('.card.sel[data-id="k1"]').waitFor();
  const afterGo = await peeks(pg);
  // Go to Card took the camera to the card, far from the Note: the Section's reference on the board as it opens
  await h.close();
  const h2 = await openLinks();
  await ref(h2.page, "Prefill stage").click();
  await h2.page.locator('.sect.sel[data-sect="g1"]').waitFor();
  const sectionPeek = await peeks(h2.page);
  check(
    "noteRefPreview a click on a reference to a card previews it beside the Note; a click, Esc or a click elsewhere closes it",
    onHover === 0 &&
      shown.text.includes("def step_0") &&
      shown.beside &&
      shown.level &&
      shown.copy &&
      shown.go === 1 &&
      shown.h <= 281 &&
      shown.cut &&
      other.includes("Hands out KV cache blocks") &&
      afterGo === 0,
    { onHover, shown, other, afterGo },
  );
  check("noteRefPreview a Section or another board has no preview", boardPeek === 0 && sectionPeek === 0, {
    boardPeek,
    sectionPeek,
  });
  await h2.close();
});

test("noteRefPreviewWhileEditing", async () => {
  const h = await openLinks();
  const pg = h.page;
  await edit(h);
  const before = await caret(pg);
  await ref(pg, "schedule", true).click();
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  await shot(h, "note-ref-preview-editing");
  const opened = {
    caret: await caret(pg),
    focused: await pg.locator(".md-pm:focus").count(),
    text: (await pg.locator(".cpeek").textContent()) ?? "",
    source: await pg.locator(`${N} .md-pm p`).nth(1).innerText(),
  };
  await pg.keyboard.press("Escape");
  await until(h, "Esc closes the preview", async () => (await peeks(pg)) === 0);
  const afterEsc = { editing: await pg.locator(".md-pm:focus").count() };
  await ref(pg, "schedule", true).dblclick();
  await until(h, "a double-click opens the reference's source", async () =>
    (await pg.locator(`${N} .md-pm p`).nth(1).innerText()).includes("[[schedule"),
  );
  await until(h, "the preview of the reference opened as source closes", async () => (await peeks(pg)) === 0);
  // the caret out of that source again (its [[ list, over the lines below, closes): the end of the last line, beside the list
  const end = (await pg.locator(`${N} .md-pm p`).last().boundingBox())!;
  await pg.mouse.click(end.x + end.width - 4, end.y + end.height / 2);
  await until(h, "the [[ list closes", async () => (await pg.locator(".mdui-anchor .sel").count()) === 0);
  // a Section: its source, no camera move, the Section not selected
  const cam = await pg.locator(".world").evaluate((e) => (e as HTMLElement).style.transform);
  await ref(pg, "Prefill stage", true).click();
  await until(h, "a click on a reference to a Section opens its source", async () =>
    (await pg.locator(`${N} .md-pm li`).first().innerText()).includes("[[Prefill stage"),
  );
  const section = {
    cam: (await pg.locator(".world").evaluate((e) => (e as HTMLElement).style.transform)) === cam,
    selected: await pg.locator(".sect.sel").count(),
    editing: await pg.locator(".md-pm").count(),
  };
  check(
    "noteRefPreviewWhileEditing a click previews the card and the caret stays",
    opened.caret === before &&
      opened.focused === 1 &&
      opened.text.includes("def step_0") &&
      !opened.source.includes("[[") &&
      afterEsc.editing === 1,
    { before, opened, afterEsc },
  );
  check(
    "noteRefPreviewWhileEditing a reference to a Section opens its source",
    section.cam && section.selected === 0 && section.editing === 1,
    section,
  );
  await h.close();
});

test("noteRefPreviewNarrowWindow", async () => {
  const h = await openLinks(420, 0.6);
  const pg = h.page;
  await ref(pg, "schedule").click();
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  await shot(h, "note-ref-preview-narrow");
  const r = await rect(pg, ".cpeek"),
    go = await rect(pg, ".cpeek .cpeek-go");
  const chip = await rect(pg, `${N} .nbody .md-ref`);
  check(
    "noteRefPreviewNarrowWindow the preview fits a narrow window, its arrow on screen, at its reference's height",
    r.x >= 0 && r.r <= 420 && go.x >= 0 && go.r <= 420 && Math.abs(r.y - chip.y) < 24,
    { r, go, chip },
  );
  await h.close();
});

test("noteRefPreviewKeepsSide", async () => {
  // the Note from 740 to 1260 in a window 1300 wide: no room on its right, plenty on its left
  const h = await openLinks(1300, 1, 700);
  const pg = h.page;
  await ref(pg, "schedule").click();
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  await shot(h, "note-ref-preview-keeps-side");
  const r = await rect(pg, ".cpeek"),
    go = await rect(pg, ".cpeek .cpeek-go"),
    note = await rect(pg, N),
    chip = await rect(pg, `${N} .nbody .md-ref`);
  check(
    "noteRefPreviewKeepsSide the preview stays on the Note's right, moved in to fit the window, its arrow on screen",
    r.x >= note.x && r.r <= 1300 - 7 && go.r <= 1300 && Math.abs(r.y - chip.y) < 24,
    { r, go, note, chip },
  );
  await h.close();
});

test("noteRefPreviewDrag", async () => {
  const h = await openLinks();
  const pg = h.page;
  await ref(pg, "schedule").click();
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  const before = await rect(pg, ".cpeek"),
    grip = (await pg.locator(".cpeek .cpeek-grip").boundingBox())!,
    x = grip.x + grip.width / 2,
    y = grip.y + grip.height / 2;
  await pg.mouse.move(x, y);
  const peek = [/^chrome:\.cpeek#/];
  await watch(
    h,
    "noteRefPreviewDrag move",
    { chrome: [".cpeek"], free: peek, keep: [".cpeek"], frames: 12 },
    async () => {
      await pg.mouse.down();
      for (let i = 1; i <= 4; i++) await pg.mouse.move(x + i * 20, y + i * 15);
    },
  );
  await watch(h, "noteRefPreviewDrag drop", { chrome: [".cpeek"], keep: [".cpeek"], frames: 16 }, () => pg.mouse.up());
  await idle(h);
  await shot(h, "note-ref-preview-dragged");
  const after = await rect(pg, ".cpeek"),
    open1 = await peeks(pg),
    place = h.board().place.n0;
  const off = async () => {
    const p = await rect(pg, ".cpeek"),
      c = await rect(pg, `${N} .nbody .md-ref`);
    return { dx: p.x - c.x, dy: p.y - c.y };
  };
  const a = await off();
  await pg.mouse.move(900, 780);
  await pg.mouse.wheel(40, 90);
  await idle(h);
  const b = await off();
  await pg.mouse.click(400, 800);
  await until(h, "a click elsewhere closes the dragged preview", async () => (await peeks(pg)) === 0);
  check(
    "noteRefPreviewDrag the preview goes with the pointer, stays open where it was put, the Note stays",
    Math.abs(after.x - before.x - 80) <= 1 &&
      Math.abs(after.y - before.y - 60) <= 1 &&
      open1 === 1 &&
      place.x === 40 &&
      place.y === 60,
    { before, after, open1, place },
  );
  check(
    "noteRefPreviewDrag the dragged preview keeps its place by its reference as the board pans",
    Math.abs(a.dx - b.dx) <= 1 && Math.abs(a.dy - b.dy) <= 1,
    { a, b },
  );
  await h.close();
});

test("noteRefPreviewFollowsBoard", async () => {
  const h = await openLinks();
  const pg = h.page;
  await ref(pg, "schedule").click();
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  const off = async () => {
    const p = await rect(pg, ".cpeek"),
      c = await rect(pg, `${N} .nbody .md-ref`);
    return { dx: p.x - c.x, dy: p.y - c.y };
  };
  const a = await off();
  await pg.mouse.move(900, 780);
  await pg.mouse.wheel(40, 90);
  await idle(h);
  const b = await off();
  const other = board("b2", "other");
  await h.post({
    type: "init",
    board: other,
    boards: [{ id: "b2", name: "other", cards: 3 }],
    views: {},
    stale: {},
    host: { assetBase: "", target: true, settings: DEFAULT_SETTINGS },
  } as never);
  await pg.locator(`${N} .nbody`).waitFor();
  await idle(h);
  const left = await peeks(pg);
  check(
    "noteRefPreviewFollowsBoard the preview stays beside its reference as the board pans, and goes with the board",
    Math.abs(a.dx - b.dx) <= 1 && Math.abs(a.dy - b.dy) <= 1 && left === 0,
    { a, b, left },
  );
  await h.close();
});

test("noteLinkFoldedAddressClick", async () => {
  const h = await openLinks();
  const pg = h.page;
  await edit(h);
  const page = pg.url();
  await pg.evaluate(() => {
    const w = window as unknown as { __hrefClicks: number };
    w.__hrefClicks = 0;
    // what a VS Code webview does: any click on an element with an address opens it in the browser
    addEventListener("click", (e) => {
      if (e.composedPath().some((n) => n instanceof HTMLAnchorElement && n.hasAttribute("href"))) w.__hrefClicks++;
    });
  });
  const folded = pg.locator(`${N} .md-pm a.md-bare`);
  const label = await folded.textContent();
  await folded.click();
  await pg.locator(".md-bubble .md-linkbox").waitFor({ timeout: 5000 });
  const box = await pg
    .locator(".md-bubble .md-linkbox input")
    .evaluateAll((is) =>
      is.map((i) => ({ v: (i as HTMLInputElement).value, left: (i as HTMLInputElement).scrollLeft })),
    );
  await shot(h, "note-link-folded-box");
  await pg.locator(`${N} .md-pm p`).last().click();
  await until(h, "the box closes", async () => (await pg.locator(".md-bubble .md-linkbox").count()) === 0);
  const n = h.sent.length;
  await folded.click({ modifiers: ["ControlOrMeta"] });
  await until(h, "⌘-click opens the link", () => h.sent.slice(n).some((m) => m.type === "openLink"));
  const opened = h.sent.slice(n).filter((m) => m.type === "openLink");
  const hrefClicks = await pg.evaluate(() => (window as unknown as { __hrefClicks: number }).__hrefClicks);
  check(
    "noteLinkFoldedAddressClick a click opens the link's box, never the page's navigation",
    label === "github.com/…" &&
      pg.url() === page &&
      box.length === 2 &&
      box[1].v === URL &&
      box[1].left === 0 &&
      hrefClicks === 0 &&
      opened.length === 1 &&
      (opened[0] as { url?: string }).url === URL,
    { label, url: pg.url(), box, hrefClicks, opened },
  );
  await h.close();
});

test("noteLinkBoxLeftByClick", async () => {
  const h = await openLinks();
  const pg = h.page;
  await edit(h);
  // a press held as a hand holds it: the browser has put the caret into the link before the button comes up
  const link = (await pg.locator(`${N} .md-pm a.md-link:not(.md-bare)`).boundingBox())!;
  await pg.mouse.move(link.x + link.width / 2, link.y + link.height / 2, { steps: 4 });
  await pg.mouse.down();
  await until(h, "the caret is in the pressed link", async () => (await caret(pg)) < 60);
  await pg.mouse.up();
  await pg.locator(".md-bubble .md-linkbox").waitFor({ timeout: 5000 });
  await pg.locator(".md-bubble .md-linktext").fill("the repo");
  const last = (await pg.locator(`${N} .md-pm p`).last().boundingBox())!;
  await pg.mouse.click(last.x + 1, last.y + last.height / 2);
  await until(h, "the change is written", async () => (await paragraph(pg, 1)).includes("[the repo]("));
  await pmHasSelection(pg);
  const at = await pg.locator(".md-pm").evaluate((e) => {
    const s = (e as any).editor.state.selection;
    return {
      text: s.$from.parent.textContent as string,
      off: s.$from.parentOffset as number,
      empty: s.empty as boolean,
    };
  });
  check(
    "noteLinkBoxLeftByClick the change is written and the caret goes where the click was",
    at.text === "last line" && at.off === 0 && at.empty,
    { at, src: await paragraph(pg, 1) },
  );
  await h.close();
});

test("noteLinkBoxFollowsBoard", async () => {
  const h = await openLinks();
  const pg = h.page;
  await edit(h);
  const link = `${N} .md-pm a.md-link:not(.md-bare)`;
  await pg.locator(link).click();
  await pg.locator(".md-bubble .md-linkbox").waitFor({ timeout: 5000 });
  await idle(h);
  const off = async () => {
    const p = await rect(pg, ".md-bubble"),
      l = await rect(pg, link);
    return { dx: p.x - l.x, dy: p.y - l.b };
  };
  const a = await off();
  await pg.mouse.move(900, 780);
  await pg.mouse.wheel(60, 80);
  await idle(h);
  const b = await off();
  check(
    "noteLinkBoxFollowsBoard the box stays under its link as the board pans",
    Math.abs(a.dx - b.dx) <= 1 && Math.abs(a.dy - b.dy) <= 1 && a.dy >= 0 && a.dy < 16,
    { a, b },
  );
  await h.close();
});

test("noteBareUrlFoldedAtRest", async () => {
  const h = await openLinks();
  const pg = h.page;
  const atRest = {
    text: await pg.locator(`${N} .nbody p`).first().innerText(),
    h: (await pg.locator(N).boundingBox())!.height,
  };
  // select the Note, then a click on "here" after the address starts editing with the caret there
  await pg.locator(`${N} .chead`).click();
  const word = await pg
    .locator(`${N} .nbody p`)
    .first()
    .evaluate((p) => {
      const t = [...p.childNodes].at(-1)!,
        r = document.createRange(),
        at = t.textContent!.indexOf("here");
      r.setStart(t, at + 2);
      r.setEnd(t, at + 2);
      const b = r.getBoundingClientRect();
      return { x: b.left, y: b.top + b.height / 2 };
    });
  await pg.mouse.click(word.x, word.y);
  await pg.locator(".md-pm:focus").waitFor();
  await focusSettled(pg);
  await idle(h);
  const editing = {
    h: (await pg.locator(N).boundingBox())!.height,
    at: await pg.locator(".md-pm").evaluate((e) => {
      const s = (e as any).editor.state.selection;
      return (s.$from.parent.textContent as string).slice(s.$from.parentOffset);
    }),
  };
  check(
    "noteBareUrlFoldedAtRest the address shows as its site at rest and the Note keeps its height when editing starts",
    atRest.text.includes("a bare one github.com/… here") && Math.abs(atRest.h - editing.h) < 0.5,
    { atRest, editing },
  );
  check(
    "noteBareUrlFoldedAtRest a click after the address puts the caret there",
    editing.at.startsWith("re."),
    editing,
  );
  await h.close();
});

test("noteRefCursors", async () => {
  const h = await openLinks();
  const pg = h.page;
  const cursorAt = (sel: string) =>
    pg
      .locator(sel)
      .first()
      .evaluate((e) => {
        const r = e.getBoundingClientRect(),
          t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)!;
        return getComputedStyle(t).cursor;
      });
  const seal = await cursorAt(`${N} .nbody .md-ref .md-seal`);
  const broken = await cursorAt(`${N} .nbody .md-ref.missing`);
  const card = await cursorAt(`${N} .nbody .md-ref:not(.missing):not(.sealed)`);
  await edit(h);
  const brokenEditing = await cursorAt(`${N} .md-pm .md-ref.missing`);
  check(
    "noteRefCursors a reference shows the pointer over all of it; one that finds nothing only where a click does something",
    seal === "pointer" && card === "pointer" && broken === "default" && brokenEditing === "pointer",
    { seal, card, broken, brokenEditing },
  );
  await h.close();
});

/** A Note with references to a card in view, one just past the window's right edge and one further than a screen */
function nearBoard(): Board {
  const b = emptyBoard("b1", "near");
  const seg = (id: string) => ({
    id,
    src: { kind: "free" },
    path: "",
    lang: "python",
    start: 1,
    end: 8,
    text: CODE.slice(0, 8),
    version: { kind: "none" },
  });
  const code = (id: string, title: string, x: number) =>
    put(b, { id, kind: "code", title, segments: [seg(`s-${id}`)] } as unknown as CodeCard, x, 60, 420);
  code("kv", "in view", 620);
  code("kp", "past the edge", 1700);
  code("kf", "far away", 4200);
  put(
    b,
    {
      id: "n0",
      kind: "note",
      look: "note",
      md: "# Near and far\n\nSee [[in view#^kv]], [[past the edge#^kp]] and [[far away#^kf]].\n\nlast line",
    } as NoteCard,
    40,
    60,
    520,
  );
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const camOf = (pg: Page) => pg.locator(".world").evaluate((e) => (e as HTMLElement).style.transform);
const inView = (pg: Page, id: string) =>
  pg.locator(`.card[data-id="${id}"]`).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.top < innerHeight;
  });

test("noteRefNearGoesThere", async () => {
  const h = await open({ board: nearBoard(), light, w: 1300, h: 860 });
  const pg = h.page;
  await idle(h);
  const cam0 = await camOf(pg);
  // further than a screen: the preview, the camera staying
  await ref(pg, "far away").click();
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  const far = { cam: (await camOf(pg)) === cam0, text: (await pg.locator(".cpeek").textContent()) ?? "" };
  await pg.keyboard.press("Escape");
  await until(h, "Esc closes the preview", async () => (await peeks(pg)) === 0);
  await ref(pg, "in view").click();
  await pg.locator('.card.sel[data-id="kv"]').waitFor();
  await idle(h);
  const visible = { cam: (await camOf(pg)) === cam0, peeks: await peeks(pg) };
  // past the edge: the camera pans to it, nothing jumping on the way
  await watch(h, "noteRefNearGoesThere pan", { moves: "all", frames: 40 }, () => ref(pg, "past the edge").click());
  await pg.locator('.card.sel[data-id="kp"]').waitFor();
  await idle(h);
  await shot(h, "note-ref-near-panned");
  const panned = {
    cam: (await camOf(pg)) !== cam0,
    seen: await inView(pg, "kp"),
    peeks: await peeks(pg),
    z: h.board().cam?.z ?? null,
  };
  check(
    "noteRefNearGoesThere a card in view is selected with no camera move and no preview",
    visible.cam && visible.peeks === 0,
    visible,
  );
  check(
    "noteRefNearGoesThere a card less than a screen out is panned to and selected, no preview",
    panned.cam && panned.seen && panned.peeks === 0,
    panned,
  );
  check(
    "noteRefNearGoesThere a card further than a screen is previewed, the camera staying",
    far.cam && far.text.includes("far away"),
    { cam: far.cam, text: far.text.slice(0, 60) },
  );
  await h.close();
});

test("noteRefNearWhileEditing", async () => {
  const h = await open({ board: nearBoard(), light, w: 1300, h: 860 });
  const pg = h.page;
  await idle(h);
  await edit(h);
  const before = await caret(pg),
    cam0 = await camOf(pg);
  await ref(pg, "past the edge", true).click();
  await until(h, "the camera pans to the card", async () => (await camOf(pg)) !== cam0);
  await idle(h);
  const after = {
    caret: await caret(pg),
    focused: await pg.locator(".md-pm:focus").count(),
    seen: await inView(pg, "kp"),
    peeks: await peeks(pg),
  };
  check(
    "noteRefNearWhileEditing a reference to a card near the view pans there; the Note is still edited, its caret kept",
    after.caret === before && after.focused === 1 && after.seen && after.peeks === 0,
    { before, after },
  );
  await h.close();
});
