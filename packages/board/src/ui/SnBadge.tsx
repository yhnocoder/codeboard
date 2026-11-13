// The badge of the sidenotes at a spot (core spotKey): how many there are, or an amber ? while a question there is open. A click
// opens their popup (ui/pops/notes.tsx NotesPop) and closes it again. Every badge is the same round one, BADGE world px with an
// invisible hit area at least HIT px on screen: a whole card's and a Note block's sit in a strip just past the card's right edge (clear of its link ports),
// at its header and at the block's first line; a Section's after its title; a free one on the canvas, where it can be dragged to
// another point or onto a card or a Note's block
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { questionOpen, spotKey, type Anchor, type BlockRef, type FreeAnchor, type Sidenote } from "@codeboard/core";
import { freeNotes, notesOf, sectionNotes } from "../state/ui";
import { pops } from "../state/pop";
import { blockBand, blockBandNow, noteBlockOf } from "../state/blocks";
import { cam, stillZ } from "../state/camera";
import { boardSignal } from "../state/root";
import { observeResize } from "../state/measure";
import { track } from "../gesture";
import * as A from "../actions";

/** A badge as drawn, in world pixels (styles.css .snb): it scales with the board like the rest of the card */
const BADGE = 14;
/** Its hit area, invisible, in world pixels at the camera's resting zoom: at least HIT px on screen, and never smaller than HIT
 *  world px (a gutter badge's too, cards/CodeBody.tsx) */
const HIT = 18;
export const badgeHit = () => Math.max(HIT, HIT / stillZ());
/** How far past the card's right edge the strip starts, in world pixels: clear of the link ports on the edge (drawn bigger when
 *  zoomed out, state/hover.ts portStyle) by 5px on screen */
const stripGap = () => {
  const z = stillZ();
  return 4.5 * Math.sqrt(Math.max(1, 1 / z)) + 5 / z;
};

function SnBadge(p: {
  spot: Anchor;
  notes: Sidenote[];
  class?: string;
  style?: Record<string, string>;
  onPointerDown?: (e: PointerEvent) => void;
}) {
  const ids = () => p.notes.map((n) => n.id);
  const ask = () => p.notes.some(questionOpen);
  return (
    <button
      class={`snb ${p.class ?? ""}`}
      classList={{ ask: ask(), none: !p.notes.length }}
      style={{ "--hit": `${badgeHit()}px`, ...p.style }}
      data-spot={spotKey(p.spot)}
      data-notes={ids().join(",")}
      data-nodrag
      onPointerDown={(e) => {
        e.stopPropagation();
        p.onPointerDown?.(e);
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (!p.onPointerDown) A.pinMarker(e.currentTarget, p.spot);
      }}
    >
      {ask() ? "?" : p.notes.length || ""}
    </button>
  );
}

/** Where a free badge being dragged would land: a card, or a block of a Note (shown tinted while it is over it) */
export type SpotAim = { card: string; block?: BlockRef; band?: { top: number; h: number } };
const [freeAim, setFreeAim] = boardSignal<SpotAim | null>(null);

/** A card's own sidenotes, on any card: the whole card's badge at its header, each Note block's at the block's first line, both
 *  just past its right edge; and the tint on a block whose popup is open or that a free badge is dragged over */
