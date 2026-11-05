// The Shelf panel (the dock's Shelf button; actions/shelf.ts): one row per entry, newest first, with a small picture of it, what it
// is and when it was shelved. A row is dragged out onto the board, or Put Back where it was; its menu removes it. Also the dashed
// outline that follows the pointer while a row is dragged over the board (in the world layer, Canvas.tsx)
import { For, Show, createMemo } from "solid-js";
import type { ShelfEntry } from "@codeboard/core";
import { shelfLabel } from "@codeboard/core/commands";
import { state } from "../state/store";
import { shelfHot, shelfOut } from "../state/shelf";
import { cam } from "../state/camera";
import { Icon } from "./icons";
import * as A from "../actions";

/** When an entry was shelved, as its row says it: today, yesterday, Nov 3 */
function whenOf(at: number): string {
  const d = new Date(at),
    now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 864e5);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

const TW = 64,
  TH = 46,
  PAD = 5;
type Box = { x: number; y: number; w: number; h: number };
/** The row's picture: the entry's Sections (outlines) and cards (filled) as laid out, fitted in; a single card: a card glyph */
function Thumb(p: { e: ShelfEntry }) {
  const shape = createMemo((): { glyph?: "code" | "text"; sections: Box[]; cards: Box[] } => {
    const r = A.entryRects(p.e);
    const box = A.entryBox(p.e);
    if (!box) return { sections: [], cards: [] };
    if (!r.sections.length && r.cards.length === 1) {
      const kind = state.board.cards.find((c) => c.id === r.cards[0].id)?.kind;
      return { glyph: kind === "code" || kind === "compare" ? "code" : "text", sections: [], cards: [] };
    }
    const k = Math.min((TW - 2 * PAD) / box.w, (TH - 2 * PAD) / box.h);
    const ox = (TW - box.w * k) / 2,
      oy = (TH - box.h * k) / 2;
    const at = (q: Box): Box => ({
      x: +(ox + (q.x - box.x) * k).toFixed(1),
      y: +(oy + (q.y - box.y) * k).toFixed(1),
      w: +Math.max(2, q.w * k).toFixed(1),
      h: +Math.max(2, q.h * k).toFixed(1),
    });
    return { sections: r.sections.map(at), cards: r.cards.map(at) };
  });
  return (
    <svg class="sthumb" viewBox={`0 0 ${TW} ${TH}`} width={TW} height={TH} aria-hidden="true">
      <Show when={shape().glyph}>
        {(g) => (
          <>
            <rect class="tc" x="14" y="7" width="36" height="32" rx="2.5" />
            <path
              class={g() === "code" ? "tl code" : "tl"}
              d={g() === "code" ? "M19 15h14M22 20h20M22 25h16M19 30h10" : "M19 15h20M19 21h26M19 26h22M19 31h14"}
            />
          </>
        )}
      </Show>
      <For each={shape().sections}>{(r) => <rect class="ts" x={r.x} y={r.y} width={r.w} height={r.h} rx="2" />}</For>
      <For each={shape().cards}>{(r) => <rect class="tc" x={r.x} y={r.y} width={r.w} height={r.h} rx="1.5" />}</For>
    </svg>
  );
}

export function ShelfPanel() {
  const rows = createMemo(() => [...(state.board.shelf ?? [])].reverse());
  return (
    <div
      class="cpanel shelf pill"
      classList={{ hot: shelfHot() === "panel" }}
      data-nodrag
      onWheel={(e) => e.stopPropagation()}
    >
      <div class="cph">
        <b>Shelf</b>
        <Show when={rows().length}>
          <small>{rows().length}</small>
        </Show>
        <span class="grow" />
        <button class="ib" aria-label="Close Shelf" onClick={() => A.toggleShelf(false)}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div class="srows">
        <For
          each={rows()}
          fallback={
            <div class="empty sm">
              Nothing on the Shelf. Right-click a card or Section → Move to Shelf, or drag it onto the Shelf button.
            </div>
          }
        >
          {(e) => {
            const label = createMemo(() => shelfLabel(state.board, e));
            return (
              <div
                class="srow"
                classList={{ lift: shelfOut()?.id === e.id && !!shelfOut()?.at }}
                data-entry={e.id}
                onPointerDown={(ev) => A.shelfRowDown(ev, e.id)}
                onContextMenu={(ev) => A.shelfRowMenu(ev, e.id)}
              >
                <Thumb e={e} />
                <div class="smeta">
                  <div class="stt">{label().title}</div>
                  <div class="skind">
                    {label().kind} · {whenOf(e.at)}
                  </div>
                </div>
                <button class="tbtn sback" onClick={() => A.putBack(e.id)}>
                  Put Back
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={rows().length}>
        <div class="cpf">Drag onto the board, or Put Back where it was.</div>
      </Show>
    </div>
  );
}

/** The dashed outline of the entry being dragged out, where it will land (world coordinates; in the world layer) */
export function ShelfOutline() {
  const out = createMemo(() => {
    const o = shelfOut();
    const e = o?.at && (state.board.shelf ?? []).find((x) => x.id === o.id);
    const box = e && A.entryBox(e);
    if (!o?.at || !e || !box) return null;
    const r = A.entryRects(e);
    const rel = (q: { x: number; y: number; w: number; h: number }) => ({
      left: `${q.x - box.x}px`,
      top: `${q.y - box.y}px`,
      width: `${q.w}px`,
      height: `${q.h}px`,
    });
    return {
      at: o.at,
      box,
      title: shelfLabel(state.board, e).title,
      sections: r.sections.map(rel),
      cards: r.cards.map(rel),
    };
  });
  return (
    <Show when={out()}>
      {(o) => (
        <div
          class="shelf-outline"
          style={{
            left: `${o().at.x}px`,
            top: `${o().at.y}px`,
            width: `${o().box.w}px`,
            height: `${o().box.h}px`,
            "--ow": `${1.5 / cam.z}px`,
            "--os": String(1 / cam.z),
          }}
        >
          <span class="sol">{o().title}</span>
          <For each={o().sections}>{(s) => <div class="sos" style={s} />}</For>
          <For each={o().cards}>{(s) => <div class="soc" style={s} />}</For>
        </div>
      )}
    </Show>
  );
}
