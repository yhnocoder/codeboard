// A Card sidenote's preview (the eye on its row in the Sidenotes popover): resting the pointer on the eye shows, beside the popover, a
// read-only copy of that card as the board draws it (same look, the code and Notes as they are now), scaled down to PEEK_W wide and
// clipped at PEEK_H. It is a copy of the card's element taken once when it opens (nothing measured per frame), inert, with nothing
// that selectors for the board's cards would find. Timing as the tips: TIP_DELAY the first time, then at once (ui/Menu.tsx)
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { cardTitle, type Card } from "@codeboard/core";
import { place } from "@yhnocoder/markdown/ui";
import { cardById, hostOf } from "../../state/store";
import { TIP_DELAY } from "../../state/timing";
import { cardSel } from "../../cardsel";
import { MdStatic } from "../Md";

const PEEK_W = 420,
  PEEK_H = 360;
/** How long after a preview went away the next one shows at once (as the tips) */
const WARM = 800;

/** The classes a card on the board gets from what is happening to it (selection, drags, culling, map level…), not its look */
const STATE_CLASSES = [
  "sel",
  "solo",
  "lift",
  "landing",
  "dim",
  "editing",
  "off",
  "far",
  "lo-ov",
  "lo-map",
  "skel",
  "skel-in",
  "merge-hot",
  "merge-arm",
  "drop-hot",
  "drop-cand",
  "img-drop",
  "bind-hot",
  "bind-anchor",
  "ghost-out",
];
/** What a card's inline style gets from its animations and tilt, not its look */
const STATE_STYLES = ["rotate", "transform", "translate", "scale", "transform-origin", "opacity", "transition", "--iz"];

const noteOf = (c: Card) => (c.kind === "note" ? c : undefined);

/** The previews of one Sidenotes popover: which card is shown, from which eye */
export function cardPeeks() {
  const [peek, setPeek] = createSignal<{ card: string; at: HTMLElement } | null>(null);
  let t: number | undefined,
    warmUntil = 0;
  const hide = () => {
    clearTimeout(t);
    if (peek()) warmUntil = performance.now() + WARM;
    setPeek(null);
  };
  onCleanup(() => clearTimeout(t));
  return {
    peek,
    /** The pointer is on a card's eye */
    on(card: string, at: HTMLElement) {
      clearTimeout(t);
      if (peek() || performance.now() < warmUntil) setPeek({ card, at });
      else t = window.setTimeout(() => setPeek({ card, at }), TIP_DELAY);
    },
    /** The pointer left an eye or the preview: hidden unless it went from one to the other */
    off(e: PointerEvent) {
      if ((e.relatedTarget as Element | null)?.closest?.(".cpeek, .sn-peek")) return;
      hide();
    },
    hide,
  };
}
export type CardPeeks = ReturnType<typeof cardPeeks>;

/** The preview of card `id`, beside the popover that holds `at` */
export function CardPeek(p: { id: string; at: HTMLElement; peeks: CardPeeks }) {
  let el!: HTMLDivElement, stage!: HTMLDivElement;
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [cut, setCut] = createSignal(false);
  const card = () => cardById(p.id)?.card;
  onMount(() => {
    const src =
      document.querySelector<HTMLElement>(cardSel(p.id)) ?? document.querySelector<HTMLElement>(cardSel(hostOf(p.id)));
    if (src) {
      const w = src.offsetWidth,
        h = src.offsetHeight,
        k = Math.min(1, PEEK_W / Math.max(1, w));
      const c = src.cloneNode(true) as HTMLElement;
      c.classList.remove(...STATE_CLASSES);
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
      setCopied(true);
    }
    const pop = p.at.closest<HTMLElement>(".pop") ?? p.at;
    void place(el, pop, "right-start", { gap: 10, strategy: "fixed" }).then((r) => setPos({ x: r.x, y: r.y }));
  });
  return (
    <Portal mount={p.at.closest(".pop")?.parentElement ?? undefined}>
      <div
        ref={el}
        class="cpeek"
        classList={{ show: !!pos(), cut: cut() }}
        style={{ left: `${pos()?.x ?? 0}px`, top: `${pos()?.y ?? 0}px` }}
        data-nodrag
        onPointerLeave={(e) => p.peeks.off(e)}
      >
        <div ref={stage} class="cpeek-stage" inert />
        <Show when={!copied() && card()}>
          {(c) => (
            <div class="cpeek-alt">
              <b>{cardTitle(c())}</b>
              <Show when={noteOf(c())}>{(n) => <MdStatic src={n().md} />}</Show>
            </div>
          )}
        </Show>
      </div>
    </Portal>
  );
}
