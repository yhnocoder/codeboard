import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "@codeboard/host/nodefs";
import { saveNoteImage } from "@codeboard/host/images";
import { png, type Rgba } from "@codeboard/host/test/images";
import type { Page } from "playwright-core";
import { OUT, put, shot, type Host } from "../harness";
import { test, open, check, light, until, idle, frames } from "../fixtures";

const BASE = "https://cb-assets.test/res";

/** A window screenshot: title bar with three dots, a sidebar and lines of "text" */
function screenshot(w: number, h: number): Buffer {
  const dot = (x: number, y: number, cx: number, c: Rgba): Rgba | null => ((x - cx) ** 2 + (y - 14) ** 2 <= 36 ? c : null);
  return png(w, h, (x, y) => {
    if (y < 28) return dot(x, y, 18, [255, 95, 87, 255]) ?? dot(x, y, 38, [254, 188, 46, 255]) ?? dot(x, y, 58, [40, 200, 64, 255]) ?? [228, 226, 222, 255];
    if (x < 150) return y % 26 > 8 && y % 26 < 16 && x > 16 && x < 110 + (y % 52 ? 0 : -30) ? [150, 150, 160, 255] : [242, 240, 236, 255];
    const row = Math.floor((y - 40) / 22), inRow = (y - 40) % 22;
    const len = 520 - ((row * 97) % 260);
    if (y > 40 && inRow > 6 && inRow < 14 && x > 180 && x < 180 + len) return row % 5 === 0 ? [70, 110, 200, 255] : [60, 60, 70, 255];
    return [255, 255, 255, 255];
  });
}
const PNG = screenshot(800, 450);

