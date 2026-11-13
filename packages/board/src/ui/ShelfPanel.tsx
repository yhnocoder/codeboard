// The Shelf panel (the dock's Shelf button; actions/shelf.ts): one thumbnail per entry, in the order the entries were on the
// board, each a picture of its Sections, cards and the arrows among them as the board draws them. A thumbnail clicked shows its
// entry large beside the panel, with Put Back; dragged out, the entry lands where it is let go; its menu puts it back or removes
// it; resting on it outlines on the board where it returns to. Also those outlines (in the world layer, Canvas.tsx)
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js";
import {
  cardTitle,
  codeGlyph,
  isTextCard,
  textSizeOf,
  commonIndent,
  escHtml,
  mdHeading,
  type Card,
  type CodeCard,
  type Rect,
  type ShelfEntry,
} from "@codeboard/core";
import { shelfLabel } from "@codeboard/core/commands";
import { state, cardById } from "../state/store";
import { shelfHot, shelfHover, shelfOut, shelfPeek, setShelfPeek } from "../state/shelf";
import { cam } from "../state/camera";
import { animScale } from "../state/motion";
import { PvContent } from "../cards/SubPreviews";
import { boxFill, hidesHeading } from "../cards/NoteBody";
import { attrSel, cardKindClass } from "../cardsel";
import { MdStatic } from "./Md";
import { Icon } from "./icons";
import { useOverlay } from "./overlay";
import * as A from "../actions";

/** Where q is inside box, as a style */
const relStyle = (q: Rect, box: { x: number; y: number }): JSX.CSSProperties => ({
  left: `${q.x - box.x}px`,
  top: `${q.y - box.y}px`,
  width: `${q.w}px`,
  height: `${q.h}px`,
});
const entryById = (id: string) => (state.board.shelf ?? []).find((x) => x.id === id);

/** Lines of a code card drawn, at most (the card clips what does not fit) */
const MINI_LINES = 60;

/** A code card's lines as the board draws them (its gutter, the common indentation hidden), at most MINI_LINES */
function MiniCode(p: { c: CodeCard }) {
  const rows = createMemo(() => {
    const out: { no: number; html: string; text: string }[] = [];
    for (const s of p.c.segments) {
      const v = state.views[s.id];
      for (let i = 0; i < s.text.length && out.length < MINI_LINES; i++)
        out.push({ no: s.start + i, html: v?.html[i] ?? escHtml(s.text[i]), text: s.text[i] });
    }
    return out;
  });
  const ded = () => commonIndent(rows().map((r) => r.text));
  const digits = () => String(rows().at(-1)?.no ?? 0).length;
  return (
    <div class="code" style={{ "--nd": String(digits()) }}>
      <div class="gutter">
        <For each={rows()}>
          {(r, i) => (
            <span class="no" style={{ top: `calc(var(--code-pt) + ${i() * 20}px)` }}>
              {r.no}
            </span>
          )}
        </For>
      </div>
      <div class="src" classList={{ ded: !!ded() }} style={{ "--ded": ded() }}>
        <For each={rows()}>{(r) => <div class="l" innerHTML={r.html || "\u200b"} />}</For>
      </div>
    </div>
  );
}

/** Text and Box draw at their own size and fill, as Card.tsx sets them on the card */
const textVars = (k: Card): JSX.CSSProperties =>
  isTextCard(k)
    ? { "--tfs": `${textSizeOf(k)}px`, ...(k.look === "box" ? { "--fc": `var(--bf-${boxFill(k)})` } : {}) }
    : {};

/** A card's body as the board draws it, read-only */
function MiniBody(p: { c: Card }) {
  return (
    <>
      {(() => {
        const k = p.c;
        if (k.kind === "note")
          switch (k.look) {
            case "note":
              return (
                <>
                  <div class="chead">
                    <span class="kind">¶</span>
                    <span class="ctitle sys">{k.title || mdHeading(k.md) || "Note"}</span>
                  </div>
                  <MdStatic src={k.md} class={`nbody${hidesHeading(k) ? " hidehead" : ""}`} />
                </>
              );
            default:
              return <MdStatic src={k.md} class="tx tb st-body" />;
          }
        return (
          <>
            <div class="chead">
              <Show when={k.kind === "code"}>
                <span class="kind">{k.kind === "code" ? codeGlyph(k) : ""}</span>
              </Show>
              <span class="ctitle">{cardTitle(k, state.board)}</span>
            </div>
            <div class="carea">
              <div class="cbody">
                {k.kind === "code" ? (
                  <MiniCode c={k} />
                ) : (
                  <PvContent
                    data={{
                      card: k,
                      cols: k.kind === "compare" ? k.cols.flatMap((id) => cardById(id)?.card ?? []) : undefined,
                      views: state.views,
                    }}
                    t={k.title ?? ""}
                    lines={MINI_LINES}
                  />
                )}
              </div>
            </div>
          </>
        );
      })()}
    </>
  );
}

