// Image files dragged onto the board, in each shape the drop takes in VS Code (a drag reaches the webview only with Shift held;
// the harness page cancels dragover / drop on the window first, as VS Code's webview wrapper does):
//   explorerImageDropMakesImageCard     from VS Code's Explorer: URIs only, every file in application/vnd.code.uri-list,
//                                       ResourceURLs and CodeFiles, the first in text/uri-list. A PNG, a JPEG and an SVG
//                                       become image cards from the drop point on, read by the host's code through Workspace
//   explorerNonImageDropIgnored         a .py file from the Explorer: no card, a toast saying only images can be dropped;
//                                       with an image beside it the image is still added
//   finderShiftDropSvgMakesImageCard    an .svg from the Finder with Shift: a File object (and its file:// URI); a cleaned
//                                       SVG image card at the drop point
//   finderShiftDropPngJpegMakesImageCards  a PNG and a JPEG from the Finder with Shift: two image cards, stored as .png / .jpg
//   finderUriOnlyDropMakesImageCard     an OS drop that carries only text/uri-list with a file:// URI outside the workspace:
//                                       the host reads it, an image card
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { emptyBoard, mimeOf, sniffImage, type Board, type ImageCard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs, nodeWorkspace, png, readImageUri, useWorkspace } from "@codeboard/host/testing";
import { OUT, shot, type Host } from "../harness";
import { test, open, check, until, idle } from "../fixtures";

const BASE = "https://cb-assets.test/res";

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160" fill="none">
  <script>try { (window.top || window).__svgScriptRan = true; } catch (e) {}</script>
  <rect x="1" y="1" width="238" height="158" rx="14" fill="#f6efe3" stroke="#3a3128" stroke-width="2"/>
  <rect x="22" y="26" width="72" height="44" rx="8" fill="#e8a33d"/>
  <rect x="146" y="26" width="72" height="44" rx="8" fill="#3d7be8"/>
  <path d="M94 48 H146" stroke="#3a3128" stroke-width="3"/>
  <circle cx="120" cy="116" r="22" fill="#5aa469"/>
