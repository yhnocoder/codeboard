// The sidenote popups: a Highlight's (its lines and the sidenotes on them, HighlightPop) and a card's whole-card sidenotes
// (NotesPop), one look. Each sidenote is a slip whose tools float over its top right while it is hovered; at the bottom a + turns
// into the input for a new one (ui/NoteComposer.tsx). A click on a [[reference]] to a card in a Text sidenote previews that card
// beside the popup (cardpeek.tsx)
import { For, Show, Switch, Match, createSignal, createEffect, type JSX } from "solid-js";
import {
  cardTitle,
  versionLabel,
  baseName,
  isCode,
  escHtml,
  shownRanges,
  within,
  WIDENED,
  type Anchor,
  type HlRange,
  type Segment,
  type Sidenote,
} from "@codeboard/core";
import { langLabel } from "@codeboard/analysis/langs";
import { state, cardById, sharedOn } from "../../state/store";
import { pops, closePop, pinPop, type PopInst } from "../../state/pop";
import { lineSel, setLineSel } from "../../state/selection";
import { boardSignal } from "../../state/root";
import * as A from "../../actions";
import { notesOf } from "../../state/ui";
import { hxClasses } from "../../cards/code/highlights";
import { Icon } from "../icons";
import { MdStatic } from "../Md";
import { openMenu, type Item } from "../Menu";
import { NoteComposer, SnField, type ComposeMode } from "../NoteComposer";
import { Code, type PopProps } from "./common";
import { CardPeekOf, cardPeeks, type CardPeeks } from "./cardpeek";

/** A card's whole-card sidenotes */
export function NotesPop(p: PopProps<"notes">) {
  const notes = () => notesOf(p.pop.card).filter((n) => !n.at.lines);
  const title = () => {
    const c = cardById(p.pop.card)?.card;
    return c ? cardTitle(c) : "";
  };
  return (
    <SidenotePop
      inst={p.inst}
      title={<span class="rng">{title()}</span>}
      notes={notes}
      at={() => ({ card: p.pop.card })}
      write={!!p.pop.write}
      gone={() => !notes().length}
      remove={
        notes().length
          ? { label: "Delete Sidenotes", tip: "Delete Sidenotes", run: () => A.deleteCardNotes(p.pop.card) }
          : undefined
      }
    />
  );
}

/**
 * A Highlight's popup: its lines, then the sidenotes on them (the hidden ones first, the Always Show ones last, as they sit under
 * the code). Opened to write on lines (pop.write) it shows the input at once, also for lines with no Highlight yet
 */
export function HighlightPop(p: PopProps<"highlight">) {
  const seg = () => {
    const c = cardById(p.pop.card)?.card;
    return isCode(c) ? c.segments.find((s) => s.id === p.pop.seg) : undefined;
  };
  /** The Highlight holding the popup's lines (it grows when a sidenote joins it to another) */
  const hl = () => {
    const s = seg();
    return s ? shownRanges(state.board, s).find((r) => within(p.pop.lines, r)) : undefined;
  };
  const lines = (): HlRange => hl() ?? p.pop.lines;
  const notes = () => {
    const r = lines();
    const mine = notesOf(p.pop.card).filter((n) => n.at.seg === p.pop.seg && !!n.at.lines && within(n.at.lines, r));
    const always = (n: Sidenote) => n.kind === "text" && !!n.alwaysShow;
    return [...mine.filter((n) => !always(n)), ...mine.filter(always)];
  };
  // the lines a new sidenote goes on: the ones it was opened to write on, until the + asks for one on the whole Highlight
  const [writeOn, setWriteOn] = createSignal<HlRange | undefined>(p.pop.write);
  const range = () => {
    const [a, z] = lines();
    return a === z ? `${a}` : `${a}–${z}`;
  };
  const count = () => (notes().length ? ` · ${notes().length} note${notes().length > 1 ? "s" : ""}` : "");
  return (
    <SidenotePop
      inst={p.inst}
      title={
        <>
          <span class="rng">{range()}</span>
          <span>Highlight{count()}</span>
        </>
      }
      notes={notes}
      at={() => {
        const [a, z] = writeOn() ?? lines();
        return { card: p.pop.card, seg: p.pop.seg, lines: [a, z] };
      }}
      write={!!p.pop.write}
      wrote={() => {
        // the selected lines it was written on are done with: their selection (and its +) goes
        const ls = lineSel(),
          w = writeOn();
        if (w && ls?.card === p.pop.card && ls.seg === p.pop.seg && ls.start === w[0] && ls.end === w[1])
          setLineSel(null);
      }}
      onAdd={() => setWriteOn(undefined)}
      gone={() => !hl()}
      remove={
        hl()
          ? {
              label: "Remove Highlight",
              tip: notes().length ? "Remove Highlight and its notes" : "Remove Highlight",
              run: () => A.removeHighlight(p.pop.card, p.pop.seg, lines()),
            }
          : undefined
      }
    />
  );
}