/**
 * An entry's picture at board size, scaled by whoever shows it: its Sections' frames and titles, its cards (the board's own card
 * classes, so each theme draws them as on the board) and the arrows among them, straight
 */
function MiniWorld(p: { e: ShelfEntry; box: Rect }) {
  const lay = createMemo(() => {
    const r = A.entryRects(p.e);
    const at = new Map(r.cards.map((c) => [c.id, c]));
    const hostOf = (id: string) => at.get(id) ?? at.get(cardById(id)?.host.id ?? "");
    const lines = p.e.links.flatMap((l) => {
      const a = hostOf(l.from.card),
        b = hostOf(l.to.card);
      if (!a || !b || a === b) return [];
      // from edge to edge, on the line between the two centers
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 },
        cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const dx = cb.x - ca.x,
        dy = cb.y - ca.y;
      const edge = (q: Rect, c: { x: number; y: number }, sx: number, sy: number) => {
        const t = Math.min(sx ? q.w / 2 / Math.abs(sx) : Infinity, sy ? q.h / 2 / Math.abs(sy) : Infinity);
        return { x: c.x + sx * t - p.box.x, y: c.y + sy * t - p.box.y };
      };
      return [{ a: edge(a, ca, dx, dy), b: edge(b, cb, -dx, -dy) }];
    });
    return {
      sections: p.e.sections.map((s) => ({ s, style: relStyle(s, p.box) })),
      cards: r.cards.flatMap((q) => {
        const c = cardById(q.id)?.card;
        return c ? [{ c, style: relStyle(q, p.box) }] : [];
      }),
      lines,
    };
  });
  return (
    <>
      <For each={lay().sections}>
        {(x) => <div class={`sect${x.s.color ? ` c-${x.s.color}` : ""}`} style={x.style} />}
      </For>
      <svg class="shlinks" width={p.box.w} height={p.box.h} aria-hidden="true">
        <For each={lay().lines}>{(l) => <line x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} />}</For>
      </svg>
      <For each={lay().cards}>
        {(x) => (
          <div class={`card ${cardKindClass(x.c)}`} style={{ ...x.style, ...textVars(x.c) }}>
            <div class="cface">
              <MiniBody c={x.c} />
            </div>
          </div>
        )}
      </For>
      <For each={lay().sections}>
        {(x) => (
          <div
            class={`slabel${x.s.color ? ` c-${x.s.color}` : ""}`}
            style={{ left: `${x.s.x - p.box.x}px`, top: `${x.s.y - p.box.y}px` }}
          >
            <div class="sname">{x.s.title}</div>
          </div>
        )}
      </For>
    </>
  );
}

/** A thumbnail's width, the room around its picture (px) and the most a picture is scaled (a small card stays a thumbnail) */
const THUMB_W = 276,
  THUMB_PAD = 8,
  THUMB_MAX = 0.6;
/** A thumbnail's size for an entry box and how its picture sits in it (scale k, top left ox, oy): as wide as the panel's list,
 *  as tall as the entry's shape says, within limits */
function thumbFit(box: Rect) {
  const w = THUMB_W,
    inner = w - 2 * THUMB_PAD;
  const fit = Math.min(THUMB_MAX, inner / box.w);
  const h = Math.round(Math.min(w * 0.75, Math.max(w * 0.3, 2 * THUMB_PAD + box.h * fit)));
  const k = Math.min(fit, (h - 2 * THUMB_PAD) / box.h);
  return { w, h, k, ox: (w - box.w * k) / 2, oy: (h - box.h * k) / 2 };
}