</svg>
`;
/** A 320 × 200 chart-like PNG */
const PNG = png(320, 200, (x, y) => (y > 180 - ((x * 7) % 150) && x % 40 < 28 ? [61, 123, 232, 255] : [250, 246, 238, 255]));
let JPEG = Buffer.alloc(0);

/** What a drop carries: File objects (an OS drop) and string data by type */
type Shape = { files?: { name: string; type: string; b64: string }[]; data?: Record<string, string>; shift?: boolean };

/**
 * The board in Warm Ink with a host running the host's own image code: a workspace folder holding the dropped files (read by
 * readImageUri through a Node Workspace), assets/ in a temp storage folder served at BASE
 */
async function dropHost(b: Board = emptyAt()) {
  const tmp = path.join(OUT, `file-drops-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const ws = path.join(tmp, "ws"), outside = path.join(tmp, "Downloads");
  fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(ws, "docs/arch.svg"), SVG);
  fs.writeFileSync(path.join(ws, "docs/chart.png"), PNG);
  fs.writeFileSync(path.join(ws, "model.py"), "def forward(x):\n    return x\n");
  fs.writeFileSync(path.join(outside, "screen shot.png"), PNG);
  useWorkspace(nodeWorkspace(ws));
  const store = new Storage(nodeFs, { dir: () => path.join(tmp, "storage") });
  fs.mkdirSync(store.assetsDir(), { recursive: true });
  const reads: string[] = [];
  const answer = async (reply: (req: number, data?: unknown, error?: string) => Promise<void>, req: number, f: () => Promise<unknown>) => {
    try { await reply(req, await f()); } catch (e) { await reply(req, undefined, (e as Error).message); }
    return true;
  };
  const h = await open({
    board: b, light: true, w: 1240, h: 820, settings: { theme: "warm-ink" } as any, host: { assetBase: BASE },
    beforeLoad: (p) => p.route(`${BASE}/**`, (r) => {
      const name = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop()!), f = path.join(store.assetsDir(), name);
      return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: mimeOf(name) }) : r.fulfill({ status: 404 });
    }),
    on: async (m, reply) => {
      if (m.type === "saveAsset") return answer(reply, m.req!, () => store.saveAsset(m.name, m.dataUrl));
      if (m.type === "readImageUri") { reads.push(m.uri); return answer(reply, m.req!, () => readImageUri(m.uri)); }
      if (m.type === "pasteCards") return answer(reply, m.req!, async () => null);
      return false;
    },
  });
  await idle(h);
  // a real JPEG (300 x 180), from the page's canvas
  JPEG = Buffer.from((await h.page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 300; c.height = 180;
    const g = c.getContext("2d")!; g.fillStyle = "#e8a33d"; g.fillRect(0, 0, 300, 180); g.fillStyle = "#3a3128"; g.fillRect(30, 30, 120, 80);
    return c.toDataURL("image/jpeg", 0.9);
  })).split(",")[1], "base64");
  fs.writeFileSync(path.join(ws, "docs/photo.jpg"), JPEG);
  const uri = (rel: string) => pathToFileURL(path.join(ws, rel)).href;
  const assets = () => fs.readdirSync(store.assetsDir()).sort();
  const asset = (f: string) => fs.readFileSync(path.join(store.assetsDir(), f));
  return { h, ws, outside, uri, reads, assets, asset, done: async () => { await h.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

const emptyAt = () => { const b = emptyBoard("b1", "drops"); b.cam = { x: 0, y: 0, z: 1 }; return b; };
const images = (h: Host) => h.board().cards.filter((c): c is ImageCard => c.kind === "image");

/** Drags the shape over the board and drops it at (x, y), as the webview sees it: dragenter, dragover, drop on what's there */
async function drop(h: Host, x: number, y: number, s: Shape) {
  await h.page.evaluate(({ x, y, s }) => {
    const dt = new DataTransfer();
    for (const f of s.files ?? []) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    for (const [t, v] of Object.entries(s.data ?? {})) dt.setData(t, v);
    const at = { clientX: x, clientY: y, bubbles: true, cancelable: true, dataTransfer: dt, shiftKey: !!s.shift };
    const t = document.elementFromPoint(x, y)!;
    for (const type of ["dragenter", "dragover", "drop"]) t.dispatchEvent(new DragEvent(type, at));
  }, { x, y, s });
}

/** Exactly what VS Code 1.143's Explorer puts on a drag of these workspace files (fillEditorsDragData + the Explorer's CodeFiles) */
function explorerDrag(ws: string, rels: string[]): Shape {
  const uris = rels.map((r) => pathToFileURL(path.join(ws, r)).href);
  return {
    shift: true,
    data: {
      "text/plain": rels.join("\n"),
      DownloadURL: `application/octet-stream:${path.basename(rels[0])}:${uris[0]}`,
      ResourceURLs: JSON.stringify(uris),
      CodeEditors: JSON.stringify(uris.map((u) => ({ resource: u, options: {} }))),
      "text/uri-list": uris[0],
      "application/vnd.code.uri-list": uris.join("\r\n"),
      CodeFiles: JSON.stringify(rels.map((r) => path.join(ws, r))),
    },
  };
}

/** Where a card is on screen and whether its picture shows */
const cardShown = (h: Host, id: string) => h.page.locator(`.card[data-id="${id}"]`).evaluate(async (el) => {
  const img = el.querySelector(".imgb img") as HTMLImageElement | null;
  await img?.decode().catch(() => {});
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), ok: !!img && img.complete && img.naturalWidth > 0, natural: img ? [img.naturalWidth, img.naturalHeight] : [], script: !!(window as any).__svgScriptRan };
});
const toastText = (h: Host) => h.page.locator(".toast").first().textContent({ timeout: 3000 }).catch(() => null);
const kindOf = (buf: Buffer) => sniffImage(buf)?.mime ?? (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(buf.toString("utf8")) ? "image/svg+xml" : "?");

test("explorerImageDropMakesImageCard", async () => {
  const x = await dropHost();
  await drop(x.h, 120, 220, explorerDrag(x.ws, ["docs/chart.png", "docs/photo.jpg", "docs/arch.svg"]));
  const cards = await until(x.h, "three image cards", () => (images(x.h).length === 3 ? images(x.h) : undefined)).catch(() => images(x.h));
  check("explorerImageDropMakesImageCard asks the host for every file, not only text/uri-list's first", x.reads.length === 3 && x.reads.every((u) => u.startsWith("file:///")), x.reads);
  check("explorerImageDropMakesImageCard adds an image card per image", cards.length === 3, x.h.board().cards.map((c) => c.kind));
  const stored = cards.map((c) => ({ src: c.src, kind: x.assets().includes(c.src) ? kindOf(x.asset(c.src)) : "missing" }));
  check("explorerImageDropMakesImageCard stores each as its own type", stored.map((s) => s.kind).join() === "image/png,image/jpeg,image/svg+xml" && /\.png$/.test(stored[0].src) && /\.jpg$/.test(stored[1].src) && /\.svg$/.test(stored[2].src), stored);
  const first = cards[0] ? await cardShown(x.h, cards[0].id) : undefined;
  check("explorerImageDropMakesImageCard puts the first card at the drop point", !!first && Math.abs(first.x - 120) < 40 && Math.abs(first.y - 220) < 40 && first.ok && first.natural[0] === 320, first);
  const row = cards.map((c) => x.h.board().place[c.id]);
  check("explorerImageDropMakesImageCard lays them out in a row, in the dropped order", row.length === 3 && row.every((r, i) => !i || (r.x >= row[i - 1].x + row[i - 1].w && r.y === row[0].y)), row);
  const svg = cards[2] ?await cardShown(x.h, cards[2].id) : undefined;
  check("explorerImageDropMakesImageCard shows the SVG, cleaned, at its viewBox size", !!svg?.ok && svg.natural[0] === 240 && svg.natural[1] === 160 && !svg.script && !/<script/i.test(cards[2] ? x.asset(cards[2].src).toString() : "<script"), svg);
  await idle(x.h);
  await shot(x.h, "28-explorer-image-drop");
  await x.done();
});

