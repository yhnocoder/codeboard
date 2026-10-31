import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type ImageCard, type NoteCard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs, png, type Rgba, saveNoteImage } from "@codeboard/host/testing";
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
  md.forEach((m, i) => put(b, { id: `n${i}`, kind: "note", md: m, look: "note" } as NoteCard, 60 + i * 600, 60, 520));
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
  // editing again: the image has its size at once (reserved from the file name), so the card doesn't jump. Entered on the text
  // after it: a double-click on the image itself puts the caret in its source, which then shows above it
  await h.page.locator('.card[data-id="n0"] .nbody p').last().dblclick();
  await h.page.locator('.card[data-id="n0"] .md-pm:focus').waitFor();
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

/** A Note's image shrinks by dragging the grip on its corner while it is selected: the width goes into the Markdown as a
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
  // the caret after the pasted image is in its source: the image shows under it, with grips. Elsewhere it is drawn alone, without
  await pg.keyboard.press("Control+Home");
  await idle(h);
  check("noteImageResize grip hidden until selected", (await pg.locator('.card[data-id="n0"] .md-pm .md-imgrip:visible').count()) === 0
    && (await pg.locator('.card[data-id="n0"] .md-pm img:not(.ProseMirror-separator)').count()) === 1);
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
  // the card's height while editing, with the caret out of the image's source (in it, the source line shows above the image)
  await pg.keyboard.press("Control+Home");
  await idle(h);
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
  // double-click on the grip: full width again, nothing written for the width. The card's height is back to fitting its content
  // first: the corner drag fixed it, and the image's source line shown while editing would push the image's grips under the
  // card's bottom edge handle
  await pg.locator('.card[data-id="n0"] .grip').dblclick();
  await idle(h);
  await editNote(h, "n0");
  const g2 = await imgGrip(h, "n0");
  await pg.mouse.dblclick(g2.x, g2.y);
  await until(h, "double-click gives the full width back", async () => (await imgFrac(h, "n0", ".md-pm")).frac > 0.99);
  await exitEdit(h);
  const reset = await imgFrac(h, "n0", ".nbody");
  check("noteImageResize double-click resets", widthIn(md(h, "n0")) === null && /!\[\]\(assets\/[^)]+\)$/.test(md(h, "n0")) && reset.frac > 0.99, { md: md(h, "n0"), reset });
  await done();
});

/** A picture with a white background (a screenshot of a page): a frame or shadow around it would show against the Note */
const PAGE_SRC = `data:image/png;base64,${screenshot(320, 180).toString("base64")}`;
/** The image's own box and the wrapper the editor puts around it: everything that could draw a frame, padding or shadow */
const frameOf = (h: Host, id: string, sel: string) => h.page.locator(`.card[data-id="${id}"] ${sel} img:not(.ProseMirror-separator)`).first().evaluate((el) => {
  const look = (e: Element) => { const cs = getComputedStyle(e); return { shadow: cs.boxShadow, border: cs.borderTopWidth + cs.borderRightWidth + cs.borderBottomWidth + cs.borderLeftWidth, padding: cs.padding, bg: cs.backgroundColor, filter: cs.filter, outline: cs.outlineStyle }; };
  const r = el.getBoundingClientRect(), frame = el.closest(".md-imgframe"), wrap = el.closest(".md-img");
  return { img: look(el), frame: frame ? look(frame) : null, wrap: wrap ? look(wrap) : null, box: { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } };
});
type Look = { shadow: string; border: string; padding: string; bg: string; filter: string; outline: string };
const bare = (l: Look | null) => !l || (l.shadow === "none" && l.border === "0px0px0px0px" && l.padding === "0px" && l.bg === "rgba(0, 0, 0, 0)" && l.filter === "none");

/** An image in a Note is drawn bare, with no hairline frame, shadow, padding or background around it, the same in the
 *  static view and in the editor; clicked, it opens its source with the image under it, the image itself bare inside its
 *  selection frame (the frame hugs the image, not its caption) with its resize grips */