function Thumb(p: { id: string }) {
  const e = createMemo(() => entryById(p.id));
  const box = createMemo(() => {
    const en = e();
    return en && A.entryBox(en);
  });
  return (
    <Show when={e() && box() && { e: e()!, box: box()! }}>
      {(x) => {
        const f = () => thumbFit(x().box);
        const label = () => {
          const l = shelfLabel(state.board, x().e);
          return `${l.title}, ${l.kind}`;
        };
        return (
          <div
            class="shthumb"
            classList={{ lift: !!shelfOut()?.at && shelfOut()?.id === p.id, on: shelfPeek() === p.id }}
            data-entry={p.id}
            role="button"
            aria-label={label()}
            aria-expanded={shelfPeek() === p.id}
            style={{ width: `${f().w}px`, height: `${f().h}px` }}
            onPointerEnter={() => A.hoverThumb(p.id)}
            onPointerLeave={() => A.leaveThumb(p.id)}
            onPointerDown={(ev) => A.shelfThumbDown(ev, p.id)}
            onContextMenu={(ev) => A.shelfThumbMenu(ev, p.id)}
          >
            <div
              class="shmini"
              inert
              style={{
                width: `${x().box.w}px`,
                height: `${x().box.h}px`,
                transform: `translate(${f().ox}px, ${f().oy}px) scale(${f().k})`,
              }}
            >
              <MiniWorld e={x().e} box={x().box} />
            </div>
          </div>
        );
      }}
    </Show>
  );
}

/** The largest the large picture gets on screen, and the most it is scaled (a single card: about as the board shows it) */
const PEEK_W = 560,
  PEEK_H = 460,
  PEEK_MAX = 0.8;
/** The large picture's padding, its gap to the panel and to the edges of the window and the toolbars (px) */
const PEEK_PAD = 12,
  PEEK_GAP = 10,
  PEEK_EDGE = 8;

/**
 * Where the large picture of a box this size goes (in the panel's parent) and its scale: left of the panel, level with the
 * thumbnail, or under the panel when there is more room there (a narrow window); never over the panel or the toolbars at the foot
 */
function peekSpot(panel: HTMLElement, id: string, box: Rect): { left: number; top: number; k: number } {
  const par = (panel.offsetParent as HTMLElement | null) ?? document.body;
  const pr = par.getBoundingClientRect(),
    r = panel.getBoundingClientRect();
  const thumb = panel.querySelector(`.shthumb${attrSel("data-entry", id)}`)?.getBoundingClientRect();
  let foot = pr.bottom;
  for (const bar of document.querySelectorAll(".over.bbar > .pill, .over.dock > .pill")) {
    const q = bar.getBoundingClientRect();
    if (q.height > 0) foot = Math.min(foot, q.top);
  }
  const fit = (w: number, h: number) =>
    Math.min(PEEK_MAX, PEEK_W / box.w, PEEK_H / box.h, (w - 2 * PEEK_PAD) / box.w, (h - 2 * PEEK_PAD) / box.h);
  const left = { l: pr.left + PEEK_EDGE, r: r.left - PEEK_GAP, t: pr.top + PEEK_EDGE, b: foot - PEEK_GAP };
  const under = { l: pr.left + PEEK_EDGE, r: r.right, t: r.bottom + PEEK_GAP, b: foot - PEEK_GAP };
  const kl = fit(left.r - left.l, left.b - left.t),
    ku = fit(under.r - under.l, under.b - under.t);
  const a = kl >= ku ? left : under,
    k = Math.max(0.01, kl, ku);
  const w = box.w * k + 2 * PEEK_PAD,
    h = box.h * k + 2 * PEEK_PAD;
  const want = a === left ? (thumb?.top ?? r.top) : a.t;
  return { left: a.r - w - pr.left, top: Math.max(a.t, Math.min(want, a.b - h)) - pr.top, k };
}

/**
 * The entry whose thumbnail was clicked, large, beside the panel: the same picture (it cannot be used), and one button that puts
 * the entry back where it was. Esc, a click elsewhere or a second click on the thumbnail closes it
 */
function ShelfPeek(p: { id: string; panel: HTMLElement }) {
  const e = createMemo(() => entryById(p.id));
  const box = createMemo(() => {
    const en = e();
    return en && A.entryBox(en);
  });
  useOverlay({
    close: () => setShelfPeek(null),
    inside: (t) => !!t.closest(".shelf-peek") || !!t.closest(`.shthumb${attrSel("data-entry", p.id)}`),
    outside: true,
  });
  // placed again when the window or the panel changes size
  const [tick, setTick] = createSignal(0);
  const again = () => setTick((n) => n + 1);
  const ro = new ResizeObserver(again);
  ro.observe(p.panel);
  window.addEventListener("resize", again);
  onCleanup(() => {
    ro.disconnect();
    window.removeEventListener("resize", again);
  });
  return (
    <Show when={e() && box() && { e: e()!, box: box()! }}>
      {(x) => {
        const spot = createMemo(() => {
          tick();
          return peekSpot(p.panel, p.id, x().box);
        });
        return (
          <div
            class="shelf-peek pill"
            data-entry={p.id}
            style={{
              left: `${spot().left}px`,
              top: `${spot().top}px`,
              width: `${x().box.w * spot().k}px`,
              height: `${x().box.h * spot().k}px`,
            }}
          >
            <div
              class="shmini"
              inert
              style={{ width: `${x().box.w}px`, height: `${x().box.h}px`, transform: `scale(${spot().k})` }}
            >
              <MiniWorld e={x().e} box={x().box} />
            </div>
            <button class="ib spk-back" aria-label="Put Back" data-tip="Put Back" onClick={() => A.putBack(p.id)}>
              <Icon name="place" />
            </button>
          </div>
        );
      }}
    </Show>
  );
}

