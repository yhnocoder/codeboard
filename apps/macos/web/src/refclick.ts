// Presses on drawn [[refs]] in the Mac app's editor and sidenote popup (the web board's ui/Md.tsx openRef, the editor's
// onRef): the first press of a click is native's (it waits out the double-click time, then goes to the card or previews
// it), and nothing under it gets it, so an editor keeps its caret where it was; the second press of a double-click is
// let through (an editor opens the ref's source, a sidenote its editing) and native drops what the first one began.

export type RefPosted =
  | {
      type: "ref";
      ref: string;
      target: string | null;
      /** ⌘ held: there at once */
      go: boolean;
      /** In an editor, whose caret stays */
      writing: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | { type: "refDouble" }
  /** A press anywhere else: a preview open closes */
  | { type: "elsewhere" };

/** A drawn ref that points at something */
export const liveRef = (t: EventTarget | null) =>
  (t as Element | null)?.closest?.<HTMLElement>(".md-ref:not(.missing):not(.gone)") ?? null;

export function watchRefs(post: (m: RefPosted) => void) {
  /** Stops eating what a press on a ref left: its release, and the click that comes with it in the same task */
  let unEat: (() => void) | null = null;
  window.addEventListener(
    "mousedown",
    (e) => {
      // what an earlier press was waiting for never came (no click after its release, or no release)
      unEat?.();
      // a press made by the page itself (a double-click on the board opening a ref's source)
      if (!e.isTrusted || e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey) return;
      const r = liveRef(e.target);
      if (!r) return post({ type: "elsewhere" });
      if (e.detail >= 2) return post({ type: "refDouble" });
      e.preventDefault();
      e.stopPropagation();
      // the same press's release and click: nothing under it hears of it (an editor would put its caret there); a
      // click comes in the release's task or not at all (the ref drawn again under the pointer, the pointer gone
      // off it), and whatever comes later is not this press's
      const eat = (ev: Event) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      const up = (ev: Event) => {
        eat(ev);
        window.removeEventListener("mouseup", up, true);
        setTimeout(done);
      };
      const click = (ev: Event) => {
        eat(ev);
        done();
      };
      const done = () => {
        window.removeEventListener("mouseup", up, true);
        window.removeEventListener("click", click, true);
        unEat = null;
      };
      window.addEventListener("mouseup", up, true);
      window.addEventListener("click", click, true);
      unEat = done;
      const b = r.getBoundingClientRect();
      post({
        type: "ref",
        ref: r.dataset.ref ?? "",
        target: r.dataset.target || null,
        go: e.metaKey,
        writing: !!r.closest(".md-pm"),
        x: b.left,
        y: b.top,
        width: b.width,
        height: b.height,
      });
    },
    true,
  );
}

/** Opens the source of the ref drawn at a point of the page as a press on it does (a double-click on the board's Note
 *  started this editing on it) */
export function openRefAt(x: number, y: number) {
  const r = liveRef(document.elementFromPoint(x, y));
  r?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 2 }));
}
