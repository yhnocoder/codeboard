// A card's preview in place: the beginning of a card as the board draws it (same look, the code and Notes as they are now), its
// header and first lines, scaled down to PEEK_W wide and cut at PEEK_H with a fade. It does not scroll: the card itself is one
// click away, on the arrow inside it. Shown beside what asked for it:
// - a click on a [[reference]] to a card of this board, in a Text sidenote, toggles it (cardPeeks); Esc or a press anywhere else
//   closes it;
// - the [[ list of the sidenote input shows its highlighted card's (ui/NoteComposer.tsx): passive, no keys, no arrow.
// It is a copy of the card's element taken once when it opens (nothing measured per frame), inert, with nothing that selectors
// for the board's cards would find
import { createSignal, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { RefTarget } from "@yhnocoder/markdown";
import { place } from "@yhnocoder/markdown/ui";
import { cardById, hostOf } from "../../state/store";
import { CARD_STATE_CLASSES, cardSel } from "../../cardsel";
import { useOverlay } from "../overlay";
import * as A from "../../actions";
import { Icon } from "../icons";

/** About twelve code lines under the card's header */
const PEEK_W = 520,
  PEEK_H = 280;

/** What a card's inline style gets from its animations and tilt, not its look */
const STATE_STYLES = ["rotate", "transform", "translate", "scale", "transform-origin", "opacity", "transition"];

/** Card `id`'s element on this board, when it is drawn (a Compare's column: the Compare) */
export const cardElement = (id: string) =>
  document.querySelector<HTMLElement>(cardSel(id)) ?? document.querySelector<HTMLElement>(cardSel(hostOf(id)));

/** The preview a place shows at a time: which card, from which reference (its second click closes it), beside which box */
type Peek = { card: string; at: HTMLElement; beside: Element };
export function cardPeeks() {
  const [peek, setPeek] = createSignal<Peek | null>(null);
  return {
    peek,
    /**
     * A click on a reference (el) that points to `to`: a card drawn on this board opens its preview beside `beside`, or closes it
     * when it is the one open from there. False for anything else (a Section, another board), which the click goes to as usual
     */
    toggle(to: RefTarget, el: HTMLElement, beside: Element = el) {
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
export function CardPeek(p: { id: string; at: HTMLElement; beside: Element; peeks?: CardPeeks }) {
  let el!: HTMLDivElement, stage!: HTMLDivElement;
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
  const [cut, setCut] = createSignal(false);
  const peeks = p.peeks;
  if (peeks) {
    // Esc closes the preview first (a popup under it stays); a press anywhere but the preview and the reference that opened it
    // (its second click toggles it) closes it
    useOverlay({ close: () => peeks.hide(), inside: (t) => el.contains(t) || p.at.contains(t), outside: true });
  }
  onMount(() => {
    const src = cardElement(p.id);
    if (src) {
      const w = src.offsetWidth,
        h = src.offsetHeight,
        k = Math.min(1, PEEK_W / Math.max(1, w));
      const c = src.cloneNode(true) as HTMLElement;
      c.classList.remove(...CARD_STATE_CLASSES);
      for (const s of STATE_STYLES) c.style.removeProperty(s);
      for (const e of [
        c,
        ...c.querySelectorAll<HTMLElement>("[data-id], [data-notes], [data-card], [data-spot], [contenteditable]"),
      ]) {
        e.removeAttribute("data-id");
        e.removeAttribute("data-notes");
        e.removeAttribute("data-card");
        e.removeAttribute("data-spot");
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
    }
    void place(el, p.beside, "right-start", { gap: 10, strategy: "fixed" }).then((r) => setPos({ x: r.x, y: r.y }));
  });
  return (
    <Portal mount={p.beside.closest(".app") ?? document.querySelector(".app") ?? undefined}>
      <div
        ref={el}
        class="cpeek"
        classList={{ show: !!pos(), cut: cut(), passive: !peeks }}
        style={{ left: `${pos()?.x ?? 0}px`, top: `${pos()?.y ?? 0}px` }}
        data-nodrag
      >
        <div ref={stage} class="cpeek-stage" inert />
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
