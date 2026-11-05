// Which copy of an Image card's image the card shows. A 2500 px screenshot shown 480 px wide cost the page as much to decode, keep
// and draw as at full size (a board of ten dragged at 45 fps), so the host makes smaller copies (host/src/thumbs) at a few widths
// (THUMB_WIDTHS) and the card shows the smallest one that is still sharp at the zoom it is seen at (with the screen's pixel
// ratio), stepping up to a larger one, then the original, as the user zooms in. It is chosen when the camera stops (stillZ),
// never during a zoom, and the next copy is decoded before it replaces the one on screen, so the image never blinks or blurs.
// It never steps down while the card stays mounted: the larger copy is already decoded, and changing back costs a decode again.
// Only assets/ PNGs and JPEGs are asked about (GIFs and animated SVGs play from their own file: md/anim.ts), and only when the
// host has a copies folder (host.thumbBase); otherwise the original is shown, as before
import { thumbWidth, type ReplyOf } from "@codeboard/core";
import { ask } from "../host";

/** The host's answers, by asset name (named by its content) and width: asked once per page */
const asked = new Map<string, Promise<ReplyOf<"thumb">>>();

/** The host's copy of the asset file `width` wide (null: none, the host shows nothing smaller) */
export function askThumb(file: string, width: number): Promise<ReplyOf<"thumb">> {
  const k = `${file}\0${width}`;
  let p = asked.get(k);
  if (!p) {
    p = ask("thumb", { file, width }).catch(() => {
      // not kept: a request cut off by a board switch is asked again next time
      asked.delete(k);
      return null;
    });
    asked.set(k, p);
  }
  return p;
}

/** The width of copy to show for an image `cssWidth` CSS px wide on a board at zoom z: Infinity = the original */
export const thumbStep = (cssWidth: number, z: number) => thumbWidth(cssWidth * z * devicePixelRatio) ?? Infinity;

/** Whether the asset (an Image card's src) has copies the host makes smaller */
export const thumbable = (src: string) => /^[\w.-]+\.(?:png|jpe?g)$/i.test(src);
