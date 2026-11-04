// An image's attributes after it, Pandoc's way: ![a](u){width=40% frame=3 loop=true}. width is a percentage of the body's
// width; frame (from 1) is the frame an animated image (GIF, animated SVG) stands still on; loop=true plays it all the time.
// A block with any other key, a repeated key or a value out of range is not attributes: it stays text, as typed
export type ImageAttrs = { width: number | null; frame: number | null; loop: boolean };
/** What can change of an animated image's playback (undefined: as it is) */
export type ImagePlayback = { frame?: number | null; loop?: boolean };

const BLOCK = /^\{([^{}\n]*)\}/;

function parseBlock(inner: string): ImageAttrs | undefined {
  const a: ImageAttrs = { width: null, frame: null, loop: false },
    seen = new Set<string>();
  const parts = inner.trim().split(/\s+/);
  if (!parts[0]) return undefined;
  for (const p of parts) {
    const m = /^(\w+)=(\S+)$/.exec(p);
    if (!m || seen.has(m[1])) return undefined;
    seen.add(m[1]);
    const [, k, v] = m;
    if (k === "width") {
      const w = /^(\d{1,3}(?:\.\d+)?)%$/.exec(v) ? Number(v.slice(0, -1)) : 0;
      if (!(w > 0 && w <= 100)) return undefined;
      a.width = w;
    } else if (k === "frame") {
      const f = /^\d{1,6}$/.test(v) ? Number(v) : 0;
      if (f < 1) return undefined;
      a.frame = f;
    } else if (k === "loop" && v === "true") a.loop = true;
    else return undefined;
  }
  return a;
}

/** The attribute block at the start of s (right after an image's source), if s starts with one */
export function imageAttrsAt(s: string): { attrs: ImageAttrs; raw: string } | undefined {
  const m = BLOCK.exec(s),
    attrs = m ? parseBlock(m[1]) : undefined;
  return attrs && { attrs, raw: m![0] };
}

/** The block for these attributes ("" when there is nothing to write); width first, as resizing wrote it before */
export function imageAttrsText(a: Partial<ImageAttrs>): string {
  const parts = [
    a.width ? `width=${a.width}%` : "",
    a.frame ? `frame=${a.frame}` : "",
    a.loop ? "loop=true" : "",
  ].filter(Boolean);
  return parts.length ? `{${parts.join(" ")}}` : "";
}

/** The attribute block that ends an image's source (raw: the whole ![…](…){…}), with where it starts in raw */
export function imageAttrsEnd(raw: string): { attrs: ImageAttrs; at: number } | undefined {
  const open = raw.lastIndexOf("{");
  if (open < 0 || !raw.endsWith("}") || raw[open - 1] !== ")") return undefined;
  const r = imageAttrsAt(raw.slice(open));
  return r && r.raw.length === raw.length - open ? { attrs: r.attrs, at: open } : undefined;
}
