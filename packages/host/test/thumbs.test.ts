// Smaller copies of big board images (src/thumbs): the codec (area-averaged shrinking, PNG / JPEG, colour chunks, EXIF
// orientation), the cache (named by content and width, in the editor's storage, never in the boards' folder), the worker and the sweep
import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "esbuild";
import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { THUMB_WIDTHS, type Workspace } from "@codeboard/core";
import { jpegOrientation, kindOf, makeThumb, orient, shrink, type Raster } from "../src/thumbs/codec";
import { Thumbs } from "../src/thumbs";
import { apng, gif, png, withChunk } from "./images";
import { nodeWorkspace } from "./node-workspace";

const tmp = fs.mkdtempSync("/tmp/codeboard-thumbs-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const raster = (width: number, height: number, px: (x: number, y: number) => number[]): Raster => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(px(x, y), (y * width + x) * 4);
  return { width, height, data };
};
const at = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];
/** A screenshot-like picture: stripes of three colours, 40 px each */
const stripes = (x: number): [number, number, number, number] =>
  [
    [250, 250, 245, 255],
    [30, 30, 40, 255],
    [200, 60, 50, 255],
  ][Math.floor(x / 40) % 3] as [number, number, number, number];

/** An EXIF APP1 segment that says orientation o */
function exif(o: number) {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(o, 18);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}
const jpg = (r: Raster, ...segments: Buffer[]) => {
  const b = Buffer.from(jpeg.encode({ width: r.width, height: r.height, data: r.data }, 95).data);
  return Buffer.concat([b.subarray(0, 2), ...segments, b.subarray(2)]);
};

