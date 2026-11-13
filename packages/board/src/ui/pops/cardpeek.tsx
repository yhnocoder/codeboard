// A card's preview in place: the beginning of a card as the board draws it (same look, the code and Notes as they are now), its
// header and first lines, scaled down to PEEK_W wide and cut at PEEK_H with a fade. It does not scroll: the card itself is one
// click away, on the arrow inside it. Shown beside what asked for it, always on its right where one looks for it (moved in just
// enough when the window has no room there, never to the other side); dragged by its head it stays where it is put:
// - a click on a [[reference]] to a card of this board toggles it (cardPeeks): in a Text sidenote beside its popup, in a Note
//   or any other Markdown on a card beside that card at the reference's height (so it covers none of the text being read), also
//   while the Note is being edited; Esc or a press anywhere else closes it, and while it shows, an unpinned sidenote popup it
//   came from stays (actions/notes.ts scheduleHideNotes). It follows its reference as the board pans and zooms;
// - the [[ list of the sidenote input shows its highlighted card's (ui/NoteComposer.tsx): passive, no keys, no arrow.
// It is a copy of the card's element taken once when it opens (nothing measured per frame), inert, with nothing that selectors
// for the board's cards would find
import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { computePosition, offset, shift, type VirtualElement } from "@floating-ui/dom";
import type { RefTarget } from "@yhnocoder/markdown";
import { cam } from "../../state/camera";
import { cardById, hostOf } from "../../state/store";
import { CARD_STATE_CLASSES, cardSel } from "../../cardsel";
import { useOverlay } from "../overlay";
import * as A from "../../actions";
import { Icon } from "../icons";
import { track } from "../../gesture";

/** About twelve code lines under the card's header */
const PEEK_W = 520,
  PEEK_H = 280,
  /** its padding on both sides and a margin from the window's edges */
  PEEK_EDGE = 2 * (12 + 8);

/** What a card's inline style gets from its animations and tilt, not its look */
const STATE_STYLES = ["rotate", "transform", "translate", "scale", "transform-origin", "opacity", "transition"];

/** Card `id`'s element on this board, when it is drawn (a Compare's column: the Compare) */
export const cardElement = (id: string) =>
  document.querySelector<HTMLElement>(cardSel(id)) ?? document.querySelector<HTMLElement>(cardSel(hostOf(id)));

type Beside = Element | VirtualElement;
/**
 * What a reference's preview is placed beside: the card the reference is on, at the reference's height (right of it), so the
 * preview leaves the card's text readable; a reference on no card, the reference itself
 */
function besideCard(at: HTMLElement): Beside {
  const card = at.closest(".card");
  if (!card) return at;
  return {
    contextElement: at,
    getBoundingClientRect: () => {
      const c = card.getBoundingClientRect(),
        r = at.getBoundingClientRect();
      return new DOMRect(c.left, r.top, c.width, r.height);
    },
  };
}

/** The preview a place shows at a time: which card, from which reference (its second click closes it), beside which box */
type Peek = { card: string; at: HTMLElement; beside: Beside };
export function cardPeeks() {
  const [peek, setPeek] = createSignal<Peek | null>(null);
  return {
    peek,
    /**
     * A click on a reference (el) that points to `to`: a card drawn on this board opens its preview beside `beside` (by default
     * beside the card the reference is on), or closes it when it is the one open from there. False for anything else (a Section,
     * another board, a card inside a sub-board), which the click goes to as usual
     */
    toggle(to: RefTarget, el: HTMLElement, beside: Beside = besideCard(el)) {
      if (to.place || !cardById(to.id) || !cardElement(to.id)) return false;
      const p = peek();
      setPeek(p?.card === to.id && p.at === el ? null : { card: to.id, at: el, beside });
      return true;
    },
    hide: () => setPeek(null),
  };
}
export type CardPeeks = ReturnType<typeof cardPeeks>;

/** The previews of `peeks`, where they are shown */
export function CardPeekOf(p: { peeks: CardPeeks }) {
  return (
    <Show when={p.peeks.peek()} keyed>
      {(pk) => <CardPeek id={pk.card} at={pk.at} beside={pk.beside} peeks={p.peeks} />}
    </Show>
  );
}