/**
 * One sidenote popup. write: it was opened to write a new one, its input ready; onAdd: the + was pressed; wrote: a new one was
 * added. It closes once what it shows is gone (gone) and nothing is being written
 */
function SidenotePop(p: {
  inst: PopInst;
  title: JSX.Element;
  notes: () => Sidenote[];
  at: () => Anchor;
  write: boolean;
  gone: () => boolean;
  remove?: { label: string; tip: string; run: () => void };
  onAdd?: () => void;
  wrote?: () => void;
}) {
  // the input: none, else a new one each time a sidenote was added from it (↵) and the next can be written
  const [writing, setWriting] = createSignal<{ mode: ComposeMode } | null>(p.write ? { mode: "text" } : null);
  createEffect(() => {
    if (p.gone() && !writing()) closePop(p.inst.id);
  });
  const peeks = cardPeeks();
  const add = () => {
    pinPop(p.inst.id);
    p.onAdd?.();
    setWriting({ mode: "text" });
  };
  return (
    <div class="hxpop" classList={hxClasses(state.host.settings.highlightLook)}>
      <div class="hh" data-grip>
        {p.title}
        <span class="grow" />
        <Show when={p.remove}>
          {(r) => (
            <button class="ib" aria-label={r().label} data-tip={r().tip} onClick={() => r().run()}>
              <Icon name="trash" size={14} />
            </button>
          )}
        </Show>
        <button class="ib" aria-label="Close" data-tip="Close" onClick={() => closePop(p.inst.id)}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div class="tray">
        <For each={p.notes()}>{(n) => <Slip n={n} peeks={peeks} pop={p.inst.id} />}</For>
        <Show
          when={writing()}
          keyed
          fallback={
            <button class="add" aria-label="Add Sidenote" onClick={add}>
              <Icon name="plus" size={14} />
            </button>
          }
        >
          {(w) => (
            <NoteComposer
              at={p.at()}
              mode={w.mode}
              added={(mode) => {
                p.wrote?.();
                setWriting({ mode });
              }}
              close={() => setWriting(null)}
            />
          )}
        </Show>
      </div>
      <CardPeekOf peeks={peeks} />
    </div>
  );
}

/** The sidenote if it is a `k` one (narrows the kind inside a <Match>) */
const kindOf = <K extends Sidenote["kind"]>(n: Sidenote | undefined, k: K) =>
  n?.kind === k ? (n as Extract<Sidenote, { kind: K }>) : undefined;

