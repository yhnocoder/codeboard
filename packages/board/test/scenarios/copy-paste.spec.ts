// Copying and pasting cards, and dropping an image card into a Note.
//   copiedCardsGiveOtherAppsTheirContent  ⌘C puts the cards' own text on the system clipboard (Note / Text = Markdown, code = its
//                                         lines, joined by blank lines) and, for an image card, the picture itself as image/png;
//                                         pasting that clipboard back on the board still gives the card, not a new image or Note
//   pastedCardsKeepTheirSize              ⌘C then ⌘V on the same board: every pasted card has the original's width and height
//   imageCardDropsIntoNote                dragging an image card onto a Note lights the Note up; releasing puts the image into the
//                                         Note's Markdown (saved under assets/ like a pasted image) and removes the image card, in one
//                                         undo step
//   imageCardDropsAtPointerInNote         while the image card hovers over the Note, a line between two blocks shows where it goes and
//                                         follows the pointer (no layout reads per move); releasing puts the image there
//   pasteAsReference                      after ⌘C ⌘V (and ⌘D) a Copy ✓ | Reference chip sits at the copy's bottom-right corner;
//                                         Reference makes the copy the same card as the original (one undo step): editing either one
//                                         changes both, both show the "same card" mark, Detach makes it a copy again; for code cards
//                                         the two places share the original's segments. A click elsewhere puts the chip away
//   pasteIntoEditorMakesNoCard            ⌘V while editing a Note (into its code block, and into its text) pastes there only: the
//                                         board does not also turn the paste into a card. In VS Code the paste event's target is the
//                                         highlighted span the selection starts on, and the code editor replaces that span before the
//                                         event reaches the board
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type Card, type CodeCard, type NoteCard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "@codeboard/host/nodefs";
import { readAsset, saveNoteImage } from "@codeboard/host/images";
import { png } from "@codeboard/host/test/images";
import { OUT, put, symCard, findSym, type Host } from "../harness";
import { test, open, check, until, idle, frames, expect, focusSettled } from "../fixtures";

const BASE = "https://cb-assets.test/res";
/** A 240 × 160 picture: a warm gradient with a dark band */
const PICTURE = png(240, 160, (x, y) => (y > 60 && y < 100 ? [40, 44, 60, 255] : [230 - x / 3, 150 + y / 4, 80, 255]));

/** The board in Warm Ink with a host that keeps assets/ in a temp storage folder (served at BASE), answers readAsset and saveImage
 * with the host's own code, and plays the host's card clipboard for pastes on the same board (pasteCards answers null there) */
