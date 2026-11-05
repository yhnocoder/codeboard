// An animated image's playback as its Markdown keeps it ({frame=N loop=true} after the image, see imageattrs.ts): read and change
// it for the nth image with an address, the way caption.ts changes a caption. Only that image's attribute block is rewritten;
// when that cannot be done in place, the whole Markdown is written back from the document
import { parseMd, serializeMd } from "./schema";
import { IMAGE, imageNode, maskCode } from "./caption";
import { imageAttrsAt, imageAttrsText, type ImageAttrs, type ImagePlayback } from "./imageattrs";

const attrsOf = (n: { attrs?: Record<string, unknown> } | null): ImageAttrs | null =>
  n
    ? {
        width: (n.attrs?.width as number | null) ?? null,
        frame: (n.attrs?.frame as number | null) ?? null,
        loop: !!n.attrs?.loop,
      }
    : null;

/** The nth image with address src: its width, still frame and loop; null when there is no such image */
export const imagePlayback = (md: string, src: string, nth = 0): ImageAttrs | null =>
  attrsOf(imageNode(parseMd(md), src, nth));

/** The Markdown with the nth image at src given this playback (frame 1 and loop off are not written) */
export function setImagePlayback(md: string, src: string, nth: number, p: ImagePlayback): string {
  const was = imagePlayback(md, src, nth);
  if (!was) return md;
  const want: ImageAttrs = {
    width: was.width,
    frame: p.frame === undefined ? was.frame : p.frame && p.frame > 1 ? Math.round(p.frame) : null,
    loop: p.loop ?? was.loop,
  };
  if (want.frame === was.frame && want.loop === was.loop) return md;
  const masked = maskCode(md);
  let k = 0,
    out: string | null = null;
  for (const m of masked.matchAll(IMAGE)) {
    const raw = m[1].startsWith("<") ? m[1].slice(1, -1) : m[1];
    if (raw !== src || k++ !== nth) continue;
    const end = m.index! + m[0].length,
      old = imageAttrsAt(md.slice(end));
    out = md.slice(0, end) + imageAttrsText(want) + md.slice(end + (old?.raw.length ?? 0));
    break;
  }
  const same = (s: string) => {
    const a = imagePlayback(s, src, nth);
    return !!a && a.width === want.width && a.frame === want.frame && a.loop === want.loop;
  };
  if (out !== null && same(out)) return out;
  const doc = parseMd(md),
    n = imageNode(doc, src, nth)!;
  n.attrs = { ...n.attrs, frame: want.frame, loop: want.loop };
  return serializeMd(doc);
}
