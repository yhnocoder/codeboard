import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sniffImage, type BoardToHost } from "@codeboard/core";
import { Storage } from "../src/storage/boards";
import { nodeFs } from "../src/storage/nodefs";
import { makeHandler } from "../src/handlers";
import { MAX_NOTE_IMAGE, saveNoteImage } from "../src/images";
import type { BoardHost, BoardPanel } from "../src/boards";
import { gif, png, WEBP_1PX } from "./images";
import { nodeWorkspace } from "./node-workspace";
import { HostContext } from "../src/context";
import { MEDIA } from "./helpers";

let cx: HostContext;

const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/codeboard-img-"));
// the host a pasted image is saved through (its copies are made in the background, in its storage)
beforeAll(() => {
  cx = new HostContext(nodeWorkspace(path.join(tmp, "ws")));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function setup() {
  const dir = path.join(tmp, `s${++n}`);
  const store = new Storage(nodeFs, { dir: () => dir });
  const h = makeHandler(
    cx,
    {
      get cx() {
        return cx;
      },
      store,
    } as unknown as BoardHost,
    MEDIA,
  );
  const save = (dataUrl: string) =>
    h({} as BoardPanel, { type: "saveImage", req: 1, dataUrl } as BoardToHost) as Promise<string>;
  const assets = () => (fs.existsSync(path.join(dir, "assets")) ? fs.readdirSync(path.join(dir, "assets")).sort() : []);
  return { dir, store, save, assets };
}
const url = (b: Buffer, mime = "image/png") => `data:${mime};base64,${b.toString("base64")}`;
const sha = (b: Buffer) => createHash("sha1").update(b).digest("hex").slice(0, 16);

const PNG = png(40, 30, (x) => [x * 6, 90, 200, 255]);
const GIF = gif(
  12,
  7,
  [
    [0, 0, 0],
    [250, 200, 0],
  ],
  [(x) => x % 2],
);
/** A JPEG header: SOI, an Exif APP1 with the given orientation, a baseline frame header w × h, EOI */
function jpeg(w: number, h: number, orientation = 1) {
  const tiff = Buffer.from([
    0x4d,
    0x4d,
    0,
    42,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    orientation,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    u16(2 + 6 + tiff.length),
    Buffer.from("Exif\0\0", "latin1"),
    tiff,
  ]);
  const sof = Buffer.concat([
    Buffer.from([0xff, 0xc0, 0, 17, 8]),
    u16(h),
    u16(w),
    Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}
function u16(v: number) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
}

describe("saving a pasted image", () => {
  it("writes the bytes to assets/ in the storage folder and answers the relative path with the image's size", async () => {
    const { dir, save, assets } = setup();
    const src = await save(url(PNG));
    expect(src).toBe(`assets/${sha(PNG)}-40x30.png`);
    expect(fs.readFileSync(path.join(dir, src)).equals(PNG)).toBe(true);
    expect(assets()).toEqual([`${sha(PNG)}-40x30.png`]); // no temp file left behind
  });

  it("makes a pasted screenshot's smaller copies in the background, and lists them for the board", async () => {
    const storage = path.join(tmp, "copies-storage");
    cx = new HostContext({
      ...nodeWorkspace(tmp),
      storage: { dir: () => storage, globalDir: () => storage, get: () => undefined, set: async () => {} },
    });
    const { save, store } = setup();
    const shot = png(2000, 1000, (x) => (x % 40 < 20 ? [250, 250, 245, 255] : [30, 30, 40, 255]));
    const src = await save(url(shot));
    const file = src.slice("assets/".length);
    const h = makeHandler(cx, { cx, store } as unknown as BoardHost, MEDIA);
    const images = () =>
      h({} as BoardPanel, { type: "images", req: 1, files: [file, "none.png", "x.gif"] } as BoardToHost) as Promise<
        Record<string, unknown>
      >;
    // 2000 px wide: copies 400 and 800 wide are worth it; the host makes them without being asked
    await vi.waitFor(
      async () =>
        expect(await images()).toEqual({
          [file]: {
            width: 2000,
            height: 1000,
            copies: [
              { width: 400, file: expect.stringMatching(/^[0-9a-f]{20}-400\.png$/) },
              { width: 800, file: expect.stringMatching(/^[0-9a-f]{20}-800\.png$/) },
            ],
          },
          "none.png": null,
          "x.gif": null,
        }),
      { timeout: 20_000 },
    );
    // the copies are a cache in the editor's storage, named by the image's content (its assets/ name starts the same)
    const made = fs.readdirSync(path.join(storage, "thumbs")).sort();
    expect(made.every((f) => f.startsWith(sha(shot)))).toBe(true);
    // the Markdown keeps the original's address
    expect(src).toBe(`assets/${sha(shot)}-2000x1000.png`);
    cx.dispose();
  });

  it("keeps one file per image: the same bytes pasted again, under another type or name, give the same path", async () => {
    const { save, assets } = setup();
    const a = await save(url(PNG));
    const b = await save(url(PNG, "application/octet-stream"));
    expect(b).toBe(a);
    expect(assets()).toHaveLength(1);
  });

  it("takes PNG, JPEG, WebP and GIF by their bytes, whatever the data URL says", async () => {
    const { save } = setup();
    expect(await save(url(jpeg(64, 48), "image/png"))).toMatch(/^assets\/[0-9a-f]{16}-64x48\.jpg$/);
    expect(await save(url(WEBP_1PX, "image/jpeg"))).toMatch(/-1x1\.webp$/);
    expect(await save(url(GIF, "image/webp"))).toMatch(/-12x7\.gif$/);
  });

  it("records a rotated JPEG (Exif orientation 5–8) at its displayed size", () => {
    expect(sniffImage(jpeg(64, 48, 6))).toEqual({ mime: "image/jpeg", anim: false, w: 48, h: 64 });
    expect(sniffImage(jpeg(64, 48, 3))).toEqual({ mime: "image/jpeg", anim: false, w: 64, h: 48 });
  });

  it("keeps an SVG as .svg, named with the size its width / height or viewBox give (none when it has neither)", async () => {
    const { save, assets } = setup();
    const svg = (attrs: string) =>
      Buffer.from(
        `<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="8" height="4"/></svg>`,
      );
    expect(await save(url(svg('width="240" height="160"'), "image/png"))).toMatch(
      /^assets\/[0-9a-f]{16}-240x160\.svg$/,
    );
    expect(await save(url(svg('viewBox="0 0 120 80"'), "image/svg+xml"))).toMatch(/-120x80\.svg$/);
    expect(await save(url(svg('width="60" viewBox="0 0 120 80"')))).toMatch(/-60x40\.svg$/);
    expect(await save(url(svg('width="100%" height="100%" viewBox="0 0 30 10"')))).toMatch(/-30x10\.svg$/);
    expect(await save(url(svg("")))).toMatch(/^assets\/[0-9a-f]{16}\.svg$/);
    expect(assets()).toHaveLength(5);
  });

  it("refuses other files, a wrong signature and a cut-off image, and writes nothing", async () => {
    const { save, assets } = setup();
    const msg = "Only PNG, JPEG, WebP, GIF and SVG images can go into a Note";
    await expect(
      save(url(Buffer.from("<html><svg xmlns='http://www.w3.org/2000/svg'/></html>"), "image/svg+xml")),
    ).rejects.toThrow(msg);
    await expect(save(url(Buffer.from("just some text pretending to be an image")))).rejects.toThrow(msg);
    const bad = Buffer.from(PNG);
    bad[1] = 0x51;
    await expect(save(url(bad))).rejects.toThrow(msg);
    await expect(save(url(PNG.subarray(0, 40)))).rejects.toThrow(msg);
    await expect(save("https://example.com/a.png")).rejects.toThrow("Not an image");
    expect(assets()).toEqual([]);
  });

  it(`refuses an image larger than ${MAX_NOTE_IMAGE >> 20} MB`, async () => {
    const { save, assets } = setup();
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_NOTE_IMAGE + 1 - PNG.length)]);
    await expect(save(url(big))).rejects.toThrow(`larger than ${MAX_NOTE_IMAGE >> 20} MB`);
    const ok = Buffer.concat([PNG, Buffer.alloc(MAX_NOTE_IMAGE - PNG.length)]); // trailing bytes after IEND: still a PNG
    expect(await save(url(ok))).toMatch(/-40x30\.png$/);
    expect(assets()).toHaveLength(1);
  });

  it("follows the storage folder (a moved storageDir, or global storage with no folder open)", async () => {
    let dir = path.join(tmp, "first");
    const store = new Storage(nodeFs, { dir: () => dir });
    await saveNoteImage(cx, store, url(PNG));
    dir = path.join(tmp, "global", "boards");
    const src = await saveNoteImage(cx, store, url(PNG));
    expect(fs.existsSync(path.join(tmp, "first", src))).toBe(true);
    expect(fs.existsSync(path.join(dir, src))).toBe(true);
    expect(store.assetsDir()).toBe(path.join(dir, "assets"));
  });
});

