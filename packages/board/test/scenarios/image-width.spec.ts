// A new image card is as wide as the picture looks on screen, at most 381 (the new-card width); the height follows its ratio.
// "Looks": a PNG's pHYs chunk says its density (a Mac screenshot on a Retina screen is 144 dpi = 2×, 72 dpi = 1×); without it a
// screenshot pasted from the clipboard is taken at this window's devicePixelRatio, while an image copied from a web page (the
// clipboard also carries HTML) and an image file count 1×.
//   imageCardWidthFollowsShownSize   ⌘V of a 300 px and a 1000 px PNG, a 600 px Retina screenshot (144 dpi), the same picture
//                                    without pHYs at devicePixelRatio 2 (screenshot) and from a web page, and two dropped files
import * as path from "node:path";
import { png } from "@codeboard/host/testing";
import { emptyBoard, type ImageCard } from "@codeboard/core";
import { OUT, type Host } from "../harness";
import { test, open, check, light, until, idle } from "../fixtures";

const paint = (x: number, y: number): [number, number, number, number] => ((x >> 4) + (y >> 4)) % 2 ? [233, 163, 61, 255] : [250, 246, 238, 255];
const b64 = (w: number, h: number, dpi?: number) => png(w, h, paint, dpi).toString("base64");
const images = (h: Host) => h.board().cards.filter((c): c is ImageCard => c.kind === "image");

/** ⌘V on the board with a PNG on the clipboard (and HTML beside it, as a browser's Copy Image puts there) */
const paste = (h: Host, data: string, html?: string) => h.page.evaluate(({ data, html }) => {
  const dt = new DataTransfer();
  dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
  if (html) dt.setData("text/html", html);
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, { data, html });
/** A PNG file dropped from the Finder (Shift held) */
const dropFile = (h: Host, data: string, x: number, y: number) => h.page.evaluate(({ data, x, y }) => {
  const dt = new DataTransfer();
  dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
  const at = { clientX: x, clientY: y, bubbles: true, cancelable: true, dataTransfer: dt, shiftKey: true };
  const t = document.elementFromPoint(x, y)!;
  for (const type of ["dragenter", "dragover", "drop"]) t.dispatchEvent(new DragEvent(type, at));
}, { data, x, y });

/** Adds one image the way `add` does and returns its card's width and its shown box */
async function added(h: Host, add: () => Promise<unknown>) {
  const n = images(h).length;
  await add();
  const c = await until(h, "the image card is saved", () => images(h)[n]);
  await idle(h);
  const box = await h.page.locator(`.card[data-id="${c.id}"] .imgb img`).evaluate(async (e) => { const i = e as HTMLImageElement; await i.decode().catch(() => {}); const r = i.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  return { w: h.board().place[c.id].w, box };
}

test("imageCardWidthFollowsShownSize", async () => {
  const b = emptyBoard("b1", "image widths");
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1600, h: 1000 });
  const pg = h.page;
  await pg.mouse.move(200, 200);

  const small = await added(h, () => paste(h, b64(300, 200)));
  check("imageCardWidthFollowsShownSize a 300 px image stays 300", small.w === 300 && small.box.w === 300 && small.box.h === 200, small);
  const big = await added(h, () => paste(h, b64(1000, 500)));
  check("imageCardWidthFollowsShownSize a 1000 px image is 381 wide, height by its ratio", big.w === 381 && big.box.w === 381 && Math.abs(big.box.h - 190.5) <= 1, big);
  const retina = await added(h, () => paste(h, b64(600, 400, 144)));
  check("imageCardWidthFollowsShownSize a 144 dpi screenshot shows at half its pixels", retina.w === 300 && retina.box.h === 200, retina);
  const normal = await added(h, () => paste(h, b64(200, 100, 72)));
  check("imageCardWidthFollowsShownSize a 72 dpi screenshot at its pixels", normal.w === 200, normal);

  // no pHYs: a screenshot goes by the window's devicePixelRatio, a web image by 1
  await pg.evaluate(() => Object.defineProperty(window, "devicePixelRatio", { get: () => 2, configurable: true }));
  const shot2x = await added(h, () => paste(h, b64(600, 400)));
  check("imageCardWidthFollowsShownSize without pHYs a pasted screenshot uses devicePixelRatio", shot2x.w === 300, shot2x);
  const web = await added(h, () => paste(h, b64(300, 200), '<img src="https://example.test/a.png">'));
  check("imageCardWidthFollowsShownSize an image copied from a web page counts 1×", web.w === 300, web);
  // files: pHYs when there is one, else 1×
  const file2x = await added(h, () => dropFile(h, b64(600, 400, 144), 900, 600));
  const file1x = await added(h, () => dropFile(h, b64(320, 200), 900, 800));
  check("imageCardWidthFollowsShownSize a dropped 144 dpi file is halved, one without pHYs is not", file2x.w === 300 && file1x.w === 320, { file2x, file1x });
  await pg.screenshot({ path: path.join(OUT, "image-width-cards.png") });
});
