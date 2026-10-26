// Copying and pasting cards, and dropping an image card into a Note.
//   copiedCardsGiveOtherAppsTheirContent  ⌘C puts the cards' own text on the system clipboard (Note / Text = Markdown, code = its
//                                         lines, joined by blank lines) and, for an image card, the picture itself as image/png;
//                                         pasting that clipboard back on the board still gives the card, not a new image or Note
//   pastedCardsKeepTheirSize              ⌘C then ⌘V on the same board: every pasted card has the original's width and height
//   imageCardDropsIntoNote                dragging an image card onto a Note lights the Note up; releasing puts the image into the
//                                         Note's Markdown (saved under assets/ like a pasted image) and removes the image card, in one
//                                         undo step
// Usage: npm run harness -- copiedCardsGiveOtherAppsTheirContent pastedCardsKeepTheirSize imageCardDropsIntoNote
// Screenshots: test-out/harness/copy-paste-*.png (Warm Ink)
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type Card, type NoteCard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "@codeboard/host/nodefs";
import { readAsset, saveNoteImage } from "@codeboard/host/images";
import { png } from "@codeboard/host/test/images";
import { OUT, put, symCard, findSym, type Host } from "../harness";
import { test, open, check, until, idle, frames } from "../fixtures";

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
/** What the system clipboard holds now: its types, its text and, if there is one, the size of its PNG */
const clipboard = (h: Host) => h.page.evaluate(async () => {
  const items = await navigator.clipboard.read();
  const types = items.flatMap((i) => i.types);
  const it = items.find((i) => i.types.includes("image/png"));
  const bmp = it ? await createImageBitmap(await it.getType("image/png")) : undefined;
  return { types, text: await navigator.clipboard.readText(), png: bmp && { w: bmp.width, h: bmp.height } };
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
  const note = { id: "n1", kind: "note", md: "## Prefill first\n\nThe scheduler fills the batch with **waiting** sequences.", bg: true } as NoteCard;
  const text = { id: "t1", kind: "note", md: "then *decode*", bg: false } as NoteCard;
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
  const three = await until(h, "the copy is on the clipboard", async () => { const c = await clipboard(h); return c.text ? c : undefined; });
  const want = [note.md, text.md, code.segments[0].text.join("\n")].join("\n\n");
  check("copiedCardsGiveOtherAppsTheirContent Note, Text and code as text", three.text === want, { got: three.text.slice(0, 300), want: want.slice(0, 300) });

  // an image card: the picture itself, and a Markdown image for apps that take only text (never the word "Image")
  await cardEl(h, "i1").locator(".imgb").click();
  await pg.keyboard.press("Meta+c");
  // the board writes the clipboard itself (text and picture in one write, the picture's PNG made after the key press)
  const img = await until(h, "the image card's copy is on the clipboard", async () => { const c = await clipboard(h); return c.text !== three.text ? c : undefined; });
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
  put(b, { id: "n1", kind: "note", md: "## Batch\n\nPrefill sequences are taken first, then decode.", bg: true } as NoteCard, 60, 60, 430);
  b.place.n1.h = 180;
  put(b, { id: "t1", kind: "note", md: "a short Text card", bg: false } as NoteCard, 60, 300, 210);
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
  const kindOf = (c: Card) => (c.kind === "note" ? (c.bg ? "note" : "text") : c.kind);
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
  put(b, { id: "n1", kind: "note", md: md0, bg: true } as NoteCard, 80, 80, 420);
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
  for (let i = 1; i <= 14; i++) { await pg.mouse.move(from.x + 60 + ((to.x + 120 - from.x - 60) * i) / 14, from.y + 40 + ((to.y + 20 - from.y - 40) * i) / 14); await frames(pg); }
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