describe("thumbnail codec", () => {
  it("averages the source pixels each output pixel covers", () => {
    const r = raster(4, 2, (x) => (x < 2 ? [0, 0, 0, 255] : [200, 100, 50, 255]));
    const s = shrink(r, 2, 1);
    expect(at(s, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(at(s, 1, 0)).toEqual([200, 100, 50, 255]);
    // a third of a pixel each side: 3 → 2 mixes the middle column into both
    const m = shrink(
      raster(3, 1, (x) => (x === 1 ? [255, 255, 255, 255] : [0, 0, 0, 255])),
      2,
      1,
    );
    expect(at(m, 0, 0)).toEqual([85, 85, 85, 255]);
    expect(at(m, 1, 0)).toEqual([85, 85, 85, 255]);
  });

  it("does not let transparent pixels' colour bleed into the edges", () => {
    const r = raster(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
    expect(at(shrink(r, 1, 1), 0, 0)).toEqual([255, 0, 0, 128]);
  });

  it("turns the pixels the way EXIF orientation says", () => {
    // 2 × 1: red then blue
    const r = raster(2, 1, (x) => (x ? [0, 0, 255, 255] : [255, 0, 0, 255]));
    const six = orient(r, 6); // 90° clockwise: red on top
    expect([six.width, six.height]).toEqual([1, 2]);
    expect(at(six, 0, 0)).toEqual([255, 0, 0, 255]);
    const eight = orient(r, 8); // 90° anticlockwise: blue on top
    expect(at(eight, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(at(orient(r, 2), 0, 0)).toEqual([0, 0, 255, 255]);
    expect(orient(r, 1)).toBe(r);
  });

  it("makes a PNG copy of a big screenshot, with its colour chunks", () => {
    const gama = Buffer.alloc(4);
    gama.writeUInt32BE(45455);
    const src = withChunk(png(2400, 1800, stripes, 144), "gAMA", gama);
    const t = makeThumb(src, 800)!;
    expect(t).toMatchObject({ ext: "png", width: 800, height: 600 });
    const out = PNG.sync.read(t.bytes);
    expect([out.width, out.height]).toEqual([800, 600]);
    // 40 source px a stripe = 13.3 copy px: the middle of the first stripe keeps its colour
    expect([...out.data.subarray((300 * 800 + 6) * 4, (300 * 800 + 6) * 4 + 4)]).toEqual([250, 250, 245, 255]);
    expect(t.bytes.includes(Buffer.from("gAMA", "latin1"))).toBe(true);
    expect(t.bytes.length).toBeLessThan(src.length);
  });

  it("makes a JPEG copy, turned by its EXIF orientation, with its ICC profile", () => {
    const icc = Buffer.concat([Buffer.from("ICC_PROFILE\0\x01\x01", "latin1"), Buffer.alloc(40, 7)]);
    const app2 = Buffer.concat([Buffer.from([0xff, 0xe2, 0, icc.length + 2]), icc]);
    const src = jpg(
      raster(1800, 1200, (x) => stripes(x)),
      exif(6),
      app2,
    );
    expect(jpegOrientation(src)).toBe(6);
    expect(kindOf(src)).toEqual({ mime: "jpg", width: 1800, height: 1200 });
    const t = makeThumb(src, 400)!;
    // shown turned: 1200 wide, 1800 high
    expect(t).toMatchObject({ ext: "jpg", width: 400, height: 600 });
    const out = jpeg.decode(t.bytes, { useTArray: true });
    expect([out.width, out.height]).toEqual([400, 600]);
    expect(jpegOrientation(t.bytes)).toBe(1);
    expect(t.bytes.includes(Buffer.from("ICC_PROFILE", "latin1"))).toBe(true);
  });

  it("leaves animated, vector and small images alone", () => {
    const red = () => [255, 0, 0, 255] as [number, number, number, number];
    expect(kindOf(apng(900, 900, [red, red]))).toBeNull();
    expect(kindOf(gif(900, 900, [[255, 0, 0]], [() => 0], 0, 0))).toBeNull();
    expect(kindOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000"/>'))).toBeNull();
    expect(makeThumb(png(700, 300, red), 800)).toBeNull();
  });
});

describe("thumbnail cache", () => {
  let n = 0;
  const setup = (worker?: string) => {
    const dir = path.join(tmp, `w${++n}`);
    const ws: Workspace = {
      ...nodeWorkspace(),
      storage: {
        dir: () => path.join(dir, "storage"),
        globalDir: () => dir,
        get: () => undefined,
        set: async () => {},
      },
    };
    const assets = path.join(dir, "boards", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const put = (name: string, b: Buffer) => {
      fs.writeFileSync(path.join(assets, name), b);
      return path.join(assets, name);
    };
    return {
      thumbs: new Thumbs(ws, worker),
      put,
      cache: path.join(dir, "storage", "thumbs"),
      boards: path.join(dir, "boards"),
    };
  };

  it("keeps copies by content and width in the editor's storage, not next to the boards", async () => {
    const { thumbs, put, cache, boards } = setup();
    const big = put("a.png", png(2000, 1000, stripes));
    const a = await thumbs.get(big, 800);
    expect(a).toMatchObject({ width: 2000, height: 1000 });
    expect(a!.file).toMatch(/^[0-9a-f]{20}-800\.png$/);
    expect(fs.readdirSync(cache)).toEqual([a!.file]);
    expect(PNG.sync.read(fs.readFileSync(path.join(cache, a!.file!))).width).toBe(800);
    expect(fs.readdirSync(path.join(boards, "assets"))).toEqual(["a.png"]);
    // the same content under another name shares the copy
    const again = await thumbs.get(put("b.png", fs.readFileSync(big)), 800);
    expect(again!.file).toBe(a!.file);
    expect(fs.readdirSync(cache)).toHaveLength(1);
    // too small for a copy at 1600: the original is shown
    expect(await thumbs.get(big, 1600)).toEqual({ file: null, width: 2000, height: 1000 });
    // changed content: a new copy
    fs.writeFileSync(
      big,
      png(2000, 1000, (x) => stripes(x + 40)),
    );
    const changed = await thumbs.get(big, 800);
    expect(changed!.file).not.toBe(a!.file);
    // not a still PNG or JPEG
    expect(await thumbs.get(put("c.gif", gif(900, 900, [[255, 0, 0]], [() => 0], 0, 0)), 400)).toBeNull();
    await expect(thumbs.get(big, 500)).rejects.toThrow(/width/);
    expect(THUMB_WIDTHS).toContain(800);
    thumbs.dispose();
  });

  it("makes them in the built worker, and lets it go on dispose", async () => {
    const worker = path.join(tmp, "thumbs-worker.cjs");
    await build({
      entryPoints: [path.join(__dirname, "../src/thumbs/worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: worker,
      logLevel: "warning",
    });
    const { thumbs, put, cache } = setup(worker);
    const [a, b] = await Promise.all([
      thumbs.get(put("a.png", png(1800, 900, stripes)), 400),
      thumbs.get(put("b.jpg", jpg(raster(1700, 850, (x) => stripes(x)))), 800),
    ]);
    expect(a).toMatchObject({ width: 1800, height: 900 });
    expect(b!.file).toMatch(/-800\.jpg$/);
    expect(fs.readdirSync(cache).sort()).toEqual([a!.file, b!.file].sort());
    thumbs.dispose();
    await expect(thumbs.get(path.join(tmp, "none.png"), 400)).rejects.toThrow();
  });

  it("lists an image's size and the copies worth making, the made ones named, from the file's head", async () => {
    const { thumbs, put, cache } = setup();
    const bytes = png(2000, 1000, stripes),
      sha = createHash("sha1").update(bytes).digest("hex");
    // named by its content, as the host names a pasted image (images.ts): its copies are found by name
    const named = `${sha.slice(0, 16)}-2000x1000.png`;
    const big = put(named, bytes);
    // a picture put there by hand: hashed
    const plain = put("plain.png", bytes);
    const tall = put(
      "tall.jpg",
      jpg(
        raster(600, 1200, (x) => stripes(x)),
        exif(6),
      ),
    );
    const anim = put("anim.png", apng(900, 900, [() => [1, 2, 3, 255], () => [3, 2, 1, 255]]));
    const small = put("small.png", png(300, 200, stripes));
    const ask = () =>
      thumbs.info({
        [named]: big,
        "plain.png": plain,
        "tall.jpg": tall,
        "anim.png": anim,
        "small.png": small,
        "gone.png": path.join(path.dirname(big), "gone.png"),
      });
    const before = await ask();
    // 2000 wide: copies at 400 and 800 (1600 is not narrower enough to be worth one), none made yet
    expect(before[named]).toEqual({ width: 2000, height: 1000, copies: [{ width: 400 }, { width: 800 }] });
    expect(before["plain.png"]).toEqual(before[named]);
    // EXIF-turned: 1200 wide as shown
    expect(before["tall.jpg"]).toEqual({ width: 1200, height: 600, copies: [{ width: 400 }, { width: 800 }] });
    expect(before["small.png"]).toEqual({ width: 300, height: 200, copies: [] });
    expect(before["anim.png"]).toBeNull();
    expect(before["gone.png"]).toBeNull();
    const made = await thumbs.get(big, 800);
    const old = new Date(Date.now() - 30 * 24 * 3600_000);
    fs.utimesSync(path.join(cache, made!.file!), old, old);
    const after = await ask();
    expect(after[named]!.copies).toEqual([{ width: 400 }, { width: 800, file: made!.file }]);
    expect(after["plain.png"]!.copies).toEqual(after[named]!.copies);
    // listed = in use: touched, so the sweep keeps it
    await vi.waitFor(() => expect(fs.statSync(path.join(cache, made!.file!)).mtimeMs).toBeGreaterThan(+old + 1000));
    thumbs.dispose();
  });

  it("makes every copy worth making of a saved image in the background", async () => {
    const { thumbs, put, cache } = setup();
    const big = put("a.png", png(2400, 1200, stripes));
    thumbs.prepare(big);
    await vi.waitFor(
      () =>
        expect(
          fs
            .readdirSync(cache)
            .filter((f) => !f.endsWith(".tmp"))
            .sort(),
        ).toHaveLength(3),
      {
        timeout: 20_000,
      },
    );
    expect(
      fs
        .readdirSync(cache)
        .map((f) => f.replace(/^[0-9a-f]{20}/, ""))
        .sort(),
    ).toEqual(["-1600.png", "-400.png", "-800.png"]);
    // and the board asking for one gets it at once
    expect((await thumbs.get(big, 400))!.file).toMatch(/-400\.png$/);
    thumbs.prepare(put("c.gif", gif(900, 900, [[255, 0, 0]], [() => 0], 0, 0)));
    thumbs.dispose();
  });

  it("deletes copies no board has asked for in a long time", async () => {
    const { thumbs, put, cache } = setup();
    fs.mkdirSync(cache, { recursive: true });
    const old = path.join(cache, "0123456789abcdef0123-400.png"),
      left = path.join(cache, "x.png.1-abc.tmp");
    fs.writeFileSync(old, "x");
    fs.writeFileSync(left, "x");
    const t = new Date(Date.now() - 90 * 24 * 3600_000);
    fs.utimesSync(old, t, t);
    fs.utimesSync(left, t, t);
    const a = await thumbs.get(put("a.png", png(1000, 500, stripes)), 400);
    await vi.waitFor(() => expect(fs.readdirSync(cache)).toEqual([a!.file]));
    thumbs.dispose();
  });
});