/** How long the thumbnails that stay take to slide to their new places when the order changes (ms) */
const SLIDE_MS = 260;

export function ShelfPanel() {
  const order = createMemo(() => A.shelfInOrder().map((e) => e.id), [], {
    equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  });
  let panel!: HTMLDivElement, list!: HTMLDivElement;
  // put back, removed or undone: its large picture goes with it
  createEffect(() => {
    const id = shelfPeek();
    if (id && !order().includes(id)) setShelfPeek(null);
  });
  // the order changed (an entry came, went or moved): the thumbnails that stay slide from where they were, so none jumps
  let tops = new Map<string, number>();
  createEffect(
    on(order, () => {
      const els = [...list.querySelectorAll<HTMLElement>(".shthumb[data-entry]")];
      const now = new Map(els.map((el) => [el.dataset.entry!, el.offsetTop]));
      for (const el of els) {
        const was = tops.get(el.dataset.entry!),
          top = now.get(el.dataset.entry!)!;
        if (was !== undefined && was !== top)
          el.animate([{ translate: `0 ${was - top}px` }, { translate: "0 0" }], {
            duration: SLIDE_MS * animScale(),
            easing: "cubic-bezier(.2,.7,.25,1)",
          });
      }
      tops = now;
    }),
  );
  return (
    <>
      <Show when={shelfPeek()} keyed>
        {(id) => <ShelfPeek id={id} panel={panel} />}
      </Show>
      <div
        ref={panel}
        class="cpanel shelf pill"
        classList={{ hot: shelfHot() === "panel" }}
        data-nodrag
        onWheel={(e) => e.stopPropagation()}
      >
        <div class="cph">
          <b>Shelf</b>
          <Show when={order().length}>
            <small>{order().length}</small>
          </Show>
          <span class="grow" />
          <button class="ib" aria-label="Close Shelf" onClick={() => A.toggleShelf(false)}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div ref={list} class="srows">
          <For
            each={order()}
            fallback={
              <div class="empty sm">
                Nothing on the Shelf. Right-click a card or Section → Move to Shelf, or drag it onto the Shelf button.
              </div>
            }
          >
            {(id) => <Thumb id={id} />}
          </For>
        </div>
      </div>
    </>
  );
}

/**
 * The outline of an entry on the board: dashed where a thumbnail dragged out will land, or where the entry of the thumbnail the
 * pointer rests on returns to, while some of that is in the part of the board that is seen (world coordinates; in the world layer)
 */
export function ShelfOutline() {
  const out = createMemo(() => {
    const o = shelfOut(),
      hover = shelfHover();
    const id = o ? (o.at ? o.id : null) : hover?.id;
    const e = id ? entryById(id) : undefined;
    const box = e && A.entryBox(e);
    if (!e || !box) return null;
    if (!o && hover && !A.partSeen(box, hover.seen)) return null;
    const r = A.entryRects(e);
    return {
      home: !o,
      at: o?.at ?? { x: box.x, y: box.y },
      box,
      parts: [
        ...r.sections.map((s) => ({ s: true, style: relStyle(s, box) })),
        ...r.cards.map((c) => ({ s: false, style: relStyle(c, box) })),
      ],
    };
  });
  return (
    <Show when={out()}>
      {(o) => (
        <div
          class="shelf-outline"
          classList={{ home: o().home }}
          style={{
            left: `${o().at.x}px`,
            top: `${o().at.y}px`,
            width: `${o().box.w}px`,
            height: `${o().box.h}px`,
            "--ow": `${1.5 / cam.z}px`,
          }}
        >
          <For each={o().parts}>{(q) => <div class={q.s ? "sos" : "soc"} style={q.style} />}</For>
        </div>
      )}
    </Show>
  );
}
