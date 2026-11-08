// Draws boards into tile pyramids with the built board in headless Chromium: the board booted as a still picture (its still
// API moves the camera, says when the view is drawn, and gives what the board covers and where its sub-board cards are), one
// screenshot per SHOT × SHOT tiles. Boards are drawn side by side, one page each in `jobs` browser contexts (each its own renderer
// process), and every shot is cut and encoded to WebP (sharp, on libvips' threads) while the page moves on to the next one
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { HostToBoard } from "@codeboard/core";
import type { BrowserContext, Page } from "playwright-core";
import sharp from "sharp";
import { launch } from "../../../tools/test/chromium.mjs";
import { drawn } from "./hash";
import { DPR, QUALITY, VIEW, isPlain, levels, rgb, shots, tileWorld, TILE, type Level } from "./tiles";

type Cam = { x: number; y: number; z: number };
type Rect = { x: number; y: number; w: number; h: number };
/** The board's still API (packages/board src/still.ts), as the page holds it */
type Layout = {
  id: string;
  name: string;
  world: Rect;
  subs: { rect: Rect; board: string }[];
  minZoom: number;
  bg: string;
};

export type Manifest = {
  id: string;
  name: string;
  world: Rect;
  tile: number;
  dpr: number;
  levels: Level[];
  bg: string;
  hits: { rect: Rect; board: string }[];
};
export type BoardTiles = { id: string; files: Map<string, Uint8Array>; shots: number; tiles: number; ms: number };
export type RenderJob = { id: string; msgs: HostToBoard[] };

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** The page, the built board under board/ and the board folder's images under assets/ */
function serve(page: string, boardDist: string, assets: string): Promise<http.Server> {
  const roots: [string, string][] = [
    ["/board/", boardDist],
    ["/assets/", assets],
  ];
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let f: string | undefined;
    if (p === "/render.html") f = page;
    for (const [pre, dir] of roots)
      if (p.startsWith(pre)) {
        const q = path.join(dir, p.slice(pre.length));
        if (q.startsWith(dir + path.sep)) f = q;
      }
    if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(f).toLowerCase()] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

/** Shots waiting to be encoded, at most n at once: a page takes its next shot only once there is room */
class Backlog {
  private busy = 0;
  private waiting: (() => void)[] = [];
  constructor(private n: number) {}
  async room() {
    while (this.busy >= this.n) await new Promise<void>((r) => this.waiting.push(r));
    this.busy++;
  }
  done() {
    this.busy--;
    this.waiting.shift()?.();
  }
}

/** A shot cut into its tiles, as WebP into out.files: the plain ones left out (the app draws the paper there) */
async function encode(
  png: Buffer,
  shot: ReturnType<typeof shots>[number],
  level: number,
  paper: number[],
  out: BoardTiles,
) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } } as const;
  await Promise.all(
    shot.tiles.map(async (t) => {
      if (isPlain(data, info.width, info.channels, t.clip, paper)) return;
      const webp = await sharp(data, raw)
        .extract({ left: t.clip.x, top: t.clip.y, width: t.clip.w, height: t.clip.h })
        .webp({ quality: QUALITY, effort: 4 })
        .toBuffer();
      out.files.set(`${level}/${t.col}_${t.row}.webp`, webp);
      out.tiles++;
    }),
  );
}

async function drawBoard(
  ctx: BrowserContext,
  base: string,
  job: RenderJob,
  backlog: Backlog,
  log: (s: string) => void,
): Promise<BoardTiles> {
  const t0 = Date.now();
  const page: Page = await ctx.newPage();
  page.on("pageerror", (e) => log(`${job.id}: page: ${e.message}`));
  const out: BoardTiles = { id: job.id, files: new Map(), shots: 0, tiles: 0, ms: 0 };
  try {
    await page.goto(`${base}/render.html`);
    await page.waitForFunction(() => (window as unknown as { __board?: unknown }).__board);
    const msgs = drawn(job.msgs);
    await page.evaluate((ms) => (window as unknown as { __deliver: (m: unknown[]) => void }).__deliver(ms), msgs);
    const view = (c: Cam) =>
      page.evaluate((c) => (window as unknown as { __board: { view(c: Cam): Promise<Cam> } }).__board.view(c), c);
    // zoomed far out first: the summary level shows, and its columns measured there are part of what the board covers
    await view({ x: 0, y: 0, z: 0.01 });
    const L = await page.evaluate(() => (window as unknown as { __board: { layout(): Layout } }).__board.layout());
    const world = tileWorld(L.world);
    const lv = levels(world);
    const paper = rgb(L.bg);
    const pending: Promise<void>[] = [];
    const cdp = await ctx.newCDPSession(page);
    for (const [i, level] of lv.entries())
      for (const s of shots(world, level)) {
        await view(s.cam);
        await backlog.room();
        // CDP's own capture: Playwright's page.screenshot encodes its PNG at full compression, a third of a shot's time
        const { data } = await cdp.send("Page.captureScreenshot", {
          format: "png",
          optimizeForSpeed: true,
          clip: { x: 0, y: 0, width: VIEW, height: VIEW, scale: DPR },
        });
        const png = Buffer.from(data, "base64");
        out.shots++;
        pending.push(encode(png, s, i, paper, out).finally(() => backlog.done()));
      }
    await Promise.all(pending);
    const manifest: Manifest = {
      id: job.id,
      name: L.name,
      world,
      tile: TILE,
      dpr: DPR,
      levels: lv,
      bg: L.bg,
      hits: L.subs.map((h) => ({ rect: h.rect, board: h.board })),
    };
    out.files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 1)));
    out.ms = Date.now() - t0;
    return out;
  } finally {
    await page.close();
  }
}

/**
 * Draws the boards, `jobs` at a time, calling done with each board's files (manifest.json and <level>/<col>_<row>.webp) as it
 * finishes. Big boards first, so the last one to start is a small one
 */
export async function renderBoards(o: {
  jobs: RenderJob[];
  boardDist: string;
  assets: string;
  page: string;
  workers: number;
  log: (s: string) => void;
  done: (b: BoardTiles) => Promise<void>;
}): Promise<void> {
  const server = await serve(o.page, o.boardDist, o.assets);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await launch();
  const size = (j: RenderJob) => JSON.stringify(j.msgs).length;
  const queue = [...o.jobs].sort((a, b) => size(b) - size(a));
  // a few shots per worker wait to be encoded: each holds a 2048 × 2048 screenshot
  const backlog = new Backlog(Math.max(2, o.workers * 2));
  try {
    await Promise.all(
      Array.from({ length: Math.min(o.workers, queue.length) }, async () => {
        const ctx = await browser.newContext({ viewport: { width: VIEW, height: VIEW }, deviceScaleFactor: DPR });
        try {
          for (let job = queue.shift(); job; job = queue.shift())
            await o.done(await drawBoard(ctx, base, job, backlog, o.log));
        } finally {
          await ctx.close();
        }
      }),
    );
  } finally {
    await browser.close();
    server.close();
  }
}