export function CardSpots(p: { card: string }) {
  let ref!: HTMLDivElement;
  const mine = createMemo(() => notesOf(p.card).filter((n) => !n.at.lines));
  const whole = () => mine().filter((n) => !n.at.block);
  const blocks = createMemo(() => {
    const m = new Map<string, { spot: Anchor; notes: Sidenote[] }>();
    for (const n of mine()) {
      if (!n.at.block) continue;
      const k = spotKey(n.at);
      const g = m.get(k);
      if (g) g.notes.push(n);
      else m.set(k, { spot: { card: p.card, block: n.at.block }, notes: [n] });
    }
    return [...m.values()];
  });
  // the header's middle (from the card's top): the whole card's badge sits there; a card with no header puts it near its top
  const [head, setHead] = createSignal(18);
  onMount(() => {
    const card = ref.closest<HTMLElement>(".card");
    const hd = card?.querySelector<HTMLElement>(
      ":scope > .cface > :is(.chead, .sbhead), :scope > .cface .cmpwrap > .chead",
    );
    if (!card || !hd) return setHead(16);
    const read = () => {
      const c = card.getBoundingClientRect(),
        h = hd.getBoundingClientRect(),
        k = c.height ? card.offsetHeight / c.height : 1;
      if (h.height) setHead((h.top - c.top + h.height / 2) * k);
    };
    read();
    onCleanup(observeResize(hd, read));
  });
  const at = (y: number) => ({ left: `calc(100% + ${stripGap()}px)`, top: `${y - BADGE / 2}px` });
  // the block whose popup is open (or a free badge is over): tinted
  const tint = createMemo(() => {
    const a = freeAim();
    if (a?.card === p.card && a.band) return a.band;
    for (const q of pops()) {
      if (q.pop.kind !== "notes" || q.pop.spot.card !== p.card || !q.pop.spot.block) continue;
      const blk = q.pop.spot.block;
      const g = blockBand(p.card, blk);
      if (g) return g;
      const el = noteBlockOf(p.card, blk);
      return el ? blockBandNow(el) : null;
    }
    return null;
  });
  return (
    <div ref={ref} class="snspots">
      <Show when={tint()}>
        {(t) => <div class="sntint" style={{ top: `${t().top - 4}px`, height: `${t().h + 8}px` }} />}
      </Show>
      <Show when={freeAim()?.card === p.card && !freeAim()?.band}>
        <div class="snaim" />
      </Show>
      <Show when={whole().length}>
        <SnBadge spot={{ card: p.card }} notes={whole()} class="side" style={at(head())} />
      </Show>
      <For each={blocks()}>
        {(g) => (
          <Show when={blockBand(p.card, g.spot.block!)}>
            {(b) => <SnBadge spot={g.spot} notes={g.notes} class="side" style={at(b().top + b().line / 2)} />}
          </Show>
        )}
      </For>
    </div>
  );
}

/** The free sidenotes' badges on the canvas (in the world layer), and one for a free spot whose popup is open with nothing in it yet */
export function FreeSpots() {
  const groups = createMemo(() => {
    const m = new Map<string, { spot: FreeAnchor; notes: Sidenote[] }>();
    for (const n of freeNotes()) {
      if (n.at.card !== undefined || n.at.section !== undefined) continue;
      const k = spotKey(n.at);
      const g = m.get(k);
      if (g) g.notes.push(n);
      else m.set(k, { spot: { x: n.at.x, y: n.at.y }, notes: [n] });
    }
    for (const q of pops()) {
      const s = q.pop.kind === "notes" ? q.pop.spot : undefined;
      if (s && s.card === undefined && s.section === undefined && !m.has(spotKey(s)))
        m.set(spotKey(s), { spot: s, notes: [] });
    }
    return m;
  });
  // keyed by spot, so a badge being dragged stays the same element while popups open and close around it
  const keys = createMemo(() => [...groups().keys()], [], {
    equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]),
  });
  return (
    <div class="freespots">
      <For each={keys()}>
        {(k) => <Show when={groups().get(k)}>{(g) => <FreeSpot spot={g().spot} notes={g().notes} />}</Show>}
      </For>
    </div>
  );
}

function FreeSpot(p: { spot: FreeAnchor; notes: Sidenote[] }) {
  const [off, setOff] = createSignal<{ x: number; y: number } | null>(null);
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const sx = e.clientX,
      sy = e.clientY;
    track(
      e,
      (ev) => {
        if (!off()) A.freeDragStart();
        setOff({ x: (ev.clientX - sx) / cam.z, y: (ev.clientY - sy) / cam.z });
        setFreeAim(p.notes.length ? A.spotAim(ev.clientX, ev.clientY) : null);
      },
      (ev, moved) => {
        setOff(null);
        const aim = freeAim();
        setFreeAim(null);
        const ids = p.notes.map((n) => n.id);
        if (!moved) return A.pinMarker(el, p.spot);
        if (!ids.length) return;
        A.dropFreeNotes(ids, aim, p.spot.x + (ev.clientX - sx) / cam.z, p.spot.y + (ev.clientY - sy) / cam.z);
      },
    );
  };
  onCleanup(() => setFreeAim(null));
  return (
    <SnBadge
      spot={p.spot}
      notes={p.notes}
      class={off() ? "free moving" : "free"}
      style={{ left: `${p.spot.x + (off()?.x ?? 0)}px`, top: `${p.spot.y + (off()?.y ?? 0)}px` }}
      onPointerDown={down}
    />
  );
}

/** A Section's sidenotes: the badge after its title */
export function SectionSpot(p: { section: string }) {
  const notes = () => sectionNotes(p.section);
  return (
    <Show when={notes().length}>
      <SnBadge spot={{ section: p.section }} notes={notes()} class="insect" />
    </Show>
  );
}
