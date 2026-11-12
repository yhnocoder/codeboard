// The control bar of an animated image in a Note or an image card (md/anim.ts): a capsule floating over the bottom of the image,
// inside the image's overlay, so it zooms with the board and never changes the layout. Previous frame, play / pause, next frame, a
// scrubber, the frame number and the button that makes the image always play. It fades in while the image is hovered, and stays
// while the image is selected, while its scrubber is dragged or while it stands paused away from its snapshot; zoomed out below
// CONTROLS_MIN_Z it is not shown. Every event on it stays on it: the Note or card under it never sees a press, click or menu.
// Scrubbing draws the frame and moves the knob with a transform: nothing is laid out again per move
import { createMemo, createSignal, type Accessor } from "solid-js";
import { cam } from "../state/camera";
import { track } from "../gesture";
import type { Player } from "../md/anim";

/** Below this zoom the bar is too small to use: hidden */
const CONTROLS_MIN_Z = 0.5;
/** The bar's width at its smallest (the scrubber at its minimum) plus a margin each side, in board px: a narrower image draws its
 *  bar scaled down to fit (md/anim.ts place sets --fit) */
export const BAR_MIN_W = 226;

const PREV = "M3 3h2v10H3zM13 3v10L6 8z",
  NEXT = "M11 3h2v10h-2zM3 3v10l7-5z",
  PLAY = "M4 2.5v11L13 8z",
  PAUSE = "M4 3h3v10H4zM9 3h3v10H9z",
  LOOP =
    "M3 6.5a3.5 3.5 0 0 1 3.5-3.5H11V1.5L14 4l-3 2.5V5H6.5A1.5 1.5 0 0 0 5 6.5V8H3zM13 9.5A3.5 3.5 0 0 1 9.5 13H5v1.5L2 12l3-2.5V11h4.5A1.5 1.5 0 0 0 11 9.5V8h2z";

const icon = (d: string) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} />
  </svg>
);
const keep = (e: Event) => e.stopPropagation();

export function AnimBar(o: {
  p: Player;
  selected: Accessor<boolean>;
  /** Selects the image (and a Note image's Note) before the bar acts on it */
  grab: () => void;
  toggleLoop: () => void;
}) {
  const p = o.p;
  const [scrubbing, setScrubbing] = createSignal(false);
  const near = createMemo(() => cam.z >= CONTROLS_MIN_Z);
  // paused by the user on another frame than its snapshot (or an always-playing image paused)
  const held = () => p.want() === false && (p.loop || p.frame() !== p.stored);
  const shown = createMemo(() => near() && p.count() > 1 && (p.hovered() || o.selected() || scrubbing() || held()));
  const pos = () => (p.count() > 1 ? p.frame() / (p.count() - 1) : 0);
  const act = (f: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    f();
  };
  let scrub!: HTMLDivElement;
  const scrubDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    o.grab();
    // the track's place is read once: the camera does not move while the pointer is held
    const r = scrub.getBoundingClientRect(),
      at = (ev: PointerEvent) =>
        Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (p.count() - 1));
    setScrubbing(true);
    p.seek(at(e));
    const end = () => setScrubbing(false);
    track(e, (ev) => p.seek(at(ev)), end, 0, end);
  };
  return (
    <div
      class="animbar"
      classList={{ on: shown() }}
      data-nodrag
      on:pointerdown={(e) => {
        e.stopPropagation();
        if (e.button === 0) o.grab();
      }}
      on:mousedown={(e) => e.preventDefault()}
      on:click={keep}
      on:dblclick={keep}
      on:contextmenu={keep}
      on:pointerenter={p.hover}
      on:pointerleave={p.hover}
    >
      <button
        class="ib"
        aria-label="Previous Frame"
        data-tip="Previous Frame"
        data-kbd="←"
        on:click={act(() => p.step(-1))}
      >
        {icon(PREV)}
      </button>
      <button
        class="ib"
        aria-label={p.on() ? "Pause" : "Play"}
        data-tip={p.on() ? "Pause" : "Play"}
        data-kbd="Space"
        on:click={act(() => p.play(!p.on()))}
      >
        {icon(p.on() ? PAUSE : PLAY)}
      </button>
      <button class="ib" aria-label="Next Frame" data-tip="Next Frame" data-kbd="→" on:click={act(() => p.step(1))}>
        {icon(NEXT)}
      </button>
      <div
        class="scrub"
        ref={scrub}
        role="slider"
        aria-label="Frame"
        aria-valuemin={1}
        aria-valuemax={p.count()}
        aria-valuenow={p.frame() + 1}
        classList={{ held: scrubbing() }}
        on:pointerdown={scrubDown}
      >
        <i style={{ transform: `scaleX(${pos()})` }} />
        <span style={{ transform: `translateX(${pos() * 100}%)` }}>
          <b />
        </span>
      </div>
      {/* the number is drawn from an attribute: no text in the Note's static view (find and selection map its text) */}
      <span class="fno" data-n={`${p.frame() + 1}/${p.count()}`} />
      <button
        class="ib loop"
        aria-pressed={p.loop}
        aria-label="Always Play"
        data-tip={
          p.loop ? "Always playing: click to show one frame" : "Always play (otherwise the board shows one frame)"
        }
        on:click={act(o.toggleLoop)}
      >
        {icon(LOOP)}
      </button>
    </div>
  );
}