test("noteImageNoFrame", async () => {
  const { h, done } = await imageHost([`Pages the scheduler hands out:\n\n![](${PAGE_SRC})\n\nOne block per sequence.`]);
  const pg = h.page;
  await idle(h);
  await imgBox(h, "n0", ".nbody");
  const disp = await frameOf(h, "n0", ".nbody");
  const r = (await pg.locator('.card[data-id="n0"]').boundingBox())!;
  await pg.screenshot({ path: path.join(OUT, "22-note-image-frame.png"), clip: { x: r.x - 20, y: r.y - 20, width: r.width + 40, height: r.height + 40 } });
  // entered on the text after it: the image is drawn alone (a double-click on it would open its source above it)
  await pg.locator('.card[data-id="n0"] .nbody p').last().dblclick();
  await pg.locator('.card[data-id="n0"] .md-pm:focus').waitFor();
  await imgBox(h, "n0", ".md-pm");
  const edit = await frameOf(h, "n0", ".md-pm");
  check("noteImageNoFrame static view", bare(disp.img), disp);
  check("noteImageNoFrame editor", bare(edit.img) && bare(edit.wrap), edit);
  check("noteImageNoFrame same in both", JSON.stringify(disp.box) === JSON.stringify(edit.box), { disp: disp.box, edit: edit.box });
  await h.page.locator('.card[data-id="n0"] .md-pm img:not(.ProseMirror-separator)').first().click();
  await pg.locator('.card[data-id="n0"] .md-pm .md-img.below .md-imgrip.r').waitFor({ state: "visible" });
  const picked = await frameOf(h, "n0", ".md-pm .md-img.below");
  check("noteImageNoFrame opened: bare, with grips", bare(picked.img) && picked.wrap?.shadow === "none" && !!picked.frame && picked.frame.shadow !== "none", picked);
  await exitEdit(h);
  await done();
});

/** Records every animation started on the page: the element's classes and the keyframes' transform or opacity */
const recordAnimations = (pg: Page) => pg.evaluate(() => {
  const w = window as unknown as { __anims: string[][] }, orig = Element.prototype.animate;
  w.__anims = [];
  Element.prototype.animate = function (this: Element, k: Keyframe[] | PropertyIndexedKeyframes | null, o?: number | KeyframeAnimationOptions) {
    w.__anims.push([this.className, (Array.isArray(k) ? k : []).map((f) => String(f.transform ?? f.opacity)).join(">")]);
    return orig.call(this, k, o);
  };
});
const animations = (pg: Page) => pg.evaluate(() => (window as unknown as { __anims: string[][] }).__anims.splice(0));
const imgSel = (open: boolean) => `.card[data-id="n0"] .md-pm .md-img${open ? ".below" : ":not(.below)"} img:not(.ProseMirror-separator)`;
const centreOf = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** A narrowed image in the editor: centred where the static render draws it, also with the caret in the paragraph after it;
 *  clicked, its source line opens with a slide (the image and what follows move instead of jumping, the source fades in) and it
 *  shows a frame on the image with the width grips centred on its sides; it can still be dragged to move it; closing slides
 *  back; with reduced motion nothing animates */
