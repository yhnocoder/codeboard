// One thumbnail request: name the copy by the image's content and the width, answer from the cache folder when it is there
// (lookUp, in the host's thread: a read and a hash, a few ms), and otherwise make it (runJob, in the worker: thumbs/worker.ts).
// Plain Node and the codec, nothing of the host, so it runs in a worker thread
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jpegOrientation, kindOf, makeThumb, worthCopy } from "./codec";

/** A copy's name in the cache folder: the image's content hash (sha1, hex: its first 16 characters are an assets/ file's name,
 *  host/src/images.ts), the width and the format */
const copyName = (sha1: string, width: number, mime: string) => `${sha1.slice(0, 20)}-${width}.${mime}`;
/** A copy's name read back: the first 16 characters of its image's hash, its width and format */
export function readCopyName(name: string): { id: string; width: number; mime: string } | null {
  const m = /^([0-9a-f]{20})-(\d+)\.(png|jpg)$/.exec(name);
  return m ? { id: m[1].slice(0, 16), width: +m[2], mime: m[3] } : null;
}

export type ThumbJob = { file: string; width: number; dir: string };
/** file: the copy's name in the cache folder, null when the original is shown (no smaller copy is worth it);
 *  width / height: the image's own size as shown (EXIF orientation applied) */
export type ThumbDone = { file: string | null; width: number; height: number };

/** The answer when it needs no decoding (not a still PNG or JPEG: null; no copy worth it; a copy made before), or the copy's
 *  name to make */
export async function lookUp(
  j: ThumbJob,
  src?: Buffer,
): Promise<{ done: ThumbDone | null } | { make: string; size: { width: number; height: number } }> {
  src ??= await fs.readFile(j.file);
  const k = kindOf(src);
  if (!k) return { done: null };
  const turned = k.mime === "jpg" && jpegOrientation(src) >= 5;
  const size = turned ? { width: k.height, height: k.width } : { width: k.width, height: k.height };
  if (!worthCopy(size.width, j.width)) return { done: { file: null, ...size } };
  const name = copyName(createHash("sha1").update(src).digest("hex"), j.width, k.mime);
  try {
    // a copy made before: touched, so the sweep (thumbs/index.ts) sees it is still in use
    const now = new Date();
    await fs.utimes(path.join(j.dir, name), now, now);
    return { done: { file: name, ...size } };
  } catch {
    return { make: name, size };
  }
}

/** The copy made (unless it is there by now); not a still PNG or JPEG: null */
export async function runJob(j: ThumbJob): Promise<ThumbDone | null> {
  const src = await fs.readFile(j.file);
  const l = await lookUp(j, src);
  if ("done" in l) return l.done;
  const t = makeThumb(src, j.width);
  if (!t) return { file: null, ...l.size };
  await fs.mkdir(j.dir, { recursive: true });
  // written whole under another name first: another window may be reading the folder
  const at = path.join(j.dir, l.make);
  const tmp = `${at}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, t.bytes);
  await fs.rename(tmp, at);
  return { file: l.make, ...l.size };
}