function board(md: string[]): Board {
  const b = emptyBoard("b1", "note images");
  md.forEach((m, i) => put(b, { id: `n${i}`, kind: "note", md: m, bg: true } as NoteCard, 60 + i * 600, 60, 520));
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

/** The board with a host that saves images with the host's code into a temp storage folder and serves assets/ at BASE */
async function imageHost(md: string[]) {
  const dir = path.join(OUT, `note-images-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const store = new Storage(nodeFs, { dir: () => dir });
  const saves: string[] = [];
  const h = await open({
    board: board(md), light, w: 1240, h: 820, settings: { theme: "warm-ink" } as any, host: { assetBase: BASE },
    beforeLoad: (p) => p.route(`${BASE}/**`, (r) => {
      const f = path.join(store.assetsDir(), decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop()!));
      return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: "image/png" }) : r.fulfill({ status: 404 });
    }),
    on: async (m, reply) => {
      if (m.type !== "saveImage") return false;
      saves.push(m.dataUrl.slice(0, 30));
      try { await reply(m.req!, await saveNoteImage(store, m.dataUrl)); } catch (e) { await reply(m.req!, undefined, (e as Error).message); }
      return true;
    },
  });
  const assets = () => (fs.existsSync(store.assetsDir()) ? fs.readdirSync(store.assetsDir()) : []);
  return { h, saves, assets, done: async () => { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const md = (h: Host, id: string) => ((h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.md ?? "").trim();
async function editNote(h: Host, id: string) {
  await h.page.locator(`.card[data-id="${id}"] .nbody`).dblclick();
  await h.page.locator(`.card[data-id="${id}"] .md-pm:focus`).waitFor();
}
async function exitEdit(h: Host) {
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) { await h.page.keyboard.press("Escape"); await idle(h); }
}
/** Paste files (bytes, type, name) into the focused editor, as the clipboard of a screenshot does */
async function pasteFiles(pg: Page, files: { b64: string; type: string; name: string }[]) {
  await pg.evaluate((fs) => {
    const dt = new DataTransfer();
    for (const f of fs) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, files);
}
const pngFile = { b64: PNG.toString("base64"), type: "image/png", name: "image.png" };
/** The image in the card, once decoded: its box on screen, and whether it carries width / height (space reserved before decoding) */
async function imgBox(h: Host, id: string, sel: string) {
  const img = h.page.locator(`.card[data-id="${id}"] ${sel} img:not(.ProseMirror-separator)`).first();
  await img.waitFor({ timeout: 5000 });
  await h.page.waitForFunction((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0, await img.elementHandle(), { timeout: 5000 });
  return img.evaluate((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, sized: el.hasAttribute("width") && el.hasAttribute("height"), src: el.getAttribute("src"), lazy: el.getAttribute("loading") === "lazy" }; });
}
const cardH = (h: Host, id: string) => h.page.locator(`.card[data-id="${id}"]`).evaluate((el) => (el as HTMLElement).offsetHeight);

/** Paste a screenshot into a Note: one file in assets/, ![](assets/…) in the Markdown, the same size while editing and after */
test("notePastedImageSameSizeInBothModes", async () => {
  const { h, saves, assets, done } = await imageHost(["**Prefill before decode.** The scheduler fills the batch with waiting sequences first:"]); // no title heading: display mode hides that one
  await idle(h);
  await editNote(h, "n0");
  await h.page.keyboard.press("Control+End");
  await h.page.keyboard.press("Enter");
  await pasteFiles(h.page, [pngFile]);
  const edit = await imgBox(h, "n0", ".md-pm");
  await h.page.keyboard.press("Enter");
  await h.page.keyboard.type("Then decode runs one token per sequence.");
  await shot(h, "26-note-image-edit");
  const editH = await cardH(h, "n0");
  await exitEdit(h);
  const disp = await imgBox(h, "n0", ".nbody");
  const dispH = await cardH(h, "n0");
  await shot(h, "26-note-image-display");
  const text = md(h, "n0"), files = assets();
  const ref = /\n\n!\[\]\((assets\/[0-9a-f]{16}-800x450\.png)\)\n\nThen decode/.exec(text);
  check("notePastedImageSaved", saves.length === 1 && files.length === 1 && !!ref && ref[1] === `assets/${files[0]}` && !text.includes("base64"), { saves, files, text });
  check("notePastedImageSrcResolved", edit.src === `${BASE}/${files[0]}` && disp.src === edit.src && disp.sized && edit.sized && disp.lazy, { edit, disp });
  // the Note body is 520 wide minus padding: the 800-pixel screenshot is scaled to it, keeping 16:9
  check("notePastedImageFitsWidth", edit.w < 520 && Math.abs(edit.h / edit.w - 450 / 800) < 0.01, edit);
  check("notePastedImageSameSize", Math.abs(edit.w - disp.w) < 0.6 && Math.abs(edit.h - disp.h) < 0.6, { edit, disp });
  // editing again: the image has its size at once (reserved from the file name), so the card doesn't jump
  await editNote(h, "n0");
  const again = await h.page.locator('.card[data-id="n0"] .md-pm img:not(.ProseMirror-separator)').first().evaluate((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; });
  const againH = await cardH(h, "n0");
  check("notePastedImageNoJump", Math.abs(again.w - disp.w) < 0.6 && Math.abs(again.h - disp.h) < 0.6 && Math.abs(againH - dispH) <= 2 && Math.abs(editH - dispH) <= 2, { again, disp, editH, dispH, againH });
  await exitEdit(h);
  await done();
});

/** ⌘Z right after a paste takes the image out and nothing else (the typing before it stays); redo puts it back */
test("notePasteImageIsOneUndoStep", async () => {
  const { h, done } = await imageHost([""]);
  await idle(h);
  await editNote(h, "n0");
  await h.page.keyboard.type("before ");
  await pasteFiles(h.page, [pngFile]);
  await imgBox(h, "n0", ".md-pm");
  const imgs = () => h.page.locator('.card[data-id="n0"] .md-pm img:not(.ProseMirror-separator)').count();
  const text = () => h.page.locator('.card[data-id="n0"] .md-pm').innerText();
  await h.page.keyboard.press("Control+z");
  await until(h, "undo takes the pasted image out", async () => (await imgs()) === 0);
  const afterUndo = { imgs: await imgs(), text: (await text()).trim() };
  await h.page.keyboard.press("Control+Shift+z");
  await until(h, "redo puts the image back", async () => (await imgs()) === 1);
  const afterRedo = await imgs();
  await h.page.keyboard.press("Control+z");
  await until(h, "undo takes the image out again", async () => (await imgs()) === 0);
  await exitEdit(h);
  check("notePasteImageIsOneUndoStep", afterUndo.imgs === 0 && afterUndo.text === "before" && afterRedo === 1 && md(h, "n0") === "before", { afterUndo, afterRedo, md: md(h, "n0") });
  await done();
});

/** An image file dropped onto the Note being edited goes into the Note (not a new Image card on the board) */
test("noteDropImageFileInserts", async () => {
  const { h, saves, done } = await imageHost(["Drop here:"]);
  await idle(h);
  await editNote(h, "n0");
  const cards0 = h.board().cards.length;
  await h.page.evaluate((f) => {
    const p = document.querySelector('.card[data-id="n0"] .md-pm p')!, r = p.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], "drop.png", { type: "image/png" }));
    const at = { clientX: r.right - 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, dataTransfer: dt };
    p.dispatchEvent(new DragEvent("dragover", at));
    p.dispatchEvent(new DragEvent("drop", at));
  }, pngFile);
  const box = await imgBox(h, "n0", ".md-pm");
  await exitEdit(h);
  const text = md(h, "n0");
  check("noteDropImageFileInserts", saves.length === 1 && /^Drop here:\s*!\[\]\(assets\/[0-9a-f]{16}-800x450\.png\)$/.test(text) && h.board().cards.length === cards0 && box.sized, { saves, text, cards0, cards: h.board().cards.length });
  await done();
});

/** A file that says it is a PNG but isn't: the host refuses it, the board says why, nothing is inserted or written */
test("noteNonImagePasteRefused", async () => {
  const { h, assets, done } = await imageHost(["keep"]);
  await idle(h);
  await editNote(h, "n0");
  await pasteFiles(h.page, [{ b64: Buffer.from("<html><body><script>alert(1)</script></body></html>").toString("base64"), type: "image/png", name: "fake.png" }]);
  const toast = await h.page.locator(".toast").first().innerText({ timeout: 3000 }); // the host's refusal
  const imgs = await h.page.locator('.card[data-id="n0"] .md-pm img:not(.ProseMirror-separator)').count();
  await exitEdit(h);
  check("noteNonImagePasteRefused", /PNG, JPEG, WebP, GIF and SVG/.test(toast) && imgs === 0 && md(h, "n0") === "keep" && assets().length === 0, { toast, imgs, md: md(h, "n0"), assets: assets() });
  await done();
});

/** The image's width as a fraction of its paragraph (the Note body's width), on screen, and how far its centre is off the paragraph's */
const imgFrac = (h: Host, id: string, sel: string) => h.page.locator(`.card[data-id="${id}"] ${sel} img:not(.ProseMirror-separator)`).first().evaluate((el) => {
  const p = el.closest("p")!, r = el.getBoundingClientRect(), pr = p.getBoundingClientRect(), cs = getComputedStyle(p);
  const k = pr.width / p.offsetWidth, inner = (p.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) * k;
  return { frac: Math.round((r.width / inner) * 1000) / 1000, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, off: Math.round((r.left + r.width / 2 - (pr.left + pr.width / 2)) * 10) / 10 };
});
const widthIn = (text: string) => { const m = /\)\{width=(\d+(?:\.\d+)?)%\}/.exec(text); return m ? +m[1] : null; };
/** Click the image in the editor (selects it), take the screenshot `name` if given, and give the centre of its left or right resize grip */
async function imgGrip(h: Host, id: string, name?: string, side: "l" | "r" = "r") {
  await h.page.locator(`.card[data-id="${id}"] .md-pm img:not(.ProseMirror-separator)`).first().click();
  if (name) await shot(h, name);
  const g = h.page.locator(`.card[data-id="${id}"] .md-pm .md-imgrip.${side}`).first();
  await g.waitFor({ state: "visible", timeout: 3000 });
  const r = (await g.boundingBox())!;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
/** A pointer drag by dx (and a little down), each move in a frame of its own */
async function dragBy(h: Host, at: { x: number; y: number }, dx: number, steps = 10) {
  await h.page.mouse.move(at.x, at.y);
  await h.page.mouse.down();
  for (let i = 1; i <= steps; i++) { await h.page.mouse.move(at.x + (dx * i) / steps, at.y + (Math.abs(dx) * 0.3 * i) / steps); await frames(h.page); }
  await h.page.mouse.up();
}

/** #17: a Note's image shrinks by dragging the grip on its corner while it is selected: the width goes into the Markdown as a
 *  percentage of the body ({width=N%}), centered, the same in the static render, scales with the card, one undo step per drag;
 *  either side's grip changes the width around the centre, and a double-click on a grip gives the full width back */
test("noteImageResize", async () => {
  const { h, done } = await imageHost(["A figure of the grid:"]);
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await pg.keyboard.press("Control+End");
  await pg.keyboard.press("Enter");
  await pasteFiles(pg, [pngFile]);
  await imgBox(h, "n0", ".md-pm");
  const full = await imgFrac(h, "n0", ".md-pm");
  check("noteImageResize full width at first", full.frac > 0.99, full);
  check("noteImageResize grip hidden until selected", (await pg.locator('.card[data-id="n0"] .md-pm .md-imgrip:visible').count()) === 0);
  const g = await imgGrip(h, "n0", "17-note-image-selected");
  const place0 = JSON.stringify(h.board().place.n0);
  await dragBy(h, g, -full.w * 0.35);
  await until(h, "the drag shrinks the image", async () => (await imgFrac(h, "n0", ".md-pm")).frac < 0.4);
  const right = await imgFrac(h, "n0", ".md-pm");
  // the left grip, dragged outwards by a tenth of the body: the image grows by a fifth, still centered
  const gl = await imgGrip(h, "n0", undefined, "l");
  await dragBy(h, gl, -full.w * 0.1);
  await until(h, "the left grip widens the image", async () => (await imgFrac(h, "n0", ".md-pm")).frac > right.frac + 0.1);
  const edit = await imgFrac(h, "n0", ".md-pm");
  await shot(h, "17-note-image-resized-edit");
  // one undo step per drag: ⌘Z takes back the second drag, again the first (full width); redo puts both back
  const frac = async () => (await imgFrac(h, "n0", ".md-pm")).frac;
  await pg.keyboard.press("Control+z");
  await until(h, "undo takes back the left grip's drag", async () => Math.abs((await frac()) - right.frac) < 0.01);
  await pg.keyboard.press("Control+z");
  await until(h, "undo again gives the full width back", async () => (await frac()) > 0.99);
  await pg.keyboard.press("Control+Shift+z");
  await pg.keyboard.press("Control+Shift+z");
  await until(h, "redo puts both drags back", async () => Math.abs((await frac()) - edit.frac) < 0.01);
  const editH = await cardH(h, "n0");
  await exitEdit(h);
  const text = md(h, "n0"), w = widthIn(text);
  const disp = await imgFrac(h, "n0", ".nbody"), dispH = await cardH(h, "n0");
  await shot(h, "17-note-image-resized");
  check("noteImageResize card stays put", JSON.stringify(h.board().place.n0) === place0, { before: place0, after: h.board().place.n0 });
  check("noteImageResize width saved", w !== null && Math.abs(w / 100 - edit.frac) < 0.012 && w > 40 && w < 60, { text, edit });
  check("noteImageResize right grip shrinks around the centre", Math.abs(right.frac - 0.3) < 0.015 && Math.abs(right.off) < 1, right);
  check("noteImageResize left grip grows around the centre", Math.abs(edit.frac - right.frac - 0.2) < 0.015, { right, edit });
  check("noteImageResize centered", Math.abs(edit.off) < 1 && Math.abs(disp.off) < 1, { edit, disp });
  check("noteImageResize same size in both modes", Math.abs(edit.w - disp.w) < 0.6 && Math.abs(edit.h - disp.h) < 0.6 && Math.abs(editH - dispH) <= 2, { edit, disp, editH, dispH });
  // a wider card: the image keeps its share of the body
  const c = (await pg.locator('.card[data-id="n0"] .grip').boundingBox())!;
  await dragBy(h, { x: c.x + c.width / 2, y: c.y + c.height / 2 }, 240);
  await idle(h);
  const wide = await imgFrac(h, "n0", ".nbody");
  check("noteImageResize scales with the card", wide.w > disp.w + 80 && Math.abs(wide.frac - disp.frac) < 0.01 && widthIn(md(h, "n0")) === w, { disp, wide });
  // double-click on the grip: full width again, nothing written for the width
  await editNote(h, "n0");
  const g2 = await imgGrip(h, "n0");
  await pg.mouse.dblclick(g2.x, g2.y);
  await until(h, "double-click gives the full width back", async () => (await imgFrac(h, "n0", ".md-pm")).frac > 0.99);
  await exitEdit(h);
  check("noteImageResize double-click resets", widthIn(md(h, "n0")) === null && /!\[\]\(assets\/[^)]+\)$/.test(md(h, "n0")) && (await imgFrac(h, "n0", ".nbody")).frac > 0.99, { md: md(h, "n0") });
  await done();
});

