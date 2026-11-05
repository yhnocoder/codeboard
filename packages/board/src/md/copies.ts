// The smaller copies of the board's big images (host/src/thumbs): for each assets/ still PNG or JPEG, its size and the copies
// worth making of it, the ones made already named (ImageCopies). The host sends the board's own with init, so every image shows the
// right one from its first frame; an image added since is asked about once (a batch per task). The Markdown instance picks among
// them for the size each image is seen at, Note images and Image cards alike (@yhnocoder/markdown's picture.ts, through the
// resolver in md/images.ts and showImage), and asks for a copy not made yet (makeCopy): once the host has made it the images
// step up to it (updateImages). GIFs, WebP and SVGs have no copies: they show their own file
import { createSignal } from "solid-js";
import type { ImageCopies } from "@codeboard/core";
import type { Markdown } from "@yhnocoder/markdown";
import { ask } from "../host";

/** By assets/ file name (named by its content, so kept across boards); null: no copies (not a still PNG or JPEG) */
const known = new Map<string, ImageCopies | null>();
/** Bumped when what is known changes (an Image card's size reads it) */
const [rev, setRev] = createSignal(0);
/** Names to ask about in the next batch */
let wanted: Set<string> | null = null;
/** The copies asked for (name and width): each asked once */
const made = new Set<string>();

/** The assets/ files that can have copies (the host checks the content) */
export const copyable = (file: string) => /^[\w.-]+\.(?:png|jpe?g)$/i.test(file);

/** What the host said in init */
export function putImages(m: Record<string, ImageCopies | null> | undefined) {
  if (!m) return;
  for (const [k, v] of Object.entries(m)) known.set(k, v);
  setRev((n) => n + 1);
}

/** What is known of the asset file (undefined: not yet, asked now); not tracked */
export function copiesOf(md: Markdown, file: string): ImageCopies | null | undefined {
  const i = known.get(file);
  if (i === undefined && copyable(file)) want(md, file);
  return i;
}
/** The same, tracked (an Image card's size) */
export function imageInfo(md: Markdown, file: string): ImageCopies | null | undefined {
  rev();
  return copiesOf(md, file);
}

function want(md: Markdown, file: string) {
  if (wanted) return void wanted.add(file);
  wanted = new Set([file]);
  queueMicrotask(() => {
    const files = [...wanted!];
    wanted = null;
    void ask("images", { files }).then(
      (r) => {
        for (const f of files) known.set(f, r[f] ?? null);
        setRev((n) => n + 1);
        md.updateImages();
      },
      // a request cut off by a board switch: asked again the next time the image is drawn
      () => {},
    );
  });
}

/** The instance asks for the copy `width` wide of the image written as src (assets/…): the images step up once it is made */
export function makeCopy(md: Markdown, src: string, width: number) {
  const file = src.slice("assets/".length),
    k = `${file}\0${width}`;
  if (made.has(k)) return;
  made.add(k);
  ask("thumb", { file, width }).then(
    (a) => {
      const i = known.get(file);
      if (!a) known.set(file, null);
      else
        known.set(file, {
          width: a.width,
          height: a.height,
          // made: named; none worth it at this width: none at a larger one either
          copies: (i?.copies ?? []).flatMap((c) =>
            c.width === width ? (a.file ? [{ width, file: a.file }] : []) : !a.file && c.width > width ? [] : [c],
          ),
        });
      setRev((n) => n + 1);
      md.updateImages();
    },
    // cut off by a board switch: asked again the next time it is wanted
    () => made.delete(k),
  );
}