/** One sidenote in a popup: its tools (over its top right while it is hovered, taking no room) and its body */
function Slip(p: { n: Sidenote; peeks: CardPeeks; pop: number }) {
  const n = () => p.n;
  const always = () => !!kindOf(n(), "text")?.alwaysShow;
  const tool = (icon: string, tip: string, run: () => void, on?: () => boolean) => (
    <button class="ib" classList={{ on: !!on?.() }} aria-label={tip} data-tip={tip} onClick={run}>
      <Icon name={icon} size={14} />
    </button>
  );
  return (
    <div
      class="slip"
      classList={{ always: always() }}
      data-note={n().id}
      onContextMenu={(e) => {
        e.preventDefault();
        pinPop(p.pop);
        noteMenu(n(), e.clientX, e.clientY);
      }}
    >
      <div class="kt">
        <Show when={n().kind === "text"}>
          {tool("pencil", "Edit", () => editText(n()))}
          <Show when={n().at.lines}>{tool("eye", "Always Show", () => A.toggleAlwaysShow(n().id), always)}</Show>
        </Show>
        {tool("place", "Place on Board", () => A.placeSidenote(n().id))}
        <Show when={sharedOn(n().at.card) > 1}>
          {tool(
            "lock",
            "Board-only",
            () => A.toggleBoardOnly(n().id),
            () => !!n().boardOnly,
          )}
        </Show>
        <Show when={hasVariants(n().at.card)}>
          {tool(
            "swap",
            "Only in This Variant",
            () => A.toggleVariantOnly(n().id),
            () => !!n().variant,
          )}
        </Show>
        {tool("trash", "Delete Sidenote", () => A.deleteSidenote(n().id))}
      </div>
      <NoteItem n={n()} peeks={p.peeks} />
    </div>
  );
}

function NoteItem(p: { n: Sidenote; peeks: CardPeeks }) {
  const n = () => p.n;
  return (
    <>
      <Switch>
        <Match when={kindOf(n(), "code")}>
          {(k) => {
            const c = () => k().code;
            const v = () => state.views[c().id];
            return (
              <>
                <CodeHead seg={c()} />
                <SnCode start={c().start} html={v()?.html ?? c().text.map(escHtml)} />
              </>
            );
          }}
        </Match>
        <Match when={kindOf(n(), "text")}>
          {(t) => (
            <Show
              when={snEditing() === t().id}
              fallback={
                <MdStatic
                  class="sb nbody"
                  src={t().md}
                  onDblClick={() => editText(t())}
                  onToggle={(v) => A.writeSidenote(t().id, v)}
                  onRef={(to, el) => p.peeks.toggle(to, el, el.closest(".pop") ?? el)}
                />
              }
            >
              <SidenoteEditor n={t()} />
            </Show>
          )}
        </Match>
      </Switch>
      <Show when={n().why}>
        <div class="sn-why">{n().why}</div>
      </Show>
      <Show when={n().review}>
        <div class="sn-why review">
          <span>
            {n().review === WIDENED
              ? "Its lines grew when its Highlight merged with another, check it"
              : `Line changed in ${n().review}, check it`}
          </span>
          <button class="tbtn" onClick={() => A.markReviewed(n().id)}>
            Mark Reviewed
          </button>
        </div>
      </Show>
      <Show when={n().lineRemoved || (n().boardOnly && sharedOn(n().at.card) > 1) || n().variant}>
        <div class="sn-flags">
          <Show when={n().lineRemoved}>
            <Flag icon="minus" tip="Its line was removed in the new version: on the whole card" warn />
          </Show>
          <Show when={n().boardOnly && sharedOn(n().at.card) > 1}>
            <Flag icon="lock" tip="Board-only" />
          </Show>
          <Show when={n().variant}>
            <Flag icon="swap" tip={`Only in variant ${A.variantName(n().at.card, n().variant!) ?? ""}`} />
          </Show>
        </div>
      </Show>
    </>
  );
}
/** A Code sidenote's head: the function (or file and lines) and the version it is pinned at; Free code: its language and where it
 *  came from */
function CodeHead(p: { seg: Segment }) {
  const s = () => p.seg;
  const url = () => (s().src.kind === "free" ? (s().src as { url?: string }).url : undefined);
  return (
    <div class="sn-head">
      <Show
        when={s().src.kind !== "free"}
        fallback={
          <>
            <b>{langLabel(s().lang)}</b>
            <Show when={url()}>
              {(u) => (
                <a class="lnk" onClick={() => A.openLink(u())}>
                  {u()}
                </a>
              )}
            </Show>
          </>
        }
      >
        <b>{s().symbol?.qual ?? `${baseName(s().path)} ${s().start}–${s().end}`}</b>
        <span>
          · {baseName(s().path)}:{s().start}
        </span>
        <span class="grow" />
        <span class="rev sm">{versionLabel(s().version)}</span>
      </Show>
    </div>
  );
}
/** More lines than a Code sidenote shows closed: the rest fades out under them */
const SN_CODE_LINES = 8;
/** A Code sidenote's code: past SN_CODE_LINES lines it is cut, with no scrolling of its own; a click on it (not a drag selecting
 *  some of it) opens it all, or cuts it again */