/** A picture with a white background (a screenshot of a page): a frame or shadow around it would show against the Note */
const PAGE_SRC = `data:image/png;base64,${screenshot(320, 180).toString("base64")}`;
/** The image's own box and the wrapper the editor puts around it: everything that could draw a frame, padding or shadow */
const frameOf = (h: Host, id: string, sel: string) => h.page.locator(`.card[data-id="${id}"] ${sel} img:not(.ProseMirror-separator)`).first().evaluate((el) => {
  const look = (e: Element) => { const cs = getComputedStyle(e); return { shadow: cs.boxShadow, border: cs.borderTopWidth + cs.borderRightWidth + cs.borderBottomWidth + cs.borderLeftWidth, padding: cs.padding, bg: cs.backgroundColor, filter: cs.filter, outline: cs.outlineStyle }; };
  const r = el.getBoundingClientRect();
  return { img: look(el), wrap: el.parentElement!.classList.contains("md-img") ? look(el.parentElement!) : null, box: { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } };
});
type Look = { shadow: string; border: string; padding: string; bg: string; filter: string; outline: string };
const bare = (l: Look | null) => !l || (l.shadow === "none" && l.border === "0px0px0px0px" && l.padding === "0px" && l.bg === "rgba(0, 0, 0, 0)" && l.filter === "none");

