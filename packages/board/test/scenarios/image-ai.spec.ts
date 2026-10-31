// The image tools (DeepSeek reading images), with the host's own request code (packages/host/src/imageai.ts) answered by a fake
// DeepSeek: the board sends the image, the host builds the request, and the fake answers like the API does.
//   imageAiMenus                    right-click an image card: Extract Text to Note / to Clipboard, Convert to SVG with its two check
//                                   items (they toggle without closing the menu and are saved as settings); an SVG image instead gets
//                                   Modify SVG… and Copy SVG Source
//   imageAiExtractNoteThenClip      Extract Text to Note: a Note with the Markdown next to the image, an arrow from the image, one undo;
//                                   Extract Text to Clipboard right after copies the same Markdown without asking DeepSeek again
//   imageAiConvertThenModify        Convert to SVG: a new image card with the SVG (background removed) next to the source, linked;
//                                   Modify SVG… opens a popover on the card, Enter sends the instruction and the source (thinking on)
//                                   and swaps the picture in one change, ⌘Z brings the old one back
//   imageAiNoteImage                right-click an image inside a Note: the image tools plus the Note's menu; Convert to SVG puts the
//                                   SVG in the Note in place and moves the old image out as an image card linked from the Note (one undo)
//   imageAiPasteImageText           the toolbar's Image button is a dropdown (New Image, Paste Image Text ⇧⌘V, New SVG from Text…);
//                                   Paste Image Text reads the clipboard's image into a Note in the middle of the view, with no image card
//   drawSvgFromTextMenu             Image ▾ New SVG from Text… asks for a description; while waiting an empty card with the busy layer sits
//                                   in the middle of the view (Esc cancels, the host is told); the answer becomes a cleaned SVG image card there
//   drawSvgFromNoteCard             right-click a Note: Draw as SVG (before Auto Focus) sends the card's text; the card is busy while
//                                   waiting; the SVG image card lands right of the Note with an arrow from it, one undo; Text cards have it too
//   drawSvgFromNoteSelection        a selection in a Note (shown, then while editing) + right-click: Draw as SVG sends only the selected
//                                   words; the image card lands beside the Note with an arrow
//   imageAiBusyCancelAndNoKey       waiting shows a busy layer on the card that Esc cancels (the host is told); without a key the
//                                   notice offers Set DeepSeek API Key…
import * as fs from "node:fs";
import * as path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  emptyBoard,
  mimeOf,
  type Board,
  type BoardToHost,
  type ImageAiOp,
  type ImageCard,
  type NoteCard,
} from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs, readAsset, resetImageAiCache, runImageAi, saveNoteImage } from "@codeboard/host/testing";
import { OUT, put, type Host } from "../harness";
import { test, open, check, until, idle } from "../fixtures";

const BASE = "https://cb-assets.test/res";
const SHOTS = process.env.IMAGE_AI_SHOTS;

/** A w × h PNG: a light page with a dark bar (a stand-in for a screenshot) */
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3,
        ink = y > h * 0.3 && y < h * 0.45 && x > w * 0.1 && x < w * 0.8;
      raw[o] = raw[o + 1] = raw[o + 2] = ink ? 40 : 250;
    }
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG_FILE = "aaaaaaaaaaaaaaaa-320x200.png";
const PNG_URL = `data:image/png;base64,${png(320, 200).toString("base64")}`;
const MD = "# Wave count\n\nA kernel launches $N$ blocks:\n\n$$\\lceil N / C \\rceil$$";
const SVG_SRC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160"><rect x="0" y="0" width="240" height="160" fill="#ffffff"/><rect x="20" y="30" width="120" height="40" fill="#e8a33d"/><text x="80" y="56" text-anchor="middle" font-size="14">prefill</text></svg>`;
const SVG_BLUE = SVG_SRC.replace('fill="#e8a33d"', 'fill="#3d7be8"');

type Fake = { calls: { op: ImageAiOp; body: any }[]; answer: (op: ImageAiOp) => string | "hang" | number };
/**
 * The board in Warm Ink, light, with a host that stores images in a temp assets/ folder (served at BASE) and answers imageAi with
 * the host's runImageAi on a fake DeepSeek. key: undefined = no key set
 */