function SnCode(p: { start: number; html: string[] }) {
  const [open, setOpen] = createSignal(false);
  const long = () => p.html.length > SN_CODE_LINES;
  return (
    <div
      class="sn-code"
      classList={{ long: long(), cut: long() && !open() }}
      onClick={() => {
        if (long() && (getSelection()?.isCollapsed ?? true)) setOpen((o) => !o);
      }}
    >
      <Code start={p.start} html={p.html} />
    </div>
  );
}
const hasVariants = (id: string) => {
  const c = cardById(id)?.card;
  return isCode(c) && !!c.variants?.length;
};
function noteMenu(n: Sidenote, x: number, y: number) {
  const linked = sharedOn(n.at.card) > 1;
  openMenu(
    [
      ...(n.kind === "text" ? [{ label: "Edit", run: () => editText(n) } as Item] : []),
      { label: "Place on Board", run: () => A.placeSidenote(n.id) },
      ...(linked
        ? [
            {
              label: "Board-only",
              checked: !!n.boardOnly,
              hint: "Keep this sidenote on this board only; otherwise every board with the card shows it",
              run: () => A.toggleBoardOnly(n.id),
            } as Item,
          ]
        : []),
      ...(n.review ? [{ label: "Mark Reviewed", run: () => A.markReviewed(n.id) } as Item] : []),
      ...(hasVariants(n.at.card)
        ? [
            {
              label: "Only in This Variant",
              checked: !!n.variant,
              hint: n.variant
                ? `Only on ${A.variantName(n.at.card, n.variant) ?? "one variant"}`
                : "Show this sidenote only on the variant shown now",
              run: () => A.toggleVariantOnly(n.id),
            } as Item,
          ]
        : []),
      null,
      { label: "Delete Sidenote", danger: true, run: () => A.deleteSidenote(n.id) },
    ],
    x,
    y,
  );
}
/** A sidenote's state as an icon, said by its tooltip */
function Flag(p: { icon: Parameters<typeof Icon>[0]["name"]; tip: string; warn?: boolean }) {
  return (
    <span class="sn-flag" classList={{ warn: p.warn }} role="img" aria-label={p.tip} data-tip={p.tip}>
      <Icon name={p.icon} size={12} />
    </span>
  );
}
// A Text sidenote edited in place, in the same field as the popup's input (ui/NoteComposer.tsx SnField): ↵ or a click elsewhere
// saves, Esc puts it back as it was. Saved empty, it goes
const [snEditing, setSnEditing] = boardSignal<string | null>(null);
function editText(n: Sidenote) {
  if (n.kind !== "text") return;
  for (const q of pops())
    if (
      (q.pop.kind === "notes" && q.pop.card === n.at.card && !n.at.lines) ||
      (q.pop.kind === "highlight" &&
        q.pop.card === n.at.card &&
        q.pop.seg === n.at.seg &&
        !!n.at.lines &&
        within(n.at.lines, q.pop.lines))
    )
      pinPop(q.id);
  setSnEditing(n.id);
}
function SidenoteEditor(p: { n: Extract<Sidenote, { kind: "text" }> }) {
  const save = (v: string | null) => {
    if (v !== null) A.writeSidenote(p.n.id, v.trim());
  };
  return (
    <div class="sn-edit" data-nodrag>
      <SnField
        value={p.n.md}
        end={(how, v) => {
          setSnEditing(null);
          if (how !== "esc") save(v);
        }}
        // its popup closed (a click on the board)
        gone={(v) => {
          setSnEditing(null);
          save(v);
        }}
      />
    </div>
  );
}