/** The preview of card `id` beside `beside`; with `peeks` it is one a click opened (Esc, a press elsewhere, its arrow) */
export function CardPeek(p: { id: string; at: HTMLElement; beside: Beside; peeks?: CardPeeks }) {
  let el!: HTMLDivElement, stage!: HTMLDivElement;
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
  const [cut, setCut] = createSignal(false);
  // dragged by its head: where it was put, from its reference's top left (it goes along as the board pans and zooms)
  const [put, setPut] = createSignal<{ x: number; y: number } | null>(null);
  const [grip, setGrip] = createSignal(0);
  const peeks = p.peeks;
  if (peeks) {
    // Esc closes the preview first (a popup under it stays, a Note being edited goes on), also with the caret in an editor; a
    // press anywhere but the preview and the reference that opened it (its second click toggles it) closes it
    useOverlay({
      close: () => peeks.hide(),
      inside: (t) => el.contains(t) || p.at.contains(t),
      outside: true,
      grab: true,
    });
    // closed with the pointer elsewhere: an unpinned popup it kept open goes too
    onCleanup(() => A.scheduleHideNotes());
    // its reference drawn again (a double-click opened its source in the editor, the text around it was edited): nothing to
    // point at any more
    const root = p.at.closest(".md");
    if (root) {
      const mo = new MutationObserver(() => {
        if (!p.at.isConnected) peeks.hide();
      });
      mo.observe(root, { childList: true, subtree: true });
      onCleanup(() => mo.disconnect());
    }
  }
  onMount(() => {
    const src = cardElement(p.id);
    if (src) {
      const w = src.offsetWidth,
        h = src.offsetHeight,
        // no wider than the window (a narrow panel or a phone) keeps all of it, its arrow too, on screen
        room = Math.max(120, Math.min(PEEK_W, innerWidth - PEEK_EDGE)),
        k = Math.min(1, room / Math.max(1, w));
      const c = src.cloneNode(true) as HTMLElement;
      c.classList.remove(...CARD_STATE_CLASSES);
      for (const s of STATE_STYLES) c.style.removeProperty(s);
      for (const e of [
        c,
        ...c.querySelectorAll<HTMLElement>("[data-id], [data-notes], [data-card], [contenteditable]"),
      ]) {
        e.removeAttribute("data-id");
        e.removeAttribute("data-notes");
        e.removeAttribute("data-card");
        e.removeAttribute("contenteditable");
      }
      Object.assign(c.style, {
        left: "0px",
        top: "0px",
        width: `${w}px`,
        transform: `scale(${k})`,
        transformOrigin: "0 0",
      });
      stage.style.width = `${Math.ceil(w * k)}px`;
      stage.style.height = `${Math.ceil(Math.min(h * k, PEEK_H))}px`;
      stage.appendChild(c);
      setCut(h * k > PEEK_H + 1);
      // the head it is dragged by: the card's header as drawn in it, with the padding above
      const head = src.querySelector<HTMLElement>(".chead");
      setGrip(Math.min(PEEK_H, (head ? head.offsetTop + head.offsetHeight : 32) * k) + 12);
    }
    reposition();
  });
  let n = 0;
  function reposition() {
    // its reference is gone (the Note it is in started or stopped editing, the text around it changed): nothing to point at
    if (!p.at.isConnected) return peeks?.hide();
    const k = ++n,
      at = untrack(put);
    if (at) {
      const r = p.at.getBoundingClientRect();
      return setPos({ x: r.left + at.x, y: r.top + at.y });
    }
    void computePosition(p.beside, el, {
      placement: "right-start",
      strategy: "fixed",
      middleware: [offset(10), shift({ padding: 8, crossAxis: true })],
    }).then((r) => {
      if (k === n) setPos({ x: r.x, y: r.y });
    });
  }
  function drag(e: PointerEvent) {
    const from = untrack(pos);
    if (e.button !== 0 || !from) return;
    e.preventDefault();
    e.stopPropagation();
    n++; // a placing still on its way lands nowhere
    const sx = e.clientX,
      sy = e.clientY;
    el.classList.add("held");
    track(
      e,
      (ev) => {
        const x = from.x + ev.clientX - sx,
          y = from.y + ev.clientY - sy,
          r = p.at.getBoundingClientRect();
        setPut({ x: x - r.left, y: y - r.top });
        setPos({ x, y });
      },
      () => el.classList.remove("held"),
      0,
      () => el.classList.remove("held"),
    );
  }
  // beside its reference as the camera moves
  createEffect(() => {
    void cam.x;
    void cam.y;
    void cam.z;
    if (untrack(pos)) reposition();
  });
  return (
    <Portal mount={p.at.closest(".app") ?? document.querySelector(".app") ?? undefined}>
      <div
        ref={el}
        class="cpeek"
        classList={{ show: !!pos(), cut: cut(), passive: !peeks }}
        style={{ left: `${pos()?.x ?? 0}px`, top: `${pos()?.y ?? 0}px` }}
        data-nodrag
        onPointerEnter={() => A.cancelHideNotes()}
      >
        <div ref={stage} class="cpeek-stage" inert />
        <Show when={peeks && grip()}>
          <div class="cpeek-grip" style={{ height: `${grip()}px` }} onPointerDown={drag} />
        </Show>
        <Show when={peeks}>
          {(pk) => (
            <button
              class="ib cpeek-go"
              aria-label="Go to Card"
              data-tip="Go to Card"
              onClick={() => {
                pk().hide();
                A.openCardRef(p.id);
              }}
            >
              <Icon name="arrowR" size={14} />
            </button>
          )}
        </Show>
      </div>
    </Portal>
  );
}
