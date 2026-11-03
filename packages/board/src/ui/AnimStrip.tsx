// The filmstrip of the selected animated image in a Note or image card (md/anim.ts): it floats just under the image, over whatever is below it
// (the caption, the next paragraph, past the card's edge), and never changes the card's size. It lives in the board's world layer,
// so it zooms with the board like the card does; zoomed out to an overview it is not shown. Play / pause, a still per frame
// (clicking one stands the image on it), the frame number, and the loop button that makes the image always play
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { cam, lod } from "../state/camera";
import { hostOf, placeOf } from "../state/store";
import { selectedAnim, toggleLoop, THUMB_H, type Player } from "../md/anim";

/** Below this zoom the filmstrip is too small to use: hidden, as the code cards' buttons are at the overview level */
const CONTROLS_MIN_Z = 0.5;
const MAX_W = 440,
  MIN_W = 220;

/** The image's box in world px (layout offsets up to the world layer, minus what the Note's body has scrolled) */
function worldBox(img: HTMLElement) {
  let x = 0,
    y = 0;
  for (let e: HTMLElement | null = img; e && !e.classList.contains("world"); e = e.offsetParent as HTMLElement | null) {
    x += e.offsetLeft;
    y += e.offsetTop;
  }
  for (let a = img.parentElement; a && !a.classList.contains("world"); a = a.parentElement) {
    x -= a.scrollLeft;
    y -= a.scrollTop;
  }
  return { x, y, w: img.offsetWidth, h: img.offsetHeight };
}

export function AnimStrip() {
  const near = createMemo(() => lod() === "full" && cam.z >= CONTROLS_MIN_Z);
  return (
    <Show when={near() && selectedAnim()} keyed>
      {(p) => <Strip p={p} />}
    </Show>
  );
}

const PLAY = "M4 2.5v11L13 8z",
  PAUSE = "M4 3h3v10H4zM9 3h3v10H9z",
  LOOP =
    "M3 6.5a3.5 3.5 0 0 1 3.5-3.5H11V1.5L14 4l-3 2.5V5H6.5A1.5 1.5 0 0 0 5 6.5V8H3zM13 9.5A3.5 3.5 0 0 1 9.5 13H5v1.5L2 12l3-2.5V11h4.5A1.5 1.5 0 0 0 11 9.5V8h2z";

function Strip(props: { p: Player }) {
  const p = props.p;
  let thumbsEl!: HTMLDivElement;
  const [moved, bump] = createSignal(0, { equals: false });
  const ro = new ResizeObserver(() => bump(0));
  ro.observe(p.img);
  const body = p.img.closest<HTMLElement>(".nbody, .tx");
  if (body) ro.observe(body);
  const scrolled = () => bump(0);
  body?.addEventListener("scroll", scrolled, { passive: true });
  onCleanup(() => {
    ro.disconnect();
    body?.removeEventListener("scroll", scrolled);
  });
  const box = createMemo(() => {
    moved();
    const pl = placeOf(hostOf(p.key.card));
    void [pl.x, pl.y, pl.w, pl.h];
    return { img: worldBox(p.img), body: body ? worldBox(body) : worldBox(p.img) };
  });
  const th = p.thumbs();
  const cur = createMemo(() => {
    const f = p.frame();
    let k = 0;
    while (k + 1 < th.frames.length && th.frames[k + 1] <= f) k++;
    return k;
  });
  onMount(() => {
    thumbsEl.append(...th.els);
    p.thumbsShown();
    onCleanup(() => {
      for (const e of th.els) e.remove();
    });
  });
  // the still of the frame shown is marked, and kept in view inside the strip (not scrollIntoView: that would scroll the board's
  // own boxes too)
  createEffect<number>((was) => {
    const k = cur(),
      el = th.els[k];
    th.els[was]?.classList.remove("on");
    el?.classList.add("on");
    if (!el) return k;
    const l = el.offsetLeft - thumbsEl.offsetLeft,
      r = l + el.offsetWidth;
    if (l < thumbsEl.scrollLeft) thumbsEl.scrollLeft = l - 4;
    else if (r > thumbsEl.scrollLeft + thumbsEl.clientWidth) thumbsEl.scrollLeft = r - thumbsEl.clientWidth + 4;
    return k;
  }, -1);
  // as wide as the Note's text allows (up to MAX_W), centred under the image but kept over the text
  // (an image card has no text around its image: centred under it)
  const place = () => {
    const { img, body: b } = box(),
      w = Math.min(MAX_W, Math.max(MIN_W, b.w - 16)),
      mid = img.x + img.w / 2 - w / 2,
      x = body ? Math.max(b.x + 8, Math.min(b.x + b.w - 8 - w, mid)) : mid;
    return { left: `${x}px`, top: `${img.y + img.h + 8}px`, width: `${w}px` };
  };
  return (
    <div
      class="animstrip"
      data-nodrag
      data-export="strip"
      style={place()}
      onPointerDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onWheel={(e) => {
        e.stopPropagation();
        e.preventDefault();
        thumbsEl.scrollLeft += e.deltaX || e.deltaY;
      }}
    >
      <button
        class="ib"
        aria-label={p.on() ? "Pause" : "Play"}
        data-tip={p.on() ? "Pause" : "Play"}
        data-kbd="Space"
        onClick={() => p.play(!p.on())}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d={p.on() ? PAUSE : PLAY} />
        </svg>
      </button>
      <div
        class="thumbs"
        ref={thumbsEl}
        style={{ "--th": `${THUMB_H}px` }}
        onClick={(e) => {
          const k = th.els.findIndex((el) => el.contains(e.target as Node));
          if (k >= 0) p.seek(th.frames[k]);
        }}
      />
      <span class="fno">
        {p.frame() + 1}/{p.count()}
      </span>
      <button
        class="ib loop"
        aria-pressed={p.loop}
        aria-label="Always Play"
        data-tip={
          p.loop ? "Always playing: click to show one frame" : "Always play (otherwise the board shows one frame)"
        }
        onClick={() => toggleLoop(p)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d={LOOP} />
        </svg>
      </button>
    </div>
  );
}
