// SVG pictures, every way an image gets onto the board or into a Note. They stay SVG (vector, crisp at any zoom) and are only ever
// shown through <img>, where an SVG's scripts don't run and it loads nothing from outside.
//   svgFileDropMakesImageCard            dropping a .svg file on the board gives an image card showing it, stored as .svg
//   svgFilePasteMakesImageCard           ⌘V of a copied .svg file: the same
//   svgMarkupPasteMakesImageCard         ⌘V of SVG markup (Figma "Copy as SVG", a code editor) or of image/svg+xml data: an image card
//   svgAddImageButtonMakesImageCard      the toolbar's Image ▾ New Image with an .svg picked (the host answers its data: URL): the same,
//                                        for an SVG with only a viewBox too (stored with the size the viewBox gives)
//   svgPasteIntoNote                     ⌘V of a .svg file while editing a Note: assets/<sha1>-<w>x<h>.svg in the Markdown, shown sized
//   svgDropIntoNote                      dropping a .svg file (one with only a viewBox) into a Note being edited: the same
//   svgMarkupPasteIntoNote               ⌘V of SVG markup while editing a Note: the picture, not the markup as text
//   svgImageCardDropsIntoNoteStaysSvg    an SVG image card dragged into a Note goes in as the same SVG, not a PNG drawn from it
//   svgImagesInHtmlExport                an HTML snapshot carries an SVG image card's and a Note's SVG as SVG data, and shows both offline
//   svgImageInPngExport                  a PNG export draws an SVG image card (the board's assets/ pictures are inlined first)
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, mimeOf, type Board, type Card, type ImageCard, type NoteCard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { inlineFor, nodeFs, readAsset, saveNoteImage, setMediaDir } from "@codeboard/host/testing";
import { OUT, REPO, put, shot, type Host } from "../harness";
import { test, open, check, until, idle, frames, focusSettled } from "../fixtures";

const BASE = "https://cb-assets.test/res";

/** A 240 × 160 vector diagram, as a design tool exports it (XML prolog, a comment). Its script must never run: it would set a flag */
const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: a design tool -->
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160" fill="none">
  <script>try { (window.top || window).__svgScriptRan = true; } catch (e) {}</script>
  <rect x="1" y="1" width="238" height="158" rx="14" fill="#f6efe3" stroke="#3a3128" stroke-width="2"/>
  <rect x="22" y="26" width="72" height="44" rx="8" fill="#e8a33d"/>
  <rect x="146" y="26" width="72" height="44" rx="8" fill="#3d7be8"/>
  <path d="M94 48 H146" stroke="#3a3128" stroke-width="3"/><path d="M138 41 L146 48 L138 55" stroke="#3a3128" stroke-width="3"/>
  <circle cx="120" cy="116" r="22" fill="#5aa469"/>
  <text x="58" y="53" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#fff">prefill</text>
  <text x="182" y="53" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#fff">decode</text>
