// One thumbnail request, as the worker (thumbs/worker.ts) runs it: read the image, name its copy by content and width, and make
// the copy unless it is already in the cache folder. Plain Node and the codec, nothing of the host, so it runs in a worker thread
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jpegOrientation, kindOf, makeThumb } from "./codec";

export type ThumbJob = { file: string; width: number; dir: string };
/** file: the copy's name in the cache folder, null when the original is shown (no smaller copy is worth it);
 *  width / height: the image's own size as shown (EXIF orientation applied) */
export type ThumbDone = { file: string | null; width: number; height: number };

/** Not a still PNG or JPEG: null */
export async function runJob(j: ThumbJob): Promise<ThumbDone | null> {
  const src = await fs.readFile(j.file);
  const k = kindOf(src);
  if (!k) return null;
  const turned = k.mime === "jpg" && jpegOrientation(src) >= 5;
  const size = turned ? { width: k.height, height: k.width } : { width: k.width, height: k.height };
  const name = `${createHash("sha1").update(src).digest("hex").slice(0, 20)}-${j.width}.${k.mime}`;
  const at = path.join(j.dir, name);
  try {
    // a copy made before: touched, so the sweep (thumbs/index.ts) sees it is still in use
    const now = new Date();
    await fs.utimes(at, now, now);
    return { file: name, ...size };
  } catch {
    /* not made yet */
  }
  const t = makeThumb(src, j.width);
  if (!t) return { file: null, ...size };
  await fs.mkdir(j.dir, { recursive: true });
  // written whole under another name first: another window may be reading the folder
  const tmp = `${at}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, t.bytes);
  await fs.rename(tmp, at);
  return { file: name, ...size };
}