test("noteImageOpenSlidesFramed", async () => {
  const { h, done } = await imageHost([`Text above the image.\n\n![](${PAGE_SRC}){width=60%}\n\nEnd text.`]);
  const pg = h.page, card = pg.locator('.card[data-id="n0"]');
  await idle(h);
  const disp = await frameOf(h, "n0", ".nbody");
  await card.locator(".nbody p").last().dblclick();
  await card.locator(".md-pm:focus").waitFor();
  await imgBox(h, "n0", ".md-pm");
  const edit = await frameOf(h, "n0", ".md-pm");
  await recordAnimations(pg);
  await pg.locator(imgSel(false)).click();
  await pg.locator(imgSel(true)).waitFor();
  await idle(h);
  const opened = await animations(pg);
  await shot(h, "noteImageOpenSlidesFramed-selected");
  const look = await card.locator(".md-pm .md-img.below").evaluate((el) => {
    const img = el.querySelector("img")!.getBoundingClientRect(), f = el.querySelector(".md-imgframe");
    const g = [...el.querySelectorAll(".md-imgrip")].map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    return { frame: f ? getComputedStyle(f).boxShadow : null, img: { l: img.left, r: img.right, y: img.top + img.height / 2 }, g };
  });
  check("noteImageOpenSlidesFramed centred as in the static render", Math.abs(edit.box.x - disp.box.x) < 0.6 && Math.abs(edit.box.w - disp.box.w) < 0.6, { disp: disp.box, edit: edit.box });
  check("noteImageOpenSlidesFramed opening slides", opened.some(([c, k]) => /md-img below/.test(c) && /^translateY\(-?[\d.]+px\)>none$/.test(k))
    && opened.some(([c, k]) => /md-mk/.test(c) && k === "0>1"), opened);
  check("noteImageOpenSlidesFramed frame and grips", !!look.frame && look.frame !== "none" && look.g.length === 2
    && look.g.every((p) => Math.abs(p.y - look.img.y) < 1) && Math.abs(look.g[0].x - look.img.l) < 1.5 && Math.abs(look.g[1].x - look.img.r) < 1.5, look);
  // pressed and dragged while its source is open: the image moves to the end of the last paragraph
  const from = centreOf((await pg.locator(imgSel(true)).boundingBox())!), to = await afterWord(h, "n0", "text.");
  await pg.mouse.move(from.x, from.y);
  await pg.mouse.down();
  for (let i = 1; i <= 12; i++) { await pg.mouse.move(from.x + ((to.x + 1 - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12); await frames(pg); }
  await pg.mouse.up();
  await until(h, "the opened image moves to the end", async () => (await paras(h, "n0")).join("|") === "Text above the image.|End text.[img]").catch(() => null);
  const moved = await paras(h, "n0");
  check("noteImageOpenSlidesFramed opened image drags", moved.join("|") === "Text above the image.|End text.[img]", moved);
  await pg.keyboard.press("Control+z");
  await until(h, "undo puts it back", async () => (await card.locator(".md-pm > p").count()) === 3);
  // closing: the caret leaves the source, the image slides back up
  await pg.locator(imgSel(false)).click();
  await pg.locator(imgSel(true)).waitFor();
  await idle(h);
  await animations(pg);
  await pg.keyboard.press("Control+Home");
  await pg.locator(imgSel(true)).waitFor({ state: "detached" });
  await idle(h);
  const closed = await animations(pg);
  check("noteImageOpenSlidesFramed closing slides", closed.some(([c, k]) => /^md-img(?! below)/.test(c) && /^translateY\(-?[\d.]+px\)>none$/.test(k)), closed);
  await pg.emulateMedia({ reducedMotion: "reduce" });
  await pg.locator(imgSel(false)).click();
  await pg.locator(imgSel(true)).waitFor();
  await idle(h);
  const reduced = await animations(pg);
  check("noteImageOpenSlidesFramed reduced motion", reduced.length === 0, reduced);
  await exitEdit(h);
  await done();
});

/** The client point at the end of `word` in the Note's editor (where a drop puts the image between that word and the next) */
const afterWord = (h: Host, id: string, word: string) => h.page.evaluate(([id, word]) => {
  const root = document.querySelector(`.card[data-id="${id}"] .md-pm`)!, w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    const i = n.data.indexOf(word);
    if (i < 0) continue;
    const rg = document.createRange();
    rg.setStart(n, i + word.length - 1); rg.setEnd(n, i + word.length);
    const r = rg.getBoundingClientRect();
    return { x: r.right, y: r.top + r.height / 2 };
  }
  throw new Error(`no "${word}"`);
}, [id, word] as const);
/** The editor's paragraphs as shown: the text (the hidden source of a drawn image left out) and [img] for an image in it */
const paras = (h: Host, id: string) => h.page.locator(`.card[data-id="${id}"] .md-pm`).evaluate((el) => [...el.querySelectorAll(":scope > p")].map((p) => {
  const c = p.cloneNode(true) as HTMLElement;
  c.querySelectorAll(".md-hide, .md-img").forEach((e) => e.remove());
  return (c.textContent ?? "") + (p.querySelector(".md-img") ? "[img]" : "");
}));

/** While editing a Note, pressing on an image and dragging it moves it (not a copy) to where it is released, inside a
 *  paragraph too, with the drop cursor showing where; the paragraph it left goes away; the card stays put; one undo step puts it
 *  back; a click still opens the image's source and its resize grips still work */
test("noteImageDragMoves", async () => {
  const { h, done } = await imageHost([`First paragraph of text.\n\n![](${PAGE_SRC})\n\nSecond paragraph of text here.`]);
  const pg = h.page, card = pg.locator('.card[data-id="n0"]');
  const img = card.locator(".md-pm img:not(.ProseMirror-separator)").first();
  await idle(h);
  const place0 = JSON.stringify(h.board().place.n0);
  // entered on the first paragraph: the image is drawn alone, ready to drag
  await card.locator(".nbody p").first().dblclick();
  await card.locator(".md-pm:focus").waitFor();
  await imgBox(h, "n0", ".md-pm");
  const r = (await img.boundingBox())!, to = await afterWord(h, "n0", "Second");
  const from = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  await pg.mouse.move(from.x, from.y);
  await pg.mouse.down();
  for (let i = 1; i <= 12; i++) { await pg.mouse.move(from.x + ((to.x + 1 - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12); await frames(pg); }
  const caret = await until(h, "the drop cursor shows where the image goes", () => pg.locator(".md-dropcursor").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 4 ? { x: r.x, y: r.y, w: r.width, h: r.height, bg: getComputedStyle(el).backgroundColor } : null;
  }).catch(() => null));
  const mid = { place: JSON.stringify(h.board().place.n0), lifted: await card.evaluate((el) => el.classList.contains("lift")) };
  await pg.screenshot({ path: path.join(OUT, "24-note-image-mid-drag.png"), clip: { x: r.x - 60, y: r.y - 120, width: 640, height: r.height + 260 } });
  await pg.mouse.up();
  await until(h, "the image moves into the second paragraph", async () => (await card.locator(".md-pm > p").count()) === 2);
  const moved = await paras(h, "n0");
  const imgs = await card.locator(".md-pm img:not(.ProseMirror-separator)").count();
  check("noteImageDragMoves drop cursor at the release point", Math.abs(caret.x + caret.w / 2 - to.x) < 4 && Math.abs(caret.y + caret.h / 2 - to.y) < caret.h && caret.bg !== "rgba(0, 0, 0, 0)", { caret, to });
  check("noteImageDragMoves card does not move", mid.place === place0 && !mid.lifted && JSON.stringify(h.board().place.n0) === place0, { mid, place0 });
  check("noteImageDragMoves moved not copied", imgs === 1 && JSON.stringify(moved) === JSON.stringify(["First paragraph of text.", "Second paragraph of text here.[img]"]), { moved, imgs });
  // one undo puts the image back where it was (and the paragraph it left)
  await pg.keyboard.press("Control+z");
  await until(h, "undo puts the image back", async () => (await card.locator(".md-pm > p").count()) === 3);
  const undone = await paras(h, "n0");
  check("noteImageDragMoves one undo step", JSON.stringify(undone) === JSON.stringify(["First paragraph of text.", "[img]", "Second paragraph of text here."]), undone);
  await pg.keyboard.press("Control+Shift+z");
  await until(h, "redo moves it again", async () => (await card.locator(".md-pm > p").count()) === 2);
  // a click opens the image's source; the grip still resizes the image (it does not start a drag of its own)
  await img.click();
  const opened = await card.locator(".md-pm .md-img.below").count();
  check("noteImageDragMoves click opens the source", opened === 1, opened);
  const g = card.locator(".md-pm .md-imgrip.r").first();
  await g.waitFor({ state: "visible" });
  const gb = (await g.boundingBox())!;
  await pg.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await pg.mouse.down();
  for (let i = 1; i <= 8; i++) { await pg.mouse.move(gb.x + gb.width / 2 - 10 * i, gb.y + gb.height / 2 + i); await frames(pg); }
  await pg.mouse.up();
  await exitEdit(h);
  const text = md(h, "n0").replace(PAGE_SRC, "SRC");
  check("noteImageDragMoves saved", /^First paragraph of text\.\n\nSecond!\[\]\(SRC\)\{width=\d+%\} paragraph of text here\.$/.test(text), text);
  await done();
});

/** While editing a Note, an image dragged out of it and released on the board moves out of the Note into an image card
 *  there (the same file in assets/, its alt text and caption, as wide as it was drawn): the Note's Markdown loses the image and
 *  the paragraph it stood in, nothing else; ⌘Z puts it back and takes the card away in one step (what was typed before is a
 *  step of its own). Released back on its own Note outside the text, or cancelled with Esc, nothing changes. The same from the
 *  image under its opened source */
test("noteImageDragOut", async () => {
  const file = "0123456789abcdef-320x180.png", PIC = screenshot(320, 180);
  const IMG = `![Pages](assets/${file} "Block table"){width=60%}`;
  const md0 = `First paragraph of text.\n\n${IMG}\n\nSecond paragraph of text here.`;
  const h = await open({
    board: board([md0, `Some words first.\n\nBefore ${IMG} after.`]), light, w: 1240, h: 820, settings: { theme: "warm-ink" } as any, host: { assetBase: BASE },
    beforeLoad: (p) => p.route(`${BASE}/**`, (r) => r.fulfill({ body: PIC, contentType: "image/png" })),
  });
  const pg = h.page, card = pg.locator('.card[data-id="n0"]');
  const images = () => h.board().cards.filter((c) => c.kind === "image");
  const edit = async () => {
    await card.locator(".nbody p").first().dblclick();
    await card.locator(".md-pm:focus").waitFor();
  };
  /** Presses on the image `sel` in the editor and drags it to `to`, a move per frame; `end` releases it (or presses Esc first) */
  const drag = async (sel: string, to: { x: number; y: number }, end: "drop" | "esc" = "drop") => {
    const img = card.locator(sel).first();
    await pg.waitForFunction((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0, await img.elementHandle());
    const r = (await img.boundingBox())!, from = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    await pg.mouse.move(from.x, from.y);
    await pg.mouse.down();
    for (let i = 1; i <= 12; i++) { await pg.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12); await frames(pg); }
    if (end === "esc") await pg.keyboard.press("Escape");
    await pg.mouse.up();
    await frames(pg, 3);
    return r.width;
  };
  await idle(h);

  // released back on its own Note, outside the text (its title bar), and cancelled with Esc over the board: nothing changes
  await edit();
  const head = (await card.locator(".chead").first().boundingBox())!;
  await drag(".md-pm .md-img:not(.below) img", { x: head.x + head.width / 2, y: head.y + head.height / 2 });
  await drag(".md-pm .md-img:not(.below) img", { x: 640, y: 520 }, "esc");
  const kept = { cards: images().length, imgs: await card.locator(".md-pm img:not(.ProseMirror-separator)").count(), live: await card.locator(".md-pm").count() };
  await exitEdit(h);
  check("noteImageDragOut refused or cancelled changes nothing", kept.cards === 0 && kept.imgs === 1 && kept.live === 1 && md(h, "n0") === md0 && images().length === 0, { kept, md: md(h, "n0") });

  // typed, then dragged out onto the board
  await edit();
  await pg.keyboard.press("End");
  await pg.keyboard.type(" More.");
  const typed = md0.replace("of text.", "of text. More.");
  const to = { x: 640, y: 520 };
  const drawn = await drag(".md-pm .md-img:not(.below) img", to);
  await until(h, "an image card is made where the image is released", () => images().length === 1);
  await idle(h);
  await pg.screenshot({ path: path.join(OUT, "95-note-image-drag-out.png") });
  const c = images()[0] as ImageCard, p = h.board().place[c.id];
  check("noteImageDragOut card of the same image", c.src === file && c.alt === "Pages" && c.desc === "Block table", c);
  check("noteImageDragOut card where released, as wide as drawn", Math.abs(p.x - to.x) <= 2 && Math.abs(p.y - to.y) <= 2 && Math.abs(p.w - drawn) <= 2, { p, to, drawn });
  const out = { md: md(h, "n0"), imgs: await card.locator("img").count(), editing: await card.locator(".md-pm").count() };
  check("noteImageDragOut the image leaves the Note, nothing else", out.md === "First paragraph of text. More.\n\nSecond paragraph of text here." && out.imgs === 0 && out.editing === 0, out);
  await pg.keyboard.press("Control+z");
  await until(h, "one undo takes the card away", () => images().length === 0);
  check("noteImageDragOut one undo puts the image back", md(h, "n0") === typed, md(h, "n0"));
  await pg.keyboard.press("Control+z");
  await until(h, "the next undo takes the typing back", () => md(h, "n0") === md0);
  await pg.keyboard.press("Control+Shift+z");
  await pg.keyboard.press("Control+Shift+z");
  await until(h, "redo moves it out again", () => images().length === 1 && !md(h, "n0").includes(file));

  // an image in a line of text, dragged from under its opened source: only the image and the space before it go
  const card1 = pg.locator('.card[data-id="n1"]');
  await card1.locator(".nbody p").first().dblclick();
  await card1.locator(".md-pm:focus").waitFor();
  await card1.locator(".md-pm .md-img:not(.below) img").first().click();
  await card1.locator(".md-pm .md-img.below").waitFor();
  const before = images().length;
  const img1 = card1.locator(".md-pm .md-img.below img").first();
  await pg.waitForFunction((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0, await img1.elementHandle());
  const r1 = (await img1.boundingBox())!, f1 = { x: r1.x + r1.width / 2, y: r1.y + r1.height / 2 }, t1 = { x: 900, y: 600 };
  await pg.mouse.move(f1.x, f1.y);
  await pg.mouse.down();
  for (let i = 1; i <= 12; i++) { await pg.mouse.move(f1.x + ((t1.x - f1.x) * i) / 12, f1.y + ((t1.y - f1.y) * i) / 12); await frames(pg); }
  await pg.mouse.up();
  await until(h, "the image under the source drags out too", () => images().length === before + 1);
  const c2 = images().at(-1) as ImageCard;
  check("noteImageDragOut from the opened source, in a line", c2.src === file && c2.alt === "Pages" && md(h, "n1") === "Some words first.\n\nBefore after.", { c2, md: md(h, "n1") });
  await h.close();
});

/** A screenshot pasted while editing is saved to the card only when the editor closes: right-clicking it still offers Add Caption, and the caption lands on it */
test("notePastedImageCaptionWhileEditing", async () => {
  const { h, done } = await imageHost(["Before the image."]);
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await pg.keyboard.press("Control+End");
  await pg.keyboard.press("Enter");
  await pasteFiles(pg, [pngFile]);
  await imgBox(h, "n0", ".md-pm");
  check("notePastedImageCaptionWhileEditing not saved to the card yet", !md(h, "n0").includes("assets/"), md(h, "n0"));
  await pg.locator('.card[data-id="n0"] .md-pm img:not(.ProseMirror-separator)').first().click({ button: "right" });
  await pg.locator(".ctx button").first().waitFor();
  const items = await pg.locator(".ctx button .lb").allTextContents();
  check("notePastedImageCaptionWhileEditing the menu offers Add Caption", items[0] === "Add Caption…", items);
  await pg.locator(".ctx button", { hasText: "Add Caption…" }).first().click();
  await pg.locator(".dialog input").fill("Figure 1");
  await pg.keyboard.press("Enter");
  await until(h, "the caption is saved", () => md(h, "n0").includes('"Figure 1")'));
  check("notePastedImageCaptionWhileEditing the caption is on the pasted image", /^Before the image\.\n\n!\[\]\(assets\/[0-9a-f]{16}-800x450\.png "Figure 1"\)$/.test(md(h, "n0")), md(h, "n0"));
  await done();
});