/** #22: an image in a Note is drawn bare, with no hairline frame, shadow, padding or background around it, the same in the
 *  static view and in the editor; the editor still outlines the image while it is selected */
test("noteImageNoFrame", async () => {
  const { h, done } = await imageHost([`Pages the scheduler hands out:\n\n![](${PAGE_SRC})\n\nOne block per sequence.`]);
  const pg = h.page;
  await idle(h);
  await imgBox(h, "n0", ".nbody");
  const disp = await frameOf(h, "n0", ".nbody");
  const r = (await pg.locator('.card[data-id="n0"]').boundingBox())!;
  await pg.screenshot({ path: path.join(OUT, "22-note-image-frame.png"), clip: { x: r.x - 20, y: r.y - 20, width: r.width + 40, height: r.height + 40 } });
  await editNote(h, "n0");
  await imgBox(h, "n0", ".md-pm");
  const edit = await frameOf(h, "n0", ".md-pm");
  check("noteImageNoFrame static view", bare(disp.img), disp);
  check("noteImageNoFrame editor", bare(edit.img) && bare(edit.wrap), edit);
  check("noteImageNoFrame same in both", JSON.stringify(disp.box) === JSON.stringify(edit.box), { disp: disp.box, edit: edit.box });
  await h.page.locator('.card[data-id="n0"] .md-pm img:not(.ProseMirror-separator)').first().click();
  await pg.locator('.card[data-id="n0"] .md-pm .md-img.ProseMirror-selectednode').waitFor();
  const picked = await frameOf(h, "n0", ".md-pm");
  check("noteImageNoFrame selection outline kept", picked.wrap?.outline === "solid" && picked.wrap.shadow === "none", picked.wrap);
  await exitEdit(h);
  await done();
});
