import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sniffImage, type StickerPack } from "@codeboard/core";
import { MAX_BITMAP, MAX_SVG, readPacks } from "../src/stickers";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { animWebp, apng, faceFrames, gif, png, WEBP_1PX } from "./images";

const [open, wink] = faceFrames(16, [240, 190, 60, 255]);
const PAL: [number, number, number][] = [
  [0, 0, 0],
  [240, 190, 60],
  [60, 40, 30],
];
const GIF1 = gif(8, 8, PAL, [(x) => (x < 4 ? 1 : 2)]);
const GIF2 = gif(8, 8, PAL, [(x) => (x < 4 ? 1 : 2), (x) => (x < 4 ? 2 : 1)], 100, 0);
const PNG = png(16, 16, open);
const APNG = apng(16, 16, [open, wink]);
const AWEBP = animWebp(1, 1, [WEBP_1PX, WEBP_1PX]);

describe("sniffImage", () => {
  it("recognises PNG, APNG, WebP, animated WebP, GIF and multi-frame GIF by their bytes", () => {
    expect(sniffImage(PNG)).toEqual({ mime: "image/png", anim: false, w: 16, h: 16 });
    expect(sniffImage(APNG)).toEqual({ mime: "image/png", anim: true, w: 16, h: 16 });
    expect(sniffImage(WEBP_1PX)).toEqual({ mime: "image/webp", anim: false, w: 1, h: 1 });
    expect(sniffImage(AWEBP)).toEqual({ mime: "image/webp", anim: true, w: 1, h: 1 });
    expect(sniffImage(GIF1)).toEqual({ mime: "image/gif", anim: false, w: 8, h: 8 });
    expect(sniffImage(GIF2)).toEqual({ mime: "image/gif", anim: true, w: 8, h: 8 });
  });

  it("rejects other files, wrong magic bytes and truncated images", () => {
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(Buffer.from("not an image at all, just text pretending"))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(40)]))).toBeNull(); // JPEG start without a frame header
    const badSig = Buffer.from(PNG);
    badSig[1] = 0x51;
    expect(sniffImage(badSig)).toBeNull();
    expect(sniffImage(PNG.subarray(0, 40))).toBeNull(); // cut before IDAT
    expect(sniffImage(GIF2.subarray(0, 800))).toBeNull(); // cut inside the first frame
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPXXXX\0\0\0\0\0\0\0\0\0"))).toBeNull();
  });
});

describe("bitmap sticker packs", () => {
  let dir: string;
  let packs: StickerPack[];
  const W = nodeWorkspace();
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-stickers-"));
    const p = path.join(dir, "Party");
    fs.mkdirSync(p);
    const files: Record<string, Buffer | string> = {
      "smile.png": PNG,
      "wink.png": APNG,
      "dot.webp": WEBP_1PX,
      "dance.webp": AWEBP,
      "flag.gif": GIF1,
      "blink.gif": GIF2,
      "line.svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M0 0h16'/></svg>",
      // the same name as an SVG: the SVG wins
      "line.png": PNG,
      // a GIF saved with a .webp name: the bytes decide the type
      "renamed.webp": GIF2,
      // not images
      "fake.png": "<html>not a png</html>",
      "script.gif": "GIF89a<script>alert(1)</script>",
      "notes.txt": "hello",
      // too big
      "huge.png": Buffer.concat([PNG, Buffer.alloc(MAX_BITMAP)]),
      "huge.svg": `<svg xmlns='http://www.w3.org/2000/svg'>${" ".repeat(MAX_SVG)}</svg>`,
    };
    for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(p, f), b);
    useWorkspace({
      ...W,
      settings: { ...W.settings, get: <T>(k: string) => (k === "codeboard.stickerFolder" ? dir : undefined) as T },
    });
    packs = await readPacks();
  });
  afterAll(() => {
    useWorkspace(W);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const icon = (name: string) => packs.find((p) => p.id === "Party")!.icons.find((i) => i.name === name) as any;

  it("reads PNG, WebP and GIF files as data: URLs with the type from their bytes, and marks animated ones", () => {
    expect(icon("smile")).toEqual({ name: "smile", img: `data:image/png;base64,${PNG.toString("base64")}` });
    expect(icon("wink")).toMatchObject({ img: expect.stringMatching(/^data:image\/png;base64,/), anim: true });
    expect(icon("dot")).toEqual({ name: "dot", img: `data:image/webp;base64,${WEBP_1PX.toString("base64")}` });
    expect(icon("dance")).toMatchObject({ img: expect.stringMatching(/^data:image\/webp;base64,/), anim: true });
    expect(icon("flag").anim).toBeUndefined();
    expect(icon("flag").img).toMatch(/^data:image\/gif;base64,/);
    expect(icon("blink")).toMatchObject({ img: expect.stringMatching(/^data:image\/gif;base64,/), anim: true });
    expect(icon("renamed")).toMatchObject({ img: `data:image/gif;base64,${GIF2.toString("base64")}`, anim: true });
  });

  it("keeps the SVG when an SVG and a bitmap share a name, and sorts icons by name", () => {
    expect(icon("line")).toHaveProperty("svg");
    expect(icon("line")).not.toHaveProperty("img");
    const names = packs.find((p) => p.id === "Party")!.icons.map((i) => i.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("skips files that are not images by their bytes, and files over the size cap", () => {
    for (const n of ["fake", "script", "notes", "huge"]) expect(icon(n)).toBeUndefined();
    expect(packs.find((p) => p.id === "Party")!.icons).toHaveLength(8);
  });
});