describe("reading an image card's picture", () => {
  const read = (s: ReturnType<typeof setup>, file: string) =>
    makeHandler(
      cx,
      {
        get cx() {
          return cx;
        },
        store: s.store,
      } as unknown as BoardHost,
      MEDIA,
    )({} as BoardPanel, { type: "readAsset", req: 1, file } as BoardToHost) as Promise<string>;

  it("answers the file in assets/ as a data URL typed by its bytes, which saves into a Note like a pasted image", async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(s.dir, "assets/card.png"), GIF); // a GIF under a .png name
    fs.writeFileSync(path.join(s.dir, "assets/logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const gifUrl = await read(s, "card.png");
    expect(gifUrl).toBe(url(GIF, "image/gif"));
    expect(await read(s, "logo.svg")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await s.save(gifUrl)).toBe(`assets/${sha(GIF)}-12x7.gif`);
  });

  it("refuses names outside assets/, missing files and files that are not images", async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(s.dir, "assets/notes.txt"), "hello");
    await expect(read(s, "../boards.json")).rejects.toThrow(/Bad asset name/);
    await expect(read(s, "missing.png")).rejects.toThrow();
    await expect(read(s, "notes.txt")).rejects.toThrow(/Not an image/);
  });
});

describe("adding an image card's picture", () => {
  const SVG = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="120" height="80"/></svg>`,
  );
  const handler = (s: ReturnType<typeof setup>) =>
    makeHandler(
      cx,
      {
        get cx() {
          return cx;
        },
        store: s.store,
      } as unknown as BoardHost,
      MEDIA,
    );

  it("stores it under the extension its content gives, whatever name the board sends (webviews type a file by its extension)", async () => {
    const s = setup();
    const add = (name: string, dataUrl: string) =>
      handler(s)({} as BoardPanel, { type: "saveAsset", req: 1, name, dataUrl } as BoardToHost) as Promise<string>;
    expect(await add("image.png", url(SVG, "image/svg+xml"))).toBe(`${sha(SVG)}.svg`);
    expect(await add("diagram.svg", url(PNG, "image/svg+xml"))).toBe(`${sha(PNG)}.png`);
    expect(await add("icon.ico", url(Buffer.from([0, 0, 1, 0, 1, 0]), "image/x-icon"))).toMatch(/^[0-9a-f]{16}\.ico$/);
  });

  it("answers a picked .svg (or a picture under the wrong extension) as a data URL typed by its content", async () => {
    const s = setup(),
      W = nodeWorkspace(tmp);
    const warned: string[] = [];
    let picked = "";
    W.ui.openDialog = async () => picked;
    W.ui.warn = async (text: string) => {
      warned.push(text);
      return undefined;
    };
    cx = new HostContext(W);
    const pick = () =>
      handler(s)({} as BoardPanel, { type: "pickFile", req: 1, kind: "image" } as BoardToHost) as Promise<
        string | null
      >;
    fs.writeFileSync((picked = path.join(tmp, "diagram.svg")), SVG);
    expect(await pick()).toBe(url(SVG, "image/svg+xml"));
    fs.writeFileSync((picked = path.join(tmp, "photo.jpg")), PNG);
    expect(await pick()).toBe(url(PNG, "image/png"));
    fs.writeFileSync((picked = path.join(tmp, "notes.svg")), "not a picture");
    expect(await pick()).toBeNull();
    expect(warned).toEqual(["notes.svg is not a PNG, JPEG, WebP, GIF or SVG image."]);
  });
});