async function aiHost(
  b: Board,
  answer: Fake["answer"],
  o: { key?: string | null; seed?: Record<string, Buffer | string> } = {},
) {
  const dir = path.join(OUT, `image-ai-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const store = new Storage(nodeFs, { dir: () => dir });
  fs.mkdirSync(store.assetsDir(), { recursive: true });
  fs.writeFileSync(path.join(store.assetsDir(), PNG_FILE), png(320, 200));
  for (const [f, v] of Object.entries(o.seed ?? {})) fs.writeFileSync(path.join(store.assetsDir(), f), v);
  const fake: Fake = { calls: [], answer };
  resetImageAiCache(); // the host's memory of images read lives in this worker across scenarios
  const jobs = new Map<number, AbortController>();
  // the op being asked (the fake DeepSeek only sees the request; a reused answer never reaches it)
  let asking: ImageAiOp | undefined;
  const fetchFake = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const op = asking!;
    fake.calls.push({ op, body });
    const a = fake.answer(op);
    if (a === "hang")
      return new Promise<Response>((_, rej) =>
        init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))),
      );
    if (typeof a === "number")
      return new Response(JSON.stringify({ error: { message: `status ${a}` } }), { status: a });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: a } }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  const answerReq = async (
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
  const key = o.key === null ? "" : (o.key ?? "sk-fake");
  const h = await open({
    board: b,
    light: true,
    w: 1280,
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
      if (m.type === "saveAsset") return answerReq(reply, m.req!, () => store.saveAsset(m.name, m.dataUrl));
      if (m.type === "saveImage") return answerReq(reply, m.req!, () => saveNoteImage(store, m.dataUrl));
      if (m.type === "readAsset") return answerReq(reply, m.req!, () => readAsset(store, m.file));
      if (m.type === "imageAiCancel") {
        jobs.get(m.job)?.abort();
        return true;
      }
      if (m.type === "imageAi")
        return answerReq(reply, m.req!, async () => {
          const ac = new AbortController();
          jobs.set(m.job, ac);
          asking = m.op;
          try {
            return await runImageAi({ key, fetch: fetchFake, signal: ac.signal }, m.op);
          } finally {
            jobs.delete(m.job);
          }
        });
      return false;
    },
  });
  await idle(h);
  const assets = () => fs.readdirSync(store.assetsDir()).sort();
  const asset = (f: string) => fs.readFileSync(path.join(store.assetsDir(), f), "utf8");
  return {
    h,
    fake,
    assets,
    asset,
    done: async () => {
      await h.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const board = (f: (b: Board) => void) => {
  const b = emptyBoard("b1", "images");
  b.cam = { x: 0, y: 0, z: 1 };
  f(b);
  return b;
};
const withPng = () => board((b) => put(b, { id: "i1", kind: "image", src: PNG_FILE } as ImageCard, 80, 120, 320));
const card = (h: Host, id: string) => h.board().cards.find((c) => c.id === id);
const menuLabels = (h: Host) => h.page.locator(".ctx").last().locator("button .lb").allInnerTexts();
async function rightClick(h: Host, sel: string) {
  const r = (await h.page.locator(sel).first().boundingBox())!;
  await h.page.mouse.click(r.x + r.width / 2, r.y + r.height / 2, { button: "right" });
  await h.page.locator(".ctx.open").first().waitFor();
}
const pick = (h: Host, label: string) => h.page.locator(".ctx button", { hasText: label }).first().click();
const shoot = async (h: Host, name: string) => {
  if (!SHOTS) return;
  await idle(h);
  await h.page.screenshot({ path: path.join(SHOTS, name) });
};
const sentOf = <T extends BoardToHost["type"]>(h: Host, t: T) =>
  h.sent.filter((m): m is Extract<BoardToHost, { type: T }> => m.type === t);

test("imageAiMenus", async () => {
  const { h, done } = await aiHost(
    board((b) => {
      put(b, { id: "i1", kind: "image", src: PNG_FILE } as ImageCard, 80, 120, 320);
      put(
        b,
        {
          id: "s1",
          kind: "image",
          src: `data:image/svg+xml;base64,${Buffer.from(SVG_SRC).toString("base64")}`,
        } as ImageCard,
        520,
        120,
        240,
      );
    }),
    () => "",
  );
  await rightClick(h, '.card[data-id="i1"] .imgb img');
  const png = await menuLabels(h);
  const items = h.page.locator(".ctx.open button");
  const state = async (label: string) =>
    items
      .filter({ hasText: label })
      .first()
      .evaluate((b) => ({ inset: b.classList.contains("inset"), checked: b.getAttribute("aria-checked") }));
  const bg0 = await state("Remove Background"),
    think0 = await state("Think First (slower)");
  check(
    "imageAiMenus image card items",
    png.slice(0, 5).join("|") ===
      "Extract Text to Note|Extract Text to Clipboard|Convert to SVG|Remove Background|Think First (slower)" &&
      !png.includes("Modify SVG…"),
    png,
  );
  check(
    "imageAiMenus check items under Convert to SVG: inset, Remove Background on, Think First off",
    bg0.inset && bg0.checked === "true" && think0.inset && think0.checked === "false",
    { bg0, think0 },
  );
  await shoot(h, "52-image-menu.png");
  await pick(h, "Think First (slower)");
  const think1 = await state("Think First (slower)");
  check(
    "imageAiMenus Think First toggles and the menu stays open",
    think1.checked === "true" && (await h.page.locator(".ctx.open").count()) === 1,
    think1,
  );
  check(
    "imageAiMenus Think First is saved as a setting",
    sentOf(h, "setSetting").some((m) => m.key === "svgThink" && m.value === true),
    sentOf(h, "setSetting"),
  );
  await h.page.keyboard.press("Escape");
  await rightClick(h, '.card[data-id="s1"] .imgb img');
  const svg = await menuLabels(h);
  check(
    "imageAiMenus SVG image items",
    svg.slice(0, 4).join("|") === "Modify SVG…|Extract Text to Note|Extract Text to Clipboard|Copy SVG Source" &&
      !svg.includes("Convert to SVG"),
    svg,
  );
  await shoot(h, "52-svg-menu.png");
  await pick(h, "Copy SVG Source");
  await until(h, "the SVG source is copied", () => sentOf(h, "copyText").length);
  check(
    "imageAiMenus Copy SVG Source copies the source",
    sentOf(h, "copyText")[0]?.text.includes(">prefill</text>"),
    sentOf(h, "copyText"),
  );
  await done();
});

test("imageAiExtractNoteThenClip", async () => {
  const { h, fake, done } = await aiHost(withPng(), (op) =>
    op.kind === "extract" ? "```markdown\n" + MD + "\n```" : "",
  );
  await rightClick(h, '.card[data-id="i1"] .imgb img');
  await pick(h, "Extract Text to Note");
  const note = await until(h, "a Note is made", () => h.board().cards.find((c): c is NoteCard => c.kind === "note"));
  const body = fake.calls[0]?.body;
  check(
    "imageAiExtractNoteThenClip sends the image with thinking disabled",
    fake.calls.length === 1 &&
      body?.thinking?.type === "disabled" &&
      body?.messages?.[1]?.content?.[1]?.image_url?.url?.startsWith("data:image/png;base64,"),
    { calls: fake.calls.length, thinking: body?.thinking },
  );
  const pi = h.board().place.i1,
    pn = h.board().place[note.id];
  const link = h.board().links.find((l) => l.from.card === "i1" && l.to.card === note.id);
  check("imageAiExtractNoteThenClip the Note has the Markdown", note.md === MD && note.look === "note", note.md);
  check(
    "imageAiExtractNoteThenClip the Note is right of the image, linked from it",
    pn.x >= pi.x + pi.w && Math.abs(pn.y - pi.y) < 200 && !!link,
    { pi, pn, link },
  );
  await until(h, "the formula is drawn", () => h.page.locator(`.card[data-id="${note.id}"] .katex`).count());
  await shoot(h, "52-note.png");
  await rightClick(h, '.card[data-id="i1"] .imgb img');
  await pick(h, "Extract Text to Clipboard");
  await until(h, "the Markdown is copied", () => sentOf(h, "copyText").length);
  check(
    "imageAiExtractNoteThenClip the clipboard gets the same Markdown, without a second call",
    sentOf(h, "copyText")[0].text === MD && fake.calls.length === 1,
    { copied: sentOf(h, "copyText"), calls: fake.calls.length },
  );
  await h.page.keyboard.press("Meta+z");
  await until(h, "undo removes the Note", () => !card(h, note.id));
  check(
    "imageAiExtractNoteThenClip one undo removes the Note and its arrow",
    !card(h, note.id) && !h.board().links.length && !!card(h, "i1"),
    h.board().cards.map((c) => c.id),
  );
  await done();
});

test("imageAiConvertThenModify", async () => {
  const { h, fake, asset, done } = await aiHost(withPng(), (op) =>
    op.kind === "svg" ? SVG_SRC : op.kind === "modify" ? SVG_BLUE : "",
  );
  await rightClick(h, '.card[data-id="i1"] .imgb img');
  await pick(h, "Convert to SVG");
  const svgCard = await until(h, "an SVG image card is made", () =>
    h.board().cards.find((c): c is ImageCard => c.kind === "image" && c.id !== "i1"),
  );
  const conv = fake.calls[0]?.body;
  check(
    "imageAiConvertThenModify Convert to SVG asks without thinking, with the image size",
    conv?.thinking?.type === "disabled" &&
      /The image is 320×200 pixels/.test(conv?.messages?.[1]?.content?.[0]?.text ?? ""),
    conv?.messages?.[1]?.content?.[0],
  );
  const text = /\.svg$/.test(svgCard.src) ? asset(svgCard.src) : "";
  check(
    "imageAiConvertThenModify the SVG is stored, without the background rect",
    /^[0-9a-f]{16}\.svg$/.test(svgCard.src) && text.includes("#e8a33d") && !/fill="#ffffff"/.test(text),
    { src: svgCard.src, text },
  );
  const p0 = h.board().place.i1,
    p1 = h.board().place[svgCard.id];
  check(
    "imageAiConvertThenModify the SVG card is next to the image, linked",
    p1.x >= p0.x + p0.w &&
      p1.w === p0.w &&
      h.board().links.some((l) => l.from.card === "i1" && l.to.card === svgCard.id),
    { p0, p1, links: h.board().links },
  );
  await h.page.locator(`.card[data-id="${svgCard.id}"] .imgb img`).evaluate((i) => (i as HTMLImageElement).decode());
  await rightClick(h, `.card[data-id="${svgCard.id}"] .imgb img`);
  await pick(h, "Modify SVG…");
  const ta = h.page.locator(".pop.k-modifySvg textarea");
  await ta.waitFor();
  await until(h, "the popover's field has the keyboard", () => ta.evaluate((e) => document.activeElement === e));
  await h.page.keyboard.type("Make the box blue");
  await h.page.keyboard.press("Shift+Enter");
  await h.page.keyboard.type("and keep the text");
  await shoot(h, "52-modify-popover.png");
  check(
    "imageAiConvertThenModify Shift+Enter is a new line",
    (await ta.inputValue()) === "Make the box blue\nand keep the text",
    await ta.inputValue(),
  );
  await h.page.keyboard.press("Enter");
  await until(h, "the picture is swapped", () => (card(h, svgCard.id) as ImageCard).src !== svgCard.src);
  const mod = fake.calls[1]?.body;
  check(
    "imageAiConvertThenModify Modify sends the instruction and the source, thinking with effort low",
    mod?.thinking?.type === "enabled" &&
      mod?.reasoning_effort === "low" &&
      /^Instruction: Make the box blue\nand keep the text\n\nSVG:\n<svg[\s\S]*#e8a33d/.test(
        mod?.messages?.[1]?.content ?? "",
      ),
    { thinking: mod?.thinking, content: String(mod?.messages?.[1]?.content).slice(0, 120) },
  );
  const src2 = (card(h, svgCard.id) as ImageCard).src;
  check(
    "imageAiConvertThenModify the new picture is the modified SVG, the popover closed",
    asset(src2).includes("#3d7be8") && !(await h.page.locator(".pop.k-modifySvg").count()),
    src2,
  );
  await h.page.keyboard.press("Meta+z");
  await until(
    h,
    "undo brings the old picture back",
    () => (card(h, svgCard.id) as ImageCard | undefined)?.src === svgCard.src,
  );
  check(
    "imageAiConvertThenModify one undo brings the old SVG back and keeps the card",
    (card(h, svgCard.id) as ImageCard).src === svgCard.src,
    card(h, svgCard.id),
  );
  await done();
});

test("imageAiNoteImage", async () => {
  const md0 = `Before\n\n![](assets/${PNG_FILE})\n\nAfter`;
  const { h, fake, asset, done } = await aiHost(
    board((b) => put(b, { id: "n1", kind: "note", md: md0, look: "note" } as NoteCard, 80, 100, 420)),
    (op) => (op.kind === "svg" ? SVG_SRC : MD),
  );
  await h.page.locator('.card[data-id="n1"] .nbody img').evaluate((i) => (i as HTMLImageElement).decode());
  await rightClick(h, '.card[data-id="n1"] .nbody img');
  const items = await menuLabels(h);
  check(
    "imageAiNoteImage the image tools and the Note's menu",
    items.slice(0, 4).join("|") === "Add Caption…|Extract Text to Note|Extract Text to Clipboard|Convert to SVG" &&
      items.at(-1) === "Note",
    items,
  );
  await pick(h, "Convert to SVG");
  const moved = await until(h, "the old image is a card", () =>
    h.board().cards.find((c): c is ImageCard => c.kind === "image"),
  );
  const md = (card(h, "n1") as NoteCard).md,
    svgSrc = /!\[\]\((assets\/[0-9a-f]{16}-240x160\.svg)\)/.exec(md)?.[1];
  check(
    "imageAiNoteImage the SVG replaces the image in the Note",
    !!svgSrc &&
      md === md0.replace(`assets/${PNG_FILE}`, svgSrc) &&
      asset(svgSrc.slice(7)).includes("#e8a33d") &&
      fake.calls.length === 1,
    md,
  );
  const pn = h.board().place.n1,
    pm = h.board().place[moved.id];
  check(
    "imageAiNoteImage the old image is a card next to the Note, linked from it",
    moved.src === PNG_FILE &&
      pm.x >= pn.x + pn.w &&
      h.board().links.some((l) => l.from.card === "n1" && l.to.card === moved.id),
    { moved, pm },
  );
  await h.page.keyboard.press("Meta+z");
  await until(h, "undo puts the image back", () => (card(h, "n1") as NoteCard).md === md0);
  check(
    "imageAiNoteImage one undo puts the image back and removes the card and arrow",
    (card(h, "n1") as NoteCard).md === md0 && !card(h, moved.id) && !h.board().links.length,
    h.board().cards.map((c) => c.id),
  );
  await done();
});

test("imageAiPasteImageText", async () => {
  const { h, fake, done } = await aiHost(
    board(() => {}),
    (op) => (op.kind === "extract" ? MD : ""),
  );
  await h.page.evaluate((url) => {
    const blob = () => fetch(url).then((r) => r.blob());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { ...navigator.clipboard, read: async () => [{ types: ["image/png"], getType: async () => blob() }] },
    });
  }, PNG_URL);
  await h.page.locator('.tbtn[aria-label="Image"]').click();
  await h.page.locator(".ctx.open").waitFor();
  const items = await menuLabels(h);
  const kbd = await h.page.locator(".ctx.open button", { hasText: "Paste Image Text" }).locator("small").innerText();
  check(
    "imageAiPasteImageText the Image button is a dropdown",
    items.join("|") === "New Image|Paste Image Text|New SVG from Text…" && kbd === "⇧⌘V",
    { items, kbd },
  );
  await shoot(h, "52-toolbar-image.png");
  await pick(h, "Paste Image Text");
  const note = await until(h, "a Note is made", () => h.board().cards.find((c): c is NoteCard => c.kind === "note"));
  const r = await h.page.locator(`.card[data-id="${note.id}"]`).boundingBox();
  check(
    "imageAiPasteImageText the Note has the text, in the view, and no image card",
    note.md === MD &&
      fake.calls.length === 1 &&
      h.board().cards.length === 1 &&
      !!r &&
      r.x > 0 &&
      r.x + r.width < 1280 &&
      r.y > 0 &&
      r.y < 820,
    { md: note.md, r, n: h.board().cards.length },
  );
  // ⇧⌘V does the same
  await h.page.mouse.click(1100, 700);
  await h.page.keyboard.press("Meta+Shift+KeyV");
  await until(h, "a second Note is made", () => h.board().cards.length === 2);
  check(
    "imageAiPasteImageText ⇧⌘V reads the clipboard image too (the same image: no second call)",
    h.board().cards.every((c) => c.kind === "note") && fake.calls.length === 1,
    fake.calls.length,
  );
  await done();
});

test("imageAiBusyCancelAndNoKey", async () => {
  const { h, done } = await aiHost(withPng(), () => "hang");
  await rightClick(h, '.card[data-id="i1"] .imgb img');
  await pick(h, "Extract Text to Note");
  const busy = h.page.locator('.card[data-id="i1"] .aibusy');
  await busy.waitFor();
  check(
    "imageAiBusyCancelAndNoKey the card shows it is reading",
    (await busy.innerText()).includes("Reading image…"),
    await busy.innerText(),
  );
  await h.page.keyboard.press("Escape");
  await busy.waitFor({ state: "detached" });
  await until(h, "the host is told to cancel", () => sentOf(h, "imageAiCancel").length);
  check(
    "imageAiBusyCancelAndNoKey Esc cancels: no Note, the host stops",
    h.board().cards.length === 1 && sentOf(h, "imageAiCancel").length === 1,
    h.board().cards.length,
  );
  await done();
  const k = await aiHost(withPng(), () => MD, { key: null });
  await rightClick(k.h, '.card[data-id="i1"] .imgb img');
  await pick(k.h, "Extract Text to Note");
  const act = k.h.page.locator(".toast .tlink", { hasText: "Set DeepSeek API Key…" });
  await act.waitFor();
  check(
    "imageAiBusyCancelAndNoKey without a key the notice says so",
    (await k.h.page.locator(".toast").innerText()).includes("No DeepSeek API key"),
    await k.h.page.locator(".toast").innerText(),
  );
  await act.click();
  await until(k.h, "the host is asked to set the key", () => sentOf(k.h, "aiKey").length);
  check(
    "imageAiBusyCancelAndNoKey Set DeepSeek API Key… asks the host",
    sentOf(k.h, "aiKey")
      .map((m) => m.action)
      .join() === "set" && k.h.board().cards.length === 1,
    k.h.sent.map((m) => m.type),
  );
  await k.done();
});

/** What the model draws: a background rect (removed: Remove Background is on by default), a script and a handler (cleaned away) */
const DRAWN =
  "Here it is:\n\n```svg\n" +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 200" onload="alert(1)"><defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="#333"/></marker></defs><rect x="0" y="0" width="480" height="200" fill="#ffffff"/><script>alert(2)</script><rect x="30" y="70" width="150" height="56" rx="8" fill="#f6e3bf" stroke="#333"/><text x="105" y="104" text-anchor="middle" font-size="16" font-family="system-ui, sans-serif">prefill</text><line x1="180" y1="98" x2="290" y2="98" stroke="#333" stroke-width="2" marker-end="url(#ah)"/><rect x="300" y="70" width="150" height="56" rx="8" fill="#d9e8f6" stroke="#333"/><text x="375" y="104" text-anchor="middle" font-size="16" font-family="system-ui, sans-serif">decode</text></svg>` +
  "\n```";
const drawOps = (f: Fake) =>
  f.calls.map((c) => c.op).filter((o): o is Extract<ImageAiOp, { kind: "draw" }> => o.kind === "draw");
const images = (h: Host) => h.board().cards.filter((c): c is ImageCard => c.kind === "image");
/** The new image card holds the cleaned SVG (stored as an asset, no script / handler / background rect) and is as wide as its viewBox */
function checkDrawn(name: string, h: Host, img: ImageCard | undefined, asset: (f: string) => string) {
  const text = img && /^[0-9a-f]{16}\.svg$/.test(img.src) ? asset(img.src) : "";
  check(
    `${name} the image card holds the cleaned SVG`,
    text.includes(">prefill</text>") &&
      text.includes(">decode</text>") &&
      !/script|onload|alert/i.test(text) &&
      !/fill="#ffffff"/.test(text) &&
      h.board().place[img!.id]?.w === 480,
    { src: img?.src, text: text.slice(0, 200), w: img && h.board().place[img.id]?.w },
  );
}

test("drawSvgFromTextMenu", async () => {
  let reply = "hang";
  const { h, fake, asset, done } = await aiHost(
    board(() => {}),
    () => reply,
  );
  const ask = async (desc: string) => {
    await h.page.locator('.tbtn[aria-label="Image"]').click();
    await h.page.locator(".ctx.open").waitFor();
    await pick(h, "New SVG from Text…");
    await h.page.locator(".dialog input").waitFor();
    await h.page.keyboard.type(desc);
    await h.page.keyboard.press("Enter");
  };
  await ask("prefill then decode, as two boxes");
  const ghost = h.page.locator(".aighost .aibusy");
  await ghost.waitFor();
  const g = (await h.page.locator(".aighost").boundingBox())!;
  check(
    "drawSvgFromTextMenu an empty card with the busy layer sits in the middle of the view",
    (await ghost.innerText()).includes("Drawing SVG…") &&
      Math.abs(g.x + g.width / 2 - 640) < 4 &&
      Math.abs(g.y + g.height / 2 - 410) < 4 &&
      g.width >= 300,
    { text: await ghost.innerText(), g },
  );
  await until(h, "the model is asked", () => drawOps(fake).length);
  check(
    "drawSvgFromTextMenu sends the description as a draw request",
    drawOps(fake)[0]?.text === "prefill then decode, as two boxes" &&
      drawOps(fake)[0]?.noBg === true &&
      fake.calls[0].body.messages[1].content.includes("<text>\nprefill then decode, as two boxes\n</text>"),
    drawOps(fake),
  );
  if (SHOTS) await h.page.screenshot({ path: path.join(SHOTS, "64-new-svg-busy.png") }); // still waiting on the host: no idle
  await h.page.keyboard.press("Escape");
  await ghost.waitFor({ state: "detached" });
  await until(h, "the host is told to cancel", () => sentOf(h, "imageAiCancel").length);
  check(
    "drawSvgFromTextMenu Esc cancels: no card, the host stops",
    !h.board().cards.length && sentOf(h, "imageAiCancel").length === 1,
    h.board().cards.length,
  );
  reply = DRAWN;
  await ask("prefill then decode, again");
  const img = await until(h, "an SVG image card is made", () => images(h)[0]);
  checkDrawn("drawSvgFromTextMenu", h, img, asset);
  await h.page.locator(`.card[data-id="${img.id}"] .imgb img`).evaluate((i) => (i as HTMLImageElement).decode());
  const r = (await h.page.locator(`.card[data-id="${img.id}"]`).boundingBox())!;
  check(
    "drawSvgFromTextMenu the image card is in the middle of the view, the busy card gone",
    Math.abs(r.x + r.width / 2 - 640) < 40 &&
      r.y > 0 &&
      r.y + r.height < 820 &&
      !(await h.page.locator(".aighost").count()),
    r,
  );
  await shoot(h, "64-new-svg-done.png");
  await done();
});

test("drawSvgFromNoteCard", async () => {
  const md = "## Serving loop\n\nThe **scheduler** picks requests, runs *prefill*, then decodes token by token.";
  let reply = "hang";
  const { h, fake, asset, done } = await aiHost(
    board((b) => {
      put(b, { id: "n1", kind: "note", md, look: "note" } as NoteCard, 80, 120, 380);
      put(b, { id: "t1", kind: "note", md: "a ring of four GPUs", look: "text" } as NoteCard, 80, 520, 260);
    }),
    () => reply,
  );
  await rightClick(h, '.card[data-id="n1"] .nbody');
  const items = await menuLabels(h);
  check(
    "drawSvgFromNoteCard the Note's menu has Draw as SVG right before Auto Focus",
    items.indexOf("Draw as SVG") > 0 && items.indexOf("Draw as SVG") === items.indexOf("Auto Focus") - 1,
    items,
  );
  await shoot(h, "64-note-menu.png");
  await pick(h, "Draw as SVG");
  const busy = h.page.locator('.card[data-id="n1"] .aibusy');
  await busy.waitFor();
  check(
    "drawSvgFromNoteCard the Note is busy with a Cancel while waiting",
    (await busy.innerText()).includes("Drawing SVG…") &&
      (await busy.locator("button", { hasText: "Cancel" }).count()) === 1,
    await busy.innerText(),
  );
  await until(h, "the model is asked", () => drawOps(fake).length);
  check("drawSvgFromNoteCard sends the card's whole text", drawOps(fake)[0]?.text === md, drawOps(fake));
  await busy.locator("button", { hasText: "Cancel" }).click();
  await busy.waitFor({ state: "detached" });
  await until(h, "the host is told to cancel", () => sentOf(h, "imageAiCancel").length);
  check(
    "drawSvgFromNoteCard Cancel stops it: no image",
    !images(h).length,
    h.board().cards.map((c) => c.id),
  );
  reply = DRAWN;
  await rightClick(h, '.card[data-id="n1"] .nbody');
  await pick(h, "Draw as SVG");
  const img = await until(h, "an SVG image card is made", () => images(h)[0]);
  checkDrawn("drawSvgFromNoteCard", h, img, asset);
  const pn = h.board().place.n1,
    pi = h.board().place[img.id];
  check(
    "drawSvgFromNoteCard the image is right of the Note, with an arrow from the Note",
    pi.x >= pn.x + pn.w &&
      Math.abs(pi.y - pn.y) < 200 &&
      h.board().links.some((l) => l.from.card === "n1" && l.to.card === img.id),
    { pn, pi, links: h.board().links },
  );
  await h.page.locator(`.card[data-id="${img.id}"] .imgb img`).evaluate((i) => (i as HTMLImageElement).decode());
  await shoot(h, "64-note-drawn.png");
  // an ordinary SVG image: Modify SVG… works on it
  await rightClick(h, `.card[data-id="${img.id}"] .imgb img`);
  check(
    "drawSvgFromNoteCard the drawn image has the SVG tools",
    (await menuLabels(h))[0] === "Modify SVG…",
    await menuLabels(h),
  );
  await h.page.keyboard.press("Escape");
  await h.page.keyboard.press("Meta+z");
  await until(h, "undo removes the image", () => !images(h).length);
  check(
    "drawSvgFromNoteCard one undo removes the image and its arrow",
    !h.board().links.length && !!card(h, "n1"),
    h.board().cards.map((c) => c.id),
  );
  await rightClick(h, '.card[data-id="t1"] .cface');
  check(
    "drawSvgFromNoteCard Text cards have Draw as SVG too",
    (await menuLabels(h)).includes("Draw as SVG"),
    await menuLabels(h),
  );
  await done();
});

test("drawSvgFromNoteSelection", async () => {
  const md =
    "Prefill fills the KV cache for the prompt.\n\nDecode then appends one token per step to every running sequence.";
  const { h, fake, asset, done } = await aiHost(
    board((b) => put(b, { id: "n1", kind: "note", md, look: "note" } as NoteCard, 80, 120, 420)),
    () => DRAWN,
  );
  /** Selects `words` inside the Note's shown text or its editor (the first text node that has them); the middle of the selection */
  const select = (root: string, words: string) =>
    h.page.locator(`.card[data-id="n1"] ${root}`).evaluate((el, w) => {
      const it = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = it.nextNode(); n; n = it.nextNode()) {
        const i = n.textContent!.indexOf(w);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + w.length);
        const s = getSelection()!;
        s.removeAllRanges();
        s.addRange(r);
        const b = r.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      return null;
    }, words);
  const rightAt = async (p: { x: number; y: number }) => {
    await h.page.mouse.click(p.x, p.y, { button: "right" });
    await h.page.locator(".ctx.open").first().waitFor();
  };
  // a selection in the shown Note
  const p1 = await select(".nbody", "appends one token per step");
  await rightAt(p1!);
  const items = await menuLabels(h);
  check(
    "drawSvgFromNoteSelection the selection menu: Draw as SVG, then the Note's menu",
    items[0] === "Draw as SVG" && items.at(-1) === "Note",
    items,
  );
  await shoot(h, "64-selection-menu.png");
  await pick(h, "Draw as SVG");
  const img = await until(h, "an SVG image card is made", () => images(h)[0]);
  check(
    "drawSvgFromNoteSelection sends only the selected words",
    drawOps(fake).length === 1 && drawOps(fake)[0].text === "appends one token per step",
    drawOps(fake),
  );
  checkDrawn("drawSvgFromNoteSelection", h, img, asset);
  const pn = h.board().place.n1,
    pi = h.board().place[img.id];
  check(
    "drawSvgFromNoteSelection the image is beside the Note, with an arrow from it",
    pi.x >= pn.x + pn.w && h.board().links.some((l) => l.from.card === "n1" && l.to.card === img.id),
    { pn, pi },
  );
  // a selection while editing the Note
  await h.page.locator('.card[data-id="n1"] .nbody').dblclick();
  await h.page.locator('.card[data-id="n1"] .md-pm:focus').waitFor();
  const p2 = await select(".md-pm", "the KV cache");
  await until(h, "the editor has the selection", () =>
    h.page.evaluate(() => getSelection()?.toString() === "the KV cache"),
  );
  await rightAt(p2!);
  check(
    "drawSvgFromNoteSelection while editing, a selection gets Draw as SVG",
    (await menuLabels(h))[0] === "Draw as SVG",
    await menuLabels(h),
  );
  await pick(h, "Draw as SVG");
  await until(h, "a second image card is made", () => images(h).length === 2);
  const img2 = images(h).find((c) => c.id !== img.id)!;
  check(
    "drawSvgFromNoteSelection while editing, only the selected words are sent; the image is linked from the Note",
    drawOps(fake)[1]?.text === "the KV cache" &&
      h.board().links.some((l) => l.from.card === "n1" && l.to.card === img2.id) &&
      h.board().place[img2.id].x >= pn.x + pn.w,
    { ops: drawOps(fake), links: h.board().links },
  );
  await done();
});
