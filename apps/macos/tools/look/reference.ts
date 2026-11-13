// The reference half of the look comparison: the fixture board drawn by the real web board (the real host records what it
// sends the board, the built board draws it as a still picture in headless Chromium), in each theme, light and dark, as the
// whole board and as one crop per card at each zoom. Writes <out>/<theme>[-dark]/web-*.png and rects.json (world rects the
// Swift half crops the same way). Note content is hidden: tools/markdown/look.mjs compares that.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { HostToBoard } from "@codeboard/core";
import { recordBoards } from "../../../../packages/tiles/src/record";
import { launch } from "../../../../tools/test/chromium.mjs";

type Rect = { x: number; y: number; w: number; h: number };
type Cam = { x: number; y: number; z: number };

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Around each card's crop: room for shadows, paper edges and the start of its arrows */
export const MARGIN = 28;
/** The board's view in the whole-board picture, and the zoom every crop is drawn at */
export const VIEW = { width: 1440, height: 900 };
export const ZOOMS = [1, 2];

function serve(dir: string, boardDist: string, assets: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const f =
      p === "/page.html"
        ? path.join(dir, "page.html")
        : p.startsWith("/board/")
          ? path.join(boardDist, p.slice(7))
          : p.startsWith("/assets/")
            ? path.join(assets, p.slice(8))
            : undefined;
    if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

/** page: the folder holding page.html */
export async function reference(o: {
  storage: string;
  boardDist: string;
  page: string;
  out: string;
  themes: { look: string; dark: boolean }[];
}) {
  const rec = await recordBoards(o.storage, o.boardDist);
  const [id, msgs] = [...rec.messages][0];
  const server = await serve(o.page, o.boardDist, path.join(o.storage, "assets"));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await launch();
  try {
    for (const { look: theme, dark } of o.themes) {
      const name = dark ? `${theme}-dark` : theme;
      const dir = path.join(o.out, name);
      fs.mkdirSync(dir, { recursive: true });
      const themed = msgs.map((m): HostToBoard => {
        if (m.type !== "init") return m;
        const c = structuredClone(m);
        c.host.settings = { ...c.host.settings, theme: theme as never };
        return c;
      });
      const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.error(`${name}: page: ${e.message}`));
      await page.goto(`${base}/page.html`);
      await page.waitForFunction(() => (window as unknown as { __board?: unknown }).__board);
      // what the board's settings page does (actions/settings.ts applyLook), which a still board does not mount, and the
      // appearance as VS Code gives it (body.vscode-dark, which host.ts followHostTheme turns into html[data-theme])
      await page.evaluate(
        ([t, dk]) => {
          document.documentElement.dataset.look = t;
          document.documentElement.classList.add(`look-${t}`);
          document.body.className = dk ? "vscode-dark" : "vscode-light";
          document.documentElement.dataset.theme = dk ? "dark" : "light";
        },
        [theme, dark] as const,
      );
      await page.evaluate((ms) => (window as unknown as { __deliver: (m: unknown[]) => void }).__deliver(ms), themed);
      const view = (c: Cam) =>
        page.evaluate((c) => (window as unknown as { __board: { view(c: Cam): Promise<Cam> } }).__board.view(c), c);
      await view({ x: 0, y: 0, z: 1 });
      // what each card covers on the board, from the cards the page laid out (the camera is at 0, 0, zoom 1 here)
      const rects: Record<string, Rect> = await page.evaluate(() => {
        const out: Record<string, Rect> = {};
        for (const el of document.querySelectorAll<HTMLElement>("#board .card[data-id]")) {
          const r = el.getBoundingClientRect();
          const b = document.getElementById("board")?.getBoundingClientRect() ?? { left: 0, top: 0 };
          out[el.dataset.id ?? ""] = { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
        }
        return out;
      });
      // the whole board at 100 %, the board's own background included
      await page.screenshot({ path: path.join(dir, "web-board.png") });
      // crops on the plain canvas: Ink Wash's landscape is fixed to the window, not to the board
      await page.addStyleTag({ content: "#board { background: var(--canvas) !important; }" });
      for (const z of ZOOMS)
        for (const [card, r] of Object.entries(rects)) {
          const w = Math.ceil((r.w + 2 * MARGIN) * z);
          const h = Math.ceil((r.h + 2 * MARGIN) * z);
          await page.setViewportSize({ width: Math.max(VIEW.width, w), height: Math.max(VIEW.height, h) });
          await view({ x: -(r.x - MARGIN) * z, y: -(r.y - MARGIN) * z, z });
          await page.screenshot({ path: path.join(dir, `web-${card}@${z}.png`), clip: { x: 0, y: 0, width: w, height: h } });
        }
      fs.writeFileSync(path.join(dir, "rects.json"), JSON.stringify({ board: id, margin: MARGIN, zooms: ZOOMS, rects }, null, 1));
      await ctx.close();
      console.log(`reference ${name}: ${Object.keys(rects).length} cards`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}