async function boardWith(b: Board) {
  const dir = path.join(OUT, `copy-paste-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const store = new Storage(nodeFs, { dir: () => dir });
  fs.mkdirSync(store.assetsDir(), { recursive: true });
  fs.writeFileSync(path.join(store.assetsDir(), "card.png"), PICTURE);
  const h = await open({
    board: b, light: true, w: 1300, h: 820, settings: { theme: "warm-ink" } as any, host: { assetBase: BASE },
    beforeLoad: async (p) => {
      await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await p.route(`${BASE}/**`, (r) => {
        const f = path.join(store.assetsDir(), decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop()!));
        return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: "image/png" }) : r.fulfill({ status: 404 });
      });
    },
    on: async (m, reply) => {
      if (m.type === "readAsset") { try { await reply(m.req!, await readAsset(store, m.file)); } catch (e) { await reply(m.req!, undefined, (e as Error).message); } return true; }
      if (m.type === "saveImage") { try { await reply(m.req!, await saveNoteImage(store, m.dataUrl)); } catch (e) { await reply(m.req!, undefined, (e as Error).message); } return true; }
      if (m.type === "pasteCards") { await reply(m.req!, null); return true; }
      return false;
    },
  });
  // the pictures of the image cards have loaded
  for (const img of await h.page.locator(".card .imgb img").all()) await img.evaluate((e) => (e as HTMLImageElement).decode());
  await idle(h);
  const assets = () => fs.readdirSync(store.assetsDir()).sort();
  return { h, assets, done: async () => { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const cardEl = (h: Host, id: string) => h.page.locator(`.card[data-id="${id}"]`);
/** What the system clipboard holds now: its types, its text and, if there is one, the size of its PNG, all of one copy. A
 *  readText() after read() can already see the next copy (its text with the types of the copy before), so the text comes from
 *  read()'s items too; their getType() throws "Clipboard data has changed" when a copy lands in between, and then there is no
 *  answer yet (undefined: the until around it reads again) */
const clipboard = (h: Host) => h.page.evaluate(async () => {
  const items = await navigator.clipboard.read();
  const types = items.flatMap((i) => i.types);
  const of = (t: string) => items.find((i) => i.types.includes(t))?.getType(t);
  try {
    const txt = await of("text/plain"), img = await of("image/png");
    const bmp = img ? await createImageBitmap(img) : undefined;
    return { types, text: txt ? await txt.text() : "", png: bmp && { w: bmp.width, h: bmp.height } };
  } catch (e) {
    if (e instanceof DOMException && e.name === "InvalidStateError") return undefined;
    throw e;
  }
});
/** ⌘V of what the system clipboard holds now: a paste event carrying its text and its picture, the way the browser sends one */
const pasteClipboard = (h: Host) => h.page.evaluate(async () => {
  const dt = new DataTransfer();
  for (const it of await navigator.clipboard.read()) for (const t of it.types) {
    const blob = await it.getType(t);
    if (t.startsWith("image/")) dt.items.add(new File([blob], "image.png", { type: t })); else dt.setData(t, await blob.text());
  }
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
const shotTo = async (h: Host, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
  await idle(h);
  await h.page.screenshot({ path: path.join(OUT, `copy-paste-${name}.png`), clip });
};

test("copiedCardsGiveOtherAppsTheirContent", async () => {
  const b = emptyBoard("b1", "copy");
  const note = { id: "n1", kind: "note", md: "## Prefill first\n\nThe scheduler fills the batch with **waiting** sequences.", look: "note" } as NoteCard;
  const text = { id: "t1", kind: "note", md: "then *decode*", look: "text" } as NoteCard;
  const sched = findSym("Scheduler.schedule"), code = symCard(sched.f, sched.s);
  put(b, note, 60, 80, 360); put(b, text, 60, 330, 220); put(b, code, 480, 80, 620);
  put(b, { id: "i1", kind: "image", src: "card.png" } as Card, 60, 440, 240);
  b.cam = { x: 0, y: 0, z: 1 };
  const { h, done } = await boardWith(b);
  const pg = h.page;

  // a Note, a Text and a code card: their text, in the order picked, with blank lines between
  await cardEl(h, "n1").locator(".chead").click();
  await cardEl(h, "t1").click({ modifiers: ["Shift"] });
  await cardEl(h, code.id).locator(".chead").click({ modifiers: ["Shift"] });
  await pg.keyboard.press("Meta+c");
  const three = await until(h, "the copy is on the clipboard", async () => { const c = await clipboard(h); return c?.text ? c : undefined; });
  const want = [note.md, text.md, code.segments[0].text.join("\n")].join("\n\n");
  check("copiedCardsGiveOtherAppsTheirContent Note, Text and code as text", three.text === want, { got: three.text.slice(0, 300), want: want.slice(0, 300) });

  // an image card: the picture itself, and a Markdown image for apps that take only text (never the word "Image")
  await cardEl(h, "i1").locator(".imgb").click();
  await pg.keyboard.press("Meta+c");
  // the board writes the clipboard itself (text and picture in one write, the picture's PNG made after the key press)
  const img = await until(h, "the image card's copy is on the clipboard", async () => { const c = await clipboard(h); return c && c.text !== three.text ? c : undefined; });
  check("copiedCardsGiveOtherAppsTheirContent image card gives its picture", img.types.includes("image/png") && img.png?.w === 240 && img.png?.h === 160, img);
  check("copiedCardsGiveOtherAppsTheirContent image card text is a Markdown image", img.text === "![](assets/card.png)", img.text);

  // pasted back on the board, that clipboard is still the card: a copy of the image card, not a new picture or a Note
  const before = h.board().cards.map((c) => c.id);
  await pasteClipboard(h);
  await until(h, "the paste is saved", () => h.board().cards.length > before.length); await idle(h);
  const added = h.board().cards.filter((c) => !before.includes(c.id));
  check("copiedCardsGiveOtherAppsTheirContent pasting it back gives the image card", added.length === 1 && added[0].kind === "image" && (added[0] as { src: string }).src === "card.png",
    added.map((c) => ({ kind: c.kind, src: (c as { src?: string }).src })));
  await shotTo(h, "image-copied-back", { x: 20, y: 40, width: 900, height: 700 });
  await done();
});

test("pastedCardsKeepTheirSize", async () => {
  const b = emptyBoard("b1", "sizes");
  const sched = findSym("Scheduler.schedule"), code = symCard(sched.f, sched.s);
  put(b, { id: "n1", kind: "note", md: "## Batch\n\nPrefill sequences are taken first, then decode.", look: "note" } as NoteCard, 60, 60, 430);
  b.place.n1.h = 180;
  put(b, { id: "t1", kind: "note", md: "a short Text card", look: "text" } as NoteCard, 60, 300, 210);
  put(b, code, 560, 60, 640);
  b.place[code.id].h = 200;
  put(b, { id: "i1", kind: "image", src: "card.png" } as Card, 60, 380, 300);
  b.cam = { x: 0, y: 0, z: 0.8 };
  const { h, done } = await boardWith(b);
  const pg = h.page;
  const orig = ["n1", "t1", code.id, "i1"];
  const size = (id: string) => cardEl(h, id).evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));
  const sizes0 = Object.fromEntries(await Promise.all(orig.map(async (id) => [id, await size(id)] as const)));

  await pg.mouse.click(1250, 760); // the canvas has the focus
  await pg.keyboard.press("Meta+a");
  await pg.keyboard.press("Meta+c");
  const copied = await until(h, "the copy reaches the host", () => [...h.sent].reverse().find((m) => m.type === "copyCards") as { text: string } | undefined);
  await pg.mouse.move(700, 600);
  // ⌘V: the paste event with the text the board put on the clipboard
  await pg.evaluate((t) => { const dt = new DataTransfer(); dt.setData("text/plain", t); window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, copied?.text ?? "");
  await until(h, "the paste is saved", () => h.board().cards.length > orig.length); await idle(h);
  const bd = h.board();
  const added = bd.cards.filter((c) => !orig.includes(c.id));
  const kindOf = (c: Card) => (c.kind === "note" ? c.look : c.kind);
  const pairs = orig.map((id) => {
    const o = bd.cards.find((c) => c.id === id)!, n = added.find((c) => kindOf(c) === kindOf(o));
    return { kind: kindOf(o), id: n?.id, was: { w: bd.place[id].w, h: bd.place[id].h }, now: n && { w: bd.place[n.id]?.w, h: bd.place[n.id]?.h } };
  });
  check("pastedCardsKeepTheirSize one copy of each card", added.length === 4 && pairs.every((p) => p.id), { added: added.map(kindOf) });
  check("pastedCardsKeepTheirSize stored width and height", pairs.every((p) => p.now && p.now.w === p.was.w && p.now.h === p.was.h), pairs);
  const shown = await Promise.all(pairs.filter((p) => p.id).map(async (p) => ({ kind: p.kind, was: sizes0[orig[pairs.indexOf(p)]], now: await size(p.id!) })));
  check("pastedCardsKeepTheirSize shown size", shown.length === 4 && shown.every((s) => Math.abs(s.now.w - s.was.w) <= 1 && Math.abs(s.now.h - s.was.h) <= 1), shown);
  await shotTo(h, "pasted-same-size");
  await done();
});

test("imageCardDropsIntoNote", async () => {
  const b = emptyBoard("b1", "drop");
  const md0 = "## Prefill first\n\nThe scheduler fills the batch with waiting sequences, then decodes.";
  put(b, { id: "n1", kind: "note", md: md0, look: "note" } as NoteCard, 80, 80, 420);
  put(b, { id: "i1", kind: "image", src: "card.png", desc: "Batch layout" } as Card, 640, 140, 240);
  b.cam = { x: 0, y: 0, z: 1 };
  const { h, assets, done } = await boardWith(b);
  const pg = h.page;
  const place0 = { ...h.board().place.i1 };

  // drag the picture over the Note: the Note shows where it goes, with a transition (not snapped on)
  const from = (await cardEl(h, "i1").locator(".imgb").boundingBox())!;
  const to = (await cardEl(h, "n1").locator(".nbody").boundingBox())!;
  await pg.mouse.move(from.x + 60, from.y + 40);
  await pg.mouse.down();
  for (let i = 1; i <= 14; i++) { await pg.mouse.move(from.x + 60 + ((to.x + 120 - from.x - 60) * i) / 14, from.y + 40 + ((to.y + to.height - 8 - from.y - 40) * i) / 14); await frames(pg); } // below the text: at the end
  await frames(pg, 3);
  const hover = await cardEl(h, "n1").evaluate((el) => ({ on: el.classList.contains("img-drop"), anim: getComputedStyle(el).transitionDuration, bar: getComputedStyle(el.querySelector(".cface")!, "::after").content }));
  await shotTo(h, "image-over-note", { x: 40, y: 30, width: 900, height: 500 });
  check("imageCardDropsIntoNote the Note shows the drop", hover.on && hover.anim.split(",").some((d) => parseFloat(d) > 0) && hover.bar !== "none", hover);
  await pg.mouse.up();
  const note = () => h.board().cards.find((c) => c.id === "n1") as NoteCard;
  // the host saves the picture under assets/, then the Note gets it
  await until(h, "the drop is saved", () => note().md !== md0); await idle(h);

  const files = assets().filter((f) => f !== "card.png");
  const m = /^([\s\S]*)\n\n!\[\]\((assets\/[0-9a-f]{16}-240x160\.png)\)\n\nBatch layout$/.exec(note().md);
  check("imageCardDropsIntoNote the Note gets the image", !!m && m[1] === md0 && files.length === 1 && m[2] === `assets/${files[0]}`, { md: note().md, files });
  check("imageCardDropsIntoNote the image card is gone", !h.board().cards.some((c) => c.id === "i1") && !h.board().place.i1, h.board().cards.map((c) => c.id));
  const shown = await cardEl(h, "n1").locator(".nbody img").count();
  check("imageCardDropsIntoNote the Note shows it", shown === 1, shown);
  await shotTo(h, "image-in-note", { x: 40, y: 30, width: 900, height: 620 });

  // one undo: the Note as it was and the image card back where it started
  await pg.mouse.click(1250, 760);
  await pg.keyboard.press("Meta+z");
  await until(h, "the undo is saved", () => h.board().place.i1); await idle(h);
  const back = h.board().place.i1;
  check("imageCardDropsIntoNote one undo restores both", note().md === md0 && !!back && back.x === place0.x && back.y === place0.y && back.w === place0.w, { md: note().md, back, place0 });
  await done();
});

/** #25: an image card dragged over a Note shows a line between the two blocks under the pointer, following it, and releasing puts
 *  the image there (its own paragraph), not at the end; while it hovers, the board reads no layout per pointer move */
test("imageCardDropsAtPointerInNote", async () => {
  const b = emptyBoard("b1", "drop");
  const md0 = "## Prefill first\n\nThe scheduler fills the batch with waiting sequences.\n\nThen it decodes one token per sequence.\n\nUntil every sequence is done.";
  put(b, { id: "n1", kind: "note", md: md0, look: "note" } as NoteCard, 80, 80, 420);
  put(b, { id: "i1", kind: "image", src: "card.png" } as Card, 640, 140, 240);
  b.cam = { x: 0, y: 0, z: 1 };
  const { h, assets, done } = await boardWith(b);
  const pg = h.page, note = cardEl(h, "n1");
  const paras = await note.locator(".nbody > p").evaluateAll((ps) => ps.map((p) => { const r = p.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, text: p.textContent }; }));
  const face = (await note.locator(".cface").boundingBox())!;
  /** Where the line is drawn, in screen pixels (its centre) */
  const line = () => note.locator(".cface").evaluate((el) => {
    const s = getComputedStyle(el, "::after"), r = el.getBoundingClientRect();
    return s.content === "none" ? null : r.top + parseFloat(s.translate.split(" ")[1] ?? "0") + parseFloat(s.height) / 2;
  });
  const from = (await cardEl(h, "i1").locator(".imgb").boundingBox())!;
  const x = face.x + 200;
  const gap12 = (paras[0].bottom + paras[1].top) / 2, gap23 = (paras[1].bottom + paras[2].top) / 2;
  await pg.mouse.move(from.x + 60, from.y + 40);
  await pg.mouse.down();
  // over the lower half of the second paragraph ("Then it decodes"; the heading is the card's title): the line between it and the third
  const y1 = paras[1].bottom - 3;
  for (let i = 1; i <= 14; i++) { await pg.mouse.move(from.x + 60 + ((x - from.x - 60) * i) / 14, from.y + 40 + ((y1 - from.y - 40) * i) / 14); await frames(pg); }
  await until(h, "the Note shows the drop", () => note.evaluate((el) => el.classList.contains("img-drop")));
  await idle(h);
  const at23 = await line();
  // up over its top half: the line moves to between the first paragraph and the second, without reading layout
  const reads = await pg.evaluate(() => {
    const w = window as unknown as { __reads: number };
    w.__reads = 0;
    for (const k of ["getBoundingClientRect", "getClientRects"] as const) { const f = Element.prototype[k]; (Element.prototype as any)[k] = function (this: Element) { w.__reads++; return (f as any).call(this); }; }
    return true;
  });
  const y2 = paras[1].top + 3;
  for (let i = 1; i <= 6; i++) { await pg.mouse.move(x, y1 + ((y2 - y1) * i) / 6); await frames(pg); }
  const counted = await pg.evaluate(() => (window as unknown as { __reads: number }).__reads);
  await idle(h);
  const at12 = await line();
  await pg.screenshot({ path: path.join(OUT, "25-image-drop-indicator.png"), clip: { x: face.x - 40, y: face.y - 50, width: face.width + 360, height: face.height + 120 } });
  // back down to between the second and the third, and release there
  for (let i = 1; i <= 6; i++) { await pg.mouse.move(x, y2 + ((y1 - y2) * i) / 6); await frames(pg); }
  await idle(h);
  const back = await line();
  await pg.mouse.up();
  const md = () => (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
  await until(h, "the drop is saved", () => md() !== md0); await idle(h);
  const files = assets().filter((f) => f !== "card.png");
  check("imageCardDropsAtPointerInNote the line follows the pointer between blocks", reads && at23 !== null && at12 !== null && Math.abs(at23 - gap23) < 3 && Math.abs(at12 - gap12) < 3 && back !== null && Math.abs(back - gap23) < 3, { at23, gap23, at12, gap12, back });
  check("imageCardDropsAtPointerInNote no layout reads while hovering", counted === 0, counted);
  check("imageCardDropsAtPointerInNote the image goes where it was released", files.length === 1 && md() === md0.replace("\n\nUntil every", `\n\n![](assets/${files[0]})\n\nUntil every`), { md: md(), files });
  const order = await note.locator(".nbody > *").evaluateAll((es) => es.map((e) => (e.querySelector("img") ? "[img]" : e.textContent!.slice(0, 12))));
  check("imageCardDropsAtPointerInNote shown in place", JSON.stringify(order) === JSON.stringify(["Prefill firs", "The schedule", "Then it deco", "[img]", "Until every "]), order);
  await done();
});

test("pasteAsReference", async () => {
  const b = emptyBoard("b1", "reference");
  put(b, { id: "n1", kind: "note", md: "## Prefill first\n\nThe scheduler fills the batch.", look: "note" } as NoteCard, 60, 80, 380);
  const sched = findSym("Scheduler.schedule"), code = symCard(sched.f, sched.s);
  put(b, code, 560, 80, 620);
  b.place[code.id].h = 220;
  b.cam = { x: 0, y: 0, z: 1 };
  const { h, done } = await boardWith(b);
  const pg = h.page;
  const card = (id: string) => h.board().cards.find((c) => c.id === id);
  const md = (id: string) => (card(id) as NoteCard | undefined)?.md ?? "";
  const chip = pg.locator(".pastechip");

  // ⌘C ⌘V on the same board: a copy, and the chip at its bottom-right corner with Copy picked
  await cardEl(h, "n1").locator(".chead").click();
  await pg.keyboard.press("Meta+c");
  const copied = await until(h, "the copy reaches the host", () => [...h.sent].reverse().find((m) => m.type === "copyCards") as { text: string } | undefined);
  await pg.evaluate((t) => { const dt = new DataTransfer(); dt.setData("text/plain", t); window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, copied.text);
  const id = await until(h, "the paste is saved", () => h.board().cards.find((c) => c.kind === "note" && c.id !== "n1")?.id); await idle(h);
  await chip.waitFor();
  const at = await pg.evaluate((id) => {
    const c = document.querySelector(`.card[data-id="${id}"]`)!.getBoundingClientRect(), k = document.querySelector(".pastechip")!.getBoundingClientRect();
    return { dr: Math.round(k.right - c.right), dy: Math.round(k.top - c.bottom), picked: document.querySelector(".pastechip .tbtn.on")?.textContent };
  }, id);
  check("pasteAsReference chip at the copy's bottom-right", Math.abs(at.dr) <= 2 && at.dy >= 0 && at.dy <= 16, at);
  check("pasteAsReference the paste is a copy until Reference is picked", at.picked === "Copy" && !card(id)?.same && !card("n1")?.same, at);
  await shotTo(h, "reference-chip", { x: 20, y: 40, width: 900, height: 520 });

  // Reference: one card in two places; both show the mark
  await chip.locator(".tbtn", { hasText: "Reference" }).click();
  await until(h, "the copy is the same card as the original", () => card("n1")?.same && card("n1")?.same === card(id)?.same);
  check("pasteAsReference Reference is picked on the chip", (await chip.locator(".tbtn.on").textContent()) === "Reference");
  await until(h, "both places show the mark", async () => (await pg.locator(`.card[data-id="n1"] > .twinmk, .card[data-id="${id}"] > .twinmk`).count()) === 2);
  check("pasteAsReference the mark says where", /Same card in 2 places/.test((await cardEl(h, id).locator("> .twinmk").getAttribute("data-tip")) ?? ""));

  // a click elsewhere puts the chip away
  await pg.mouse.click(1250, 760);
  await until(h, "the chip goes away", async () => !(await chip.count()));
  // the copy moves off the original (the copy lands over it), so both can be clicked
  const nh = (await cardEl(h, id).locator(".chead").boundingBox())!;
  await pg.mouse.move(nh.x + 120, nh.y + 10); await pg.mouse.down(); await pg.mouse.move(nh.x + 120, nh.y + 300, { steps: 8 }); await pg.mouse.up();
  await until(h, "the copy is moved", () => h.board().place[id].y > 300); await idle(h);

  // editing the copy changes the original (and the other way round)
  await cardEl(h, id).locator(".nbody p").last().dblclick();
  await cardEl(h, id).locator(".md-pm").waitFor();
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" Then decode.");
  for (let k = 0; k < 3 && (await pg.locator(".md-pm").count()); k++) { await pg.keyboard.press("Escape"); await idle(h); }
  await until(h, "the original follows the edit", () => md("n1").includes("Then decode.") && md(id) === md("n1"));
  check("pasteAsReference the original shows the edit", /Then decode\./.test((await cardEl(h, "n1").locator(".nbody").textContent()) ?? ""));
  await shotTo(h, "reference-pair", { x: 20, y: 40, width: 900, height: 620 });
  await cardEl(h, "n1").locator(".nbody p").last().dblclick();
  await cardEl(h, "n1").locator(".md-pm").waitFor();
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" Back.");
  for (let k = 0; k < 3 && (await pg.locator(".md-pm").count()); k++) { await pg.keyboard.press("Escape"); await idle(h); }
  await until(h, "the copy follows the original", () => md(id).includes("Back.") && md(id) === md("n1"));

  // undo takes each edit back from both places; then the move, then the Reference (two separate cards again)
  await pg.mouse.click(1250, 760);
  await pg.keyboard.press("Meta+z");
  await until(h, "undo takes the second edit back from both", () => !md("n1").includes("Back.") && !md(id).includes("Back.") && md(id).includes("Then decode."));
  await pg.keyboard.press("Meta+z");
  await until(h, "undo takes the first edit back from both", () => !md("n1").includes("Then decode.") && md(id) === md("n1"));
  await pg.keyboard.press("Meta+z"); // the move
  await until(h, "undo takes the move back", () => h.board().place[id].y < 300);
  await pg.keyboard.press("Meta+z");
  await until(h, "undo takes the Reference back", () => !card("n1")?.same && !card(id)?.same);
  await until(h, "no mark after undo", async () => !(await pg.locator(".twinmk").count()));
  await pg.keyboard.press("Meta+Shift+z");
  await until(h, "redo makes them the same card again", () => card("n1")?.same && card("n1")?.same === card(id)?.same);

  // Detach from the card menu: its own copy again; edits stay in it
  await cardEl(h, id).locator(".chead").click({ button: "right" });
  await pg.locator(".ctx button", { hasText: "Detach (Make This a Copy)" }).click();
  await until(h, "Detach makes it a copy", () => !card("n1")?.same && !card(id)?.same);
  await until(h, "no mark after Detach", async () => !(await pg.locator(".twinmk").count()));

  // a code card through ⌘D: Reference shares the original's segments; moving the copy puts the chip away
  await pg.mouse.click(1250, 760);
  await cardEl(h, code.id).locator(".chead").click({ position: { x: 200, y: 12 } });
  await pg.keyboard.press("Meta+d");
  const cid = await until(h, "the duplicate is saved", () => h.board().cards.find((c) => c.kind === "code" && c.id !== code.id)?.id); await idle(h);
  await chip.waitFor();
  await chip.locator(".tbtn", { hasText: "Reference" }).click();
  await until(h, "the code copy is the same card", () => card(code.id)?.same && card(code.id)?.same === card(cid)?.same);
  const segs = (k: string) => (card(k) as CodeCard).segments.map((s) => s.id).join();
  check("pasteAsReference code places share the original's segments", segs(cid) === segs(code.id), { copy: segs(cid), orig: segs(code.id) });
  await until(h, "the copy shows the code", async () => (await cardEl(h, cid).locator(".src .l").count()) > 3);
  const head = (await cardEl(h, cid).locator(".chead").boundingBox())!;
  await pg.mouse.move(head.x + 200, head.y + 12); await pg.mouse.down(); await pg.mouse.move(head.x + 260, head.y + 70, { steps: 6 }); await pg.mouse.up();
  await until(h, "moving the copy puts the chip away", async () => !(await chip.count()));
  await done();
});

test("pasteIntoEditorMakesNoCard", async () => {
  const b = emptyBoard("b1", "paste");
  const code = "vecAddKernel<<<ceil(n/128), 128>>>(...);";
  put(b, { id: "n1", kind: "note", md: `Blocks\n\n\`\`\`cuda\n${code}\n\`\`\`\n\nalso`, look: "note" } as NoteCard, 60, 60, 640);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 1100, h: 700 });
  const pg = h.page;
  await cardEl(h, "n1").locator(".nbody").dblclick({ position: { x: 300, y: 10 } });
  await cardEl(h, "n1").locator(".md-pm:focus").waitFor();
  // the pointer rests on empty canvas, where a pasted card would land
  await pg.mouse.move(900, 600);
  /** Select `what` in the element `sel` of the Note and paste `text`, the event sent to the element the selection starts in (as in
   *  VS Code). Returns whether that element was still on the page when the paste was done */
  const paste = (sel: string, what: string, text: string) => pg.evaluate(([sel, what, text]) => {
    const root = document.querySelector(`.card[data-id="n1"] ${sel}`)!;
    // `what` can span several highlighted spans: find where it starts and ends among the text nodes
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n as Text);
    const from = nodes.map((n) => n.data).join("").indexOf(what), to = from + what.length;
    const at = (i: number, end: boolean) => {
      let o = 0;
      for (const n of nodes) { if (end ? i <= o + n.data.length : i < o + n.data.length) return [n, i - o] as const; o += n.data.length; }
      throw new Error(`no "${what}" in ${sel}`);
    };
    const [t, ts] = at(from, false), [e, es] = at(to, true);
    const r = document.createRange();
    r.setStart(t, ts); r.setEnd(e, es);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
    return new Promise<string>((done) => requestAnimationFrame(() => setTimeout(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const el = t.parentElement!;
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      done(el.isConnected ? "kept " + el.outerHTML.slice(0, 300) : "");
    })));
  }, [sel, what, text] as const);

  // into the code block
  await cardEl(h, "n1").locator(".cm-content").click();
  await cardEl(h, "n1").locator(".cm-content:focus").waitFor();
  // the selection starts on a highlighted token, "(": the editor replaces its span
  const kept = await paste(".cm-content", "(n/128), 128", "+64");
  await expect(cardEl(h, "n1").locator(".cm-content")).toContainText("ceil+64>>>");
  check("pasteIntoEditorMakesNoCard code block: the paste target left the page", !kept, kept);
  await idle(h);
  check("pasteIntoEditorMakesNoCard code block: no new card", h.board().cards.length === 1, h.board().cards.map((c) => `${c.id}:${c.kind}`));

  // into the text
  await cardEl(h, "n1").locator(".md-pm > p").last().click();
  await cardEl(h, "n1").locator(".md-pm:focus").waitFor();
  await focusSettled(pg);
  await paste(".md-pm > p:last-of-type", "also", "too");
  await expect(cardEl(h, "n1").locator(".md-pm > p").last()).toHaveText("too");
  await idle(h);
  check("pasteIntoEditorMakesNoCard text: no new card", h.board().cards.length === 1, h.board().cards.map((c) => `${c.id}:${c.kind}`));
  await h.close();
});