</svg>
`;
/** The same drawing with only a viewBox (icon sets, many exports): no size of its own in an <img> until one is written in */
const SVG_VIEWBOX = SVG.replace(' width="240" height="160"', "");
/** A stored file is the drawing, still vector, cleaned: no script, every shape and text kept, and a size of its own */
const isCleanSvg = (text: string) =>
  /^<svg [^>]*width="240" height="160"|^<svg [^>]*height="160"[^>]*width="240"/.test(text) &&
  !/<script/i.test(text) &&
  (text.match(/<rect /g) ?? []).length === 3 &&
  (text.match(/<path /g) ?? []).length === 2 &&
  />prefill<\/text>/.test(text) &&
  />decode<\/text>/.test(text);

/** The board in Warm Ink with a host that runs the host's own code for images: assets/ in a temp storage folder, served at BASE
 *  with the type its extension gives (as VS Code serves webview resources), saveAsset / saveImage / readAsset, and the Image
 *  button's file dialog answering the picked .svg the way the host reads it */
async function svgHost(b: Board, seed: Record<string, string> = {}) {
  const dir = path.join(OUT, `svg-images-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const store = new Storage(nodeFs, { dir: () => dir });
  fs.mkdirSync(store.assetsDir(), { recursive: true });
  for (const [f, text] of Object.entries(seed)) fs.writeFileSync(path.join(store.assetsDir(), f), text);
  const exported: string[] = [];
  const answer = async (
    reply: (req: number, data?: unknown, error?: string) => Promise<void>,
    req: number,
    f: () => Promise<unknown>,
  ) => {
    try {
      await reply(req, await f());
    } catch (e) {
      await reply(req, undefined, (e as Error).message);
    }
    return true;
  };
  const h = await open({
    board: b,
    light: true,
    w: 1240,
    h: 820,
    settings: { theme: "warm-ink" } as any,
    host: { assetBase: BASE },
    beforeLoad: (p) =>
      p.route(`${BASE}/**`, (r) => {
        const name = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop()!),
          f = path.join(store.assetsDir(), name);
        return fs.existsSync(f)
          ? r.fulfill({ body: fs.readFileSync(f), contentType: mimeOf(name) })
          : r.fulfill({ status: 404 });
      }),
    on: async (m, reply) => {
      if (m.type === "saveAsset") return answer(reply, m.req!, () => store.saveAsset(m.name, m.dataUrl));
      if (m.type === "saveImage") return answer(reply, m.req!, () => saveNoteImage(store, m.dataUrl));
      if (m.type === "readAsset") return answer(reply, m.req!, () => readAsset(store, m.file));
      if (m.type === "pickFile")
        return answer(
          reply,
          m.req!,
          async () => `data:image/svg+xml;base64,${Buffer.from(SVG_VIEWBOX).toString("base64")}`,
        );
      if (m.type === "pasteCards") return answer(reply, m.req!, async () => null);
      if (m.type === "exportFile")
        return answer(reply, m.req!, async () => {
          exported.push(await inlineFor(store, m.text));
          return true;
        });
      return false;
    },
  });
  await idle(h);
  const assets = () => fs.readdirSync(store.assetsDir()).sort();
  const asset = (f: string) => fs.readFileSync(path.join(store.assetsDir(), f), "utf8");
  return {
    h,
    assets,
    asset,
    exported,
    done: async () => {
      await h.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const emptyAt = () => {
  const b = emptyBoard("b1", "svg");
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
};
const withNote = (md: string) => {
  const b = emptyAt();
  put(b, { id: "n1", kind: "note", md, look: "note" } as NoteCard, 80, 80, 460);
  return b;
};
const images = (h: Host) => h.board().cards.filter((c): c is ImageCard => c.kind === "image");
const noteMd = (h: Host) => ((h.board().cards.find((c) => c.id === "n1") as NoteCard | undefined)?.md ?? "").trim();

/** How an <img> came out: decoded with a size of its own, how big on screen, and whether the SVG's script ran */
const shown = (h: Host, sel: string) =>
  h.page
    .locator(sel)
    .first()
    .evaluate(async (el) => {
      const img = el as HTMLImageElement;
      await img.decode().catch(() => {});
      const r = img.getBoundingClientRect();
      return {
        ok: img.complete && img.naturalWidth > 0,
        natural: [img.naturalWidth, img.naturalHeight],
        w: Math.round(r.width),
        h: Math.round(r.height),
        src: img.getAttribute("src"),
        script: !!(window as any).__svgScriptRan,
      };
    });

/** A new image card is on the board: one file in assets/, which is the SVG itself (not a PNG drawn from it), and the card shows it */
async function expectSvgCard(h: Host, assets: () => string[], asset: (f: string) => string, name: string) {
  const c = await until(h, "the image card is added", () => images(h)[0], 5000).catch(() => undefined);
  const files = assets();
  const img = c ? await shown(h, `.card[data-id="${c.id}"] .imgb img`) : undefined;
  check(
    `${name} adds an image card`,
    !!c,
    h.board().cards.map((x) => x.kind),
  );
  check(
    `${name} stores the SVG as .svg`,
    !!c && /^[0-9a-f]{16}\.svg$/.test(c.src) && files.length === 1 && files[0] === c.src && isCleanSvg(asset(files[0])),
    { src: c?.src, files, text: files[0] && asset(files[0]) },
  );
  check(
    `${name} shows the picture at its size`,
    !!img?.ok && img.natural[0] === 240 && img.natural[1] === 160 && Math.abs(img.w / img.h - 1.5) < 0.02,
    img,
  );
  check(`${name} never runs the SVG's script`, !img?.script, img);
  return c;
}

async function pasteOnBoard(h: Host, data: { file?: boolean; types?: Record<string, string> }) {
  await h.page.mouse.move(420, 300);
  await h.page.evaluate(
    ({ svg, file, types }) => {
      const dt = new DataTransfer();
      if (file) dt.items.add(new File([svg], "diagram.svg", { type: "image/svg+xml" }));
      for (const [t, v] of Object.entries(types ?? {})) dt.setData(t, v);
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { svg: SVG, file: data.file, types: data.types },
  );
}

test("svgFileDropMakesImageCard", async () => {
  const { h, assets, asset, done } = await svgHost(emptyAt());
  await h.page.evaluate((svg) => {
    const dt = new DataTransfer();
    dt.items.add(new File([svg], "diagram.svg", { type: "image/svg+xml" }));
    const at = { clientX: 420, clientY: 300, bubbles: true, cancelable: true, dataTransfer: dt };
    const t = document.elementFromPoint(420, 300)!;
    t.dispatchEvent(new DragEvent("dragover", at));
    t.dispatchEvent(new DragEvent("drop", at));
  }, SVG);
  await expectSvgCard(h, assets, asset, "svgFileDropMakesImageCard");
  await idle(h);
  await shot(h, "18-svg-file-drop");
  await done();
});

test("svgFilePasteMakesImageCard", async () => {
  const { h, assets, asset, done } = await svgHost(emptyAt());
  await pasteOnBoard(h, { file: true });
  await expectSvgCard(h, assets, asset, "svgFilePasteMakesImageCard");
  await idle(h);
  await shot(h, "18-svg-file-paste");
  await done();
});

test("svgMarkupPasteMakesImageCard", async () => {
  const { h, assets, asset, done } = await svgHost(emptyAt());
  await pasteOnBoard(h, { types: { "text/plain": SVG } });
  const c = await expectSvgCard(h, assets, asset, "svgMarkupPasteMakesImageCard markup as text");
  await idle(h);
  await shot(h, "18-svg-markup-paste");
  // the same picture as image/svg+xml data (no text): another card with the same file
  await pasteOnBoard(h, { types: { "image/svg+xml": SVG } });
  const two = await until(h, "the second image card is added", () =>
    images(h).length === 2 ? images(h) : undefined,
  ).catch(() => images(h));
  check(
    "svgMarkupPasteMakesImageCard image/svg+xml data",
    two.length === 2 && two[1].src === c?.src && assets().length === 1 && h.board().cards.length === 2,
    { cards: h.board().cards.map((x) => x.kind), files: assets() },
  );
  await done();
});

test("svgAddImageButtonMakesImageCard", async () => {
  const { h, assets, asset, done } = await svgHost(emptyAt());
  await h.page.locator('.tbtn[aria-label="Image"]').click();
  await h.page.locator(".ctx.open button", { hasText: "New Image" }).click();
  await expectSvgCard(h, assets, asset, "svgAddImageButtonMakesImageCard");
  await idle(h);
  await shot(h, "18-svg-add-image-button");
  await done();
});

async function editNote(h: Host) {
  await h.page.locator('.card[data-id="n1"] .nbody').dblclick();
  await h.page.locator('.card[data-id="n1"] .md-pm:focus').waitFor();
  await focusSettled(h.page); // ProseMirror's focus timers would put the double-click's caret back over Control+End
  await h.page.keyboard.press("Control+End");
  await h.page.keyboard.press("Enter");
}
async function exitEdit(h: Host) {
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) {
    await h.page.keyboard.press("Escape");
    await idle(h);
  }
}
/** The Note's Markdown ends with the SVG as a sized assets/ image, that file is the SVG itself, and the Note shows it (no image card) */
async function expectSvgInNote(
  h: Host,
  assets: () => string[],
  asset: (f: string) => string,
  name: string,
  md0: string,
) {
  await until(h, "the image is in the Note", () => noteMd(h) !== md0).catch(() => {});
  const md = noteMd(h),
    files = assets();
  const m = /!\[\]\(assets\/([0-9a-f]{16}-240x160\.svg)\)$/.exec(md);
  const img = m ? await shown(h, '.card[data-id="n1"] .nbody img') : undefined;
  check(
    `${name} puts the SVG in the Markdown`,
    !!m && md.startsWith(md0) && files.length === 1 && files[0] === m[1] && isCleanSvg(asset(files[0])),
    { md, files, text: files[0] && asset(files[0]) },
  );
  check(
    `${name} shows the picture`,
    !!img?.ok && img.natural[0] === 240 && img.w > 100 && Math.abs(img.w / img.h - 1.5) < 0.02 && !img.script,
    img,
  );
  check(
    `${name} makes no card`,
    h.board().cards.length === 1,
    h.board().cards.map((c) => c.kind),
  );
}

test("svgPasteIntoNote", async () => {
  const md0 = "**Prefill, then decode.**";
  const { h, assets, asset, done } = await svgHost(withNote(md0));
  await editNote(h);
  await h.page.evaluate((svg) => {
    const dt = new DataTransfer();
    dt.items.add(new File([svg], "diagram.svg", { type: "image/svg+xml" }));
    document.activeElement!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, SVG);
  await until(h, "the image is in the editor", () =>
    h.page.locator('.card[data-id="n1"] .md-pm img:not(.ProseMirror-separator)').count(),
  ).catch(() => {});
  await exitEdit(h);
  await expectSvgInNote(h, assets, asset, "svgPasteIntoNote", md0);
  await shot(h, "18-svg-paste-into-note");
  await done();
});

test("svgDropIntoNote", async () => {
  const md0 = "Drop here:";
  const { h, assets, asset, done } = await svgHost(withNote(md0));
  await h.page.locator('.card[data-id="n1"] .nbody').dblclick();
  await h.page.locator('.card[data-id="n1"] .md-pm:focus').waitFor();
  await h.page.evaluate((svg) => {
    const p = document.querySelector('.card[data-id="n1"] .md-pm p')!,
      r = p.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.items.add(new File([svg], "diagram.svg", { type: "image/svg+xml" }));
    const at = {
      clientX: r.right - 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    };
    p.dispatchEvent(new DragEvent("dragover", at));
    p.dispatchEvent(new DragEvent("drop", at));
  }, SVG_VIEWBOX);
  await until(h, "the image is in the editor", () =>
    h.page.locator('.card[data-id="n1"] .md-pm img:not(.ProseMirror-separator)').count(),
  ).catch(() => {});
  await exitEdit(h);
  await expectSvgInNote(h, assets, asset, "svgDropIntoNote", md0);
  await shot(h, "18-svg-drop-into-note");
  await done();
});

test("svgMarkupPasteIntoNote", async () => {
  const md0 = "Pasted from a design tool:";
  const { h, assets, asset, done } = await svgHost(withNote(md0));
  await editNote(h);
  await h.page.evaluate((svg) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", svg);
    document.activeElement!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, SVG);
  await until(h, "the image is in the editor", () =>
    h.page.locator('.card[data-id="n1"] .md-pm img:not(.ProseMirror-separator)').count(),
  ).catch(() => {});
  await exitEdit(h);
  await expectSvgInNote(h, assets, asset, "svgMarkupPasteIntoNote", md0);
  check("svgMarkupPasteIntoNote leaves no markup in the text", !noteMd(h).includes("<svg"), noteMd(h));
  await shot(h, "18-svg-markup-paste-into-note");
  await done();
});

test("svgImageCardDropsIntoNoteStaysSvg", async () => {
  const md0 = "## Prefill first\n\nThe scheduler fills the batch, then decodes.";
  const b = withNote(md0);
  const card = "0123456789abcdef.svg";
  put(b, { id: "i1", kind: "image", src: card } as Card, 640, 140, 240);
  const { h, assets, asset, done } = await svgHost(b, { [card]: SVG });
  const pg = h.page;
  await shown(h, '.card[data-id="i1"] .imgb img');
  const from = (await pg.locator('.card[data-id="i1"] .imgb').boundingBox())!;
  const to = (await pg.locator('.card[data-id="n1"] .nbody').boundingBox())!;
  await pg.mouse.move(from.x + 60, from.y + 40);
  await pg.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await pg.mouse.move(
      from.x + 60 + ((to.x + 120 - from.x - 60) * i) / 14,
      from.y + 40 + ((to.y + to.height - 8 - from.y - 40) * i) / 14,
    );
    await frames(pg);
  } // below the text: at the end
  await pg.mouse.up();
  await until(h, "the drop is saved", () => noteMd(h) !== md0).catch(() => {});
  await idle(h);
  const md = noteMd(h),
    files = assets().filter((f) => f !== card);
  const m = /\n\n!\[\]\(assets\/([0-9a-f]{16}-240x160\.svg)\)$/.exec(md);
  const img = m ? await shown(h, '.card[data-id="n1"] .nbody img') : undefined;
  check(
    "svgImageCardDropsIntoNoteStaysSvg the Note gets the SVG",
    !!m && md.startsWith(md0) && files.length === 1 && files[0] === m[1] && isCleanSvg(asset(files[0])),
    { md, files, text: files[0] && asset(files[0]) },
  );
  check(
    "svgImageCardDropsIntoNoteStaysSvg the Note shows it",
    !!img?.ok && img.natural[0] === 240 && !img.script && !h.board().cards.some((c) => c.id === "i1"),
    img,
  );
  await shot(h, "18-svg-image-card-into-note");
  await done();
});

test("svgImagesInHtmlExport", async () => {
  setMediaDir(path.join(REPO, "extensions/vscode/media/board"));
  const md0 = "**Prefill, then decode.**";
  const { h, exported, done } = await svgHost(withNote(md0));
  const pg = h.page;
  await pg.locator('.tbtn[aria-label="Image"]').click();
  await pg.locator(".ctx.open button", { hasText: "New Image" }).click();
  await until(h, "the image card is added", () => images(h)[0]);
  await editNote(h);
  await pg.evaluate((svg) => {
    const dt = new DataTransfer();
    dt.items.add(new File([svg], "diagram.svg", { type: "image/svg+xml" }));
    document.activeElement!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, SVG);
  await until(h, "the image is in the editor", () =>
    pg.locator('.card[data-id="n1"] .md-pm img:not(.ProseMirror-separator)').count(),
  );
  await exitEdit(h);
  await until(h, "the image is in the Note", () => noteMd(h) !== md0);
  await pg.locator('.bbar [aria-label="More"]').click();
  await pg.locator(".ctx button", { hasText: "Export…" }).click();
  await pg.locator(".xdlg").waitFor();
  await pg.locator(".xdlg .seg button", { hasText: "HTML Snapshot" }).click();
  await pg.locator(".xdlg .seg button", { hasText: "Whole Board" }).click();
  await pg.locator(".xdlg button.def").click();
  const html = await until(h, "the snapshot is written", () => exported[0], 20000);
  const svgs = (html.match(/<img\b[^>]*src="data:image\/svg\+xml;base64,/g) ?? []).length;
  check("svgImagesInHtmlExport both pictures are SVG data", svgs === 2 && !html.includes("cbres:"), {
    svgs,
    cbres: (html.match(/cbres:[^"]*/g) ?? []).slice(0, 4),
  });
  const file = path.join(OUT, "svg-images-export.html");
  fs.writeFileSync(file, html);
  const v = await pg.context().browser()!.newPage();
  await v.setViewportSize({ width: 1240, height: 820 });
  await v.goto(`file://${file}`);
  await v.waitForFunction(() => document.querySelectorAll(".world .card[data-id]").length === 2);
  const pics = await v.locator(".world img").evaluateAll(async (els) =>
    Promise.all(
      els.map(async (e) => {
        const i = e as HTMLImageElement;
        await i.decode().catch(() => {});
        return [i.naturalWidth, i.naturalHeight];
      }),
    ),
  );
  check(
    "svgImagesInHtmlExport the snapshot shows both",
    pics.length === 2 && pics.every(([w, hh]) => w === 240 && hh === 160),
    pics,
  );
  await v.close();
  await done();
});

test("svgImageInPngExport", async () => {
  const { h, done } = await svgHost(emptyAt());
  const pg = h.page;
  await pg.locator('.tbtn[aria-label="Image"]').click();
  await pg.locator(".ctx.open button", { hasText: "New Image" }).click();
  await until(h, "the image card is added", () => images(h)[0]);
  await idle(h);
  await pg.locator('.bbar [aria-label="More"]').click();
  await pg.locator(".ctx button", { hasText: "Export…" }).click();
  await pg.locator(".xdlg").waitFor();
  await pg.locator(".xdlg .seg button", { hasText: "PNG" }).click();
  await pg.locator(".xdlg button.def").click();
  const sent = await until(
    h,
    "the PNG is sent",
    () => h.sent.find((x): x is Extract<typeof x, { type: "exportPng" }> => x.type === "exportPng"),
    20000,
  );
  fs.writeFileSync(
    path.join(OUT, "18-svg-png-export.png"),
    Buffer.from(sent.dataUrl.replace(/^data:[^,]*,/, ""), "base64"),
  );
  // the drawing's orange and blue boxes are in the picture (the image card alone fills the export, at twice the size)
  const px = await pg.evaluate(async (u) => {
    const img = new Image();
    img.src = u;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let orange = 0,
      blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 0xe8) < 12 && Math.abs(d[i + 1] - 0xa3) < 12 && Math.abs(d[i + 2] - 0x3d) < 12) orange++;
      if (Math.abs(d[i] - 0x3d) < 12 && Math.abs(d[i + 1] - 0x7b) < 12 && Math.abs(d[i + 2] - 0xe8) < 12) blue++;
    }
    return { w: cv.width, h: cv.height, orange, blue };
  }, sent.dataUrl);
  check("svgImageInPngExport the picture is drawn", px.orange > 5000 && px.blue > 5000, px);
  await done();
});
