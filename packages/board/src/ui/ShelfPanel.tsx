// The Shelf panel (the dock's Shelf button; actions/shelf.ts): one row per entry, newest first, with a small picture of it, what it
// is and when it was shelved. A row is dragged out onto the board, or Put Back where it was; its menu removes it. Also the dashed
// outline that follows the pointer while a row is dragged over the board (in the world layer, Canvas.tsx). Resting the pointer on a
// row shows the entry beside the panel as it was on the board: its Sections and its cards with their content, scaled down
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { cardTitle, type ShelfEntry } from "@codeboard/core";
import { shelfLabel } from "@codeboard/core/commands";
import { state, cardById } from "../state/store";
import { shelfHot, shelfOut } from "../state/shelf";
import { cam } from "../state/camera";
import { TIP_DELAY } from "../state/timing";
import { PvContent } from "../cards/SubPreviews";
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

/** The largest the preview of an entry gets on screen, and the most it is scaled (a single card: about as the board shows it) */
const PEEK_W = 560,
  PEEK_H = 460,
  PEEK_MAX = 0.8;
/** Lines of a code card drawn, at most (its card clips what does not fit) */
const PEEK_LINES = 80;
/** How long after a preview went away the next one shows at once (as the tips) */
const WARM = 800;

/** Where the preview of the entry under the pointer goes: beside the panel (right = from the right of the panel's parent),
 *  level with its row (top; room = the parent's height), measured once when it opens */
type PeekAt = { id: string; right: number; top: number; room: number };

/** An entry as it was on the board, scaled down: its Sections' frames with their titles, its cards with their content */
function ShelfPeek(p: { at: PeekAt }) {
  const e = createMemo(() => (state.board.shelf ?? []).find((x) => x.id === p.at.id));
  const lay = createMemo(() => {
    const en = e();
    const box = en && A.entryBox(en);
    if (!en || !box) return null;
    const k = Math.min(PEEK_MAX, PEEK_W / box.w, PEEK_H / box.h);
    const rel = (q: { x: number; y: number; w: number; h: number }) => ({
      left: `${q.x - box.x}px`,
      top: `${q.y - box.y}px`,
      width: `${q.w}px`,
      height: `${q.h}px`,
    });
    const r = A.entryRects(en);
    return {
      box,
      k,
      sections: en.sections.map((s) => ({ title: s.title, color: s.color, style: rel(s) })),
      cards: r.cards.flatMap((q) => {
        const c = cardById(q.id)?.card;
        return c ? [{ c, style: rel(q) }] : [];
      }),
    };
  });
  return (
    <Show when={lay()}>
      {(l) => {
        const h = () => l().box.h * l().k;
        return (
          <div
            class="shelf-peek pill"
            style={{
              right: `${p.at.right}px`,
              top: `${Math.max(8, Math.min(p.at.top, p.at.room - h() - 28))}px`,
              width: `${l().box.w * l().k}px`,
              height: `${h()}px`,
            }}
          >
            <div
              class="spk-world"
              style={{ width: `${l().box.w}px`, height: `${l().box.h}px`, transform: `scale(${l().k})` }}
            >
              <For each={l().sections}>
                {(s) => (
                  <div class="spk-sec" data-color={s.color} style={s.style}>
                    <span>{s.title}</span>
                  </div>
                )}
              </For>
              <For each={l().cards}>
                {(q) => (
                  <div class={`spk-card k-${q.c.kind}`} style={q.style}>
                    <div class="spk-h">{cardTitle(q.c, state.board)}</div>
                    <div class="spk-b">
                      <PvContent
                        data={{
                          card: q.c,
                          cols: q.c.kind === "compare" ? q.c.cols.flatMap((id) => cardById(id)?.card ?? []) : undefined,
                          views: state.views,
                        }}
                        t={q.c.title ?? ""}
                        lines={PEEK_LINES}
                      />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

export function ShelfPanel() {
  const rows = createMemo(() => [...(state.board.shelf ?? [])].reverse());
  let panel!: HTMLDivElement;
  const [peek, setPeek] = createSignal<PeekAt | null>(null);
  let t: ReturnType<typeof setTimeout> | undefined,
    warmUntil = 0;
  const hide = () => {
    clearTimeout(t);
    if (peek()) warmUntil = performance.now() + WARM;
    setPeek(null);
  };
  const show = (id: string, row: HTMLElement) => {
    clearTimeout(t);
    const open = () => {
      const par = (panel.offsetParent as HTMLElement | null) ?? document.body;
      const pr = par.getBoundingClientRect(),
        r = panel.getBoundingClientRect();
      setPeek({ id, right: pr.right - r.left + 10, top: row.getBoundingClientRect().top - pr.top, room: pr.height });
    };
    if (peek() || performance.now() < warmUntil) open();
    else t = setTimeout(open, TIP_DELAY);
  };
  // dragging a row out: no preview over the board
  createEffect(() => {
    if (shelfOut()) hide();
  });
  // put back or removed: its preview goes with it
  createEffect(() => {
    const at = peek();
    if (at && !rows().some((e) => e.id === at.id)) hide();
  });
  onCleanup(() => clearTimeout(t));
  return (
    <>
      <Show when={peek()}>{(at) => <ShelfPeek at={at()} />}</Show>
      <div
        ref={panel}
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
                  onPointerEnter={(ev) => show(e.id, ev.currentTarget)}
                  onPointerLeave={hide}
                  onPointerDown={(ev) => {
                    hide();
                    A.shelfRowDown(ev, e.id);
                  }}
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
    </>
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