test("explorerNonImageDropIgnored", async () => {
  const x = await dropHost();
  await drop(x.h, 420, 260, explorerDrag(x.ws, ["model.py"]));
  const toast = await toastText(x.h);
  await idle(x.h);
  check("explorerNonImageDropIgnored adds no card and says only images can be dropped", x.h.board().cards.length === 0 && x.reads.length === 0
    && /model\.py isn't an image/.test(toast ?? "") && /PNG, JPEG, GIF, WebP and SVG/.test(toast ?? ""), toast, x.h.board().cards.map((c) => c.kind), x.reads);
  await drop(x.h, 420, 260, explorerDrag(x.ws, ["model.py", "docs/chart.png"]));
  const c = await until(x.h, "the image beside the .py file is added", () => images(x.h)[0]).catch(() => undefined);
  check("explorerNonImageDropIgnored still adds the image dropped with it", !!c && x.h.board().cards.length === 1 && x.reads.length === 1, x.h.board().cards.map((k) => k.kind), x.reads);
  await x.done();
});

test("finderShiftDropSvgMakesImageCard", async () => {
  const x = await dropHost();
  const file = path.join(x.outside, "arch.svg");
  await drop(x.h, 500, 300, { shift: true, files: [{ name: "arch.svg", type: "image/svg+xml", b64: Buffer.from(SVG).toString("base64") }], data: { "text/uri-list": pathToFileURL(file).href } });
  const c = await until(x.h, "the image card is added", () => images(x.h)[0]).catch(() => undefined);
  check("finderShiftDropSvgMakesImageCard adds an image card from the File itself (not read again by URI)", !!c && x.reads.length === 0, x.h.board().cards.map((k) => k.kind), x.reads);
  const s = c ? await cardShown(x.h, c.id) : undefined;
  check("finderShiftDropSvgMakesImageCard stores a cleaned .svg", !!c && /^[0-9a-f]{16}\.svg$/.test(c.src) && !/<script/i.test(x.asset(c.src).toString()) && /width="240" height="160"|height="160"[^>]*width="240"/.test(x.asset(c.src).toString()), c?.src);
  check("finderShiftDropSvgMakesImageCard shows it at the drop point", !!s?.ok && s.natural[0] === 240 && !s.script && Math.abs(s.x - 500) < 40 && Math.abs(s.y - 300) < 40, s);
  await x.done();
});

test("finderShiftDropPngJpegMakesImageCards", async () => {
  const x = await dropHost();
  const files = [{ name: "chart.png", type: "image/png", b64: PNG.toString("base64") }, { name: "photo.jpeg", type: "image/jpeg", b64: JPEG.toString("base64") }];
  await drop(x.h, 400, 240, { shift: true, files, data: { "text/uri-list": files.map((f) => pathToFileURL(path.join(x.outside, f.name)).href).join("\r\n") } });
  const cards = await until(x.h, "two image cards", () => (images(x.h).length === 2 ? images(x.h) : undefined)).catch(() => images(x.h));
  const kinds = cards.map((c) => (x.assets().includes(c.src) ? kindOf(x.asset(c.src)) : "missing")).sort();
  check("finderShiftDropPngJpegMakesImageCards adds both", cards.length === 2, x.h.board().cards.map((k) => k.kind));
  check("finderShiftDropPngJpegMakesImageCards stores a PNG and a JPEG", kinds.join() === "image/jpeg,image/png" && cards.some((c) => /\.png$/.test(c.src)) && cards.some((c) => /\.jpg$/.test(c.src)), cards.map((c) => c.src), kinds);
  await x.done();
});

test("finderUriOnlyDropMakesImageCard", async () => {
  const x = await dropHost();
  const uri = pathToFileURL(path.join(x.outside, "screen shot.png")).href;
  await drop(x.h, 450, 280, { shift: true, data: { "text/uri-list": `# dragged from the OS\r\n${uri}` } });
  const c = await until(x.h, "the image card is added", () => images(x.h)[0]).catch(() => undefined);
  check("finderUriOnlyDropMakesImageCard reads the file outside the workspace through the host", x.reads.length === 1 && x.reads[0] === uri, x.reads);
  const s = c ? await cardShown(x.h, c.id) : undefined;
  check("finderUriOnlyDropMakesImageCard adds an image card at the drop point", !!c && /\.png$/.test(c.src) && !!s?.ok && s.natural[0] === 320 && Math.abs(s.x - 450) < 40 && Math.abs(s.y - 280) < 40, c?.src, s);
  await x.done();
});
