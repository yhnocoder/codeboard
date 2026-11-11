import { keepKey } from "../vscodekeys";
import { For, Show, Switch, Match, createSignal, createEffect } from "solid-js";
import {
  cardTitle,
  versionLabel,
  baseName,
  isCode,
  guessLang,
  escHtml,
  sameRange,
  shownRanges,
  within,
  WIDENED,
  type Sidenote,
  type SearchItem,
  type SegView,
} from "@codeboard/core";
import { langLabel, LANGS } from "@codeboard/analysis/langs";
import { state, cardById, sharedOn } from "../../state/store";
import { toast } from "../../state/toast";
import { pops, closePop, pinPop } from "../../state/pop";
import { pickCardThen } from "../../state/mode";
import { boardSignal } from "../../state/root";
import { ask, switched } from "../../host";
import * as A from "../../actions";
import { notesOf } from "../../state/ui";
import { hxClasses } from "../../cards/code/highlights";
import { useListNav, useDebouncedAsk, useFinish } from "../hooks";
import { Icon } from "../icons";
import { MdStatic } from "../Md";
import { openMenu, type Item } from "../Menu";
import { PopHead, Code, type PopProps } from "./common";
import { CardPeek, cardPeeks, type CardPeeks } from "./cardpeek";

export function NotesPop(p: PopProps<"notes">) {
  const notes = () =>
    p.pop.ids.map((id) => state.board.sidenotes.find((n) => n.id === id)).filter(Boolean) as Sidenote[];
  const [cur, setCur] = createSignal(p.pop.sel ?? p.pop.ids[0]);
  createEffect(() => {
    if (!notes().length) closePop(p.inst.id);
  });
  const curNote = () => notes().find((n) => n.id === cur()) ?? notes()[0];
  const peeks = cardPeeks();
  return (
    <>
      <PopHead title={`${p.pop.title} (${notes().length})`} inst={p.inst} />
      <div class="sn-list">
        <For each={notes()}>
          {(n) => (
            <div
              class="sn-item"
              classList={{ on: n.id === curNote()?.id }}
              onPointerDown={() => setCur(n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCur(n.id);
                pinPop(p.inst.id);
                noteMenu(n, e.clientX, e.clientY);
              }}
            >
              <NoteItem n={n} peeks={peeks} />
            </div>
          )}
        </For>
      </div>
      <Show when={peeks.peek()} keyed>
        {(pk) => <CardPeek id={pk.card} at={pk.at} peeks={peeks} />}
      </Show>
      <div class="sn-acts">
        <button
          class="tbtn"
          onClick={() => {
            const n = notes()[0];
            if (n) {
              closePop(p.inst.id);
              A.openAddNote(n.at);
            }
          }}
        >
          + Add
        </button>
        <Show when={curNote()?.kind === "text"}>
          <button class="tbtn" onClick={() => editText(curNote()!)}>
            Edit
          </button>
          <button
            class="tbtn"
            classList={{ on: !!kindOf(curNote(), "text")?.alwaysShow }}
            onClick={() => A.toggleAlwaysShow(curNote()!.id)}
          >
            Always Show
          </button>
        </Show>
        <Show when={curNote() && curNote()!.kind !== "card"}>
          <button class="tbtn" onClick={() => A.placeSidenote(curNote()!.id)}>
            Place on Board
          </button>
        </Show>
        <Show when={curNote() && curNote()!.kind !== "card" && sharedOn(curNote()!.at.card) > 1}>
          <button
            class="tbtn"
            classList={{ on: !!curNote()!.boardOnly }}
            data-tip="Keep this sidenote on this board only; otherwise it shows on every board with the card"
            onClick={() => A.toggleBoardOnly(curNote()!.id)}
          >
            Board-only
          </button>
        </Show>
        <Show when={curNote() && hasVariants(curNote()!.at.card)}>
          <button
            class="tbtn"
            classList={{ on: !!curNote()!.variant }}
            data-tip="Show this sidenote only on this variant of the card"
            onClick={() => A.toggleVariantOnly(curNote()!.id)}
          >
            Only in This Variant
          </button>
        </Show>
        <span class="grow" />
        <button
          class="ib"
          aria-label="Delete Sidenote"
          data-tip="Delete Sidenote"
          onClick={() => A.deleteSidenote(curNote()!.id)}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
    </>
  );
}

/** The sidenote if it is a `k` one (narrows the kind inside a <Match>) */
const kindOf = <K extends Sidenote["kind"]>(n: Sidenote | undefined, k: K) =>
  n?.kind === k ? (n as Extract<Sidenote, { kind: K }>) : undefined;

/**
 * A Highlight's popup: its lines and what is on them, then each sidenote as a slip with its own tools (the hidden ones first, the
 * Always Show ones last, as they sit under the code), and a dashed Add Note at the bottom
 */
export function HighlightPop(p: PopProps<"highlight">) {
  const seg = () => {
    const c = cardById(p.pop.card)?.card;
    return isCode(c) ? c.segments.find((s) => s.id === p.pop.seg) : undefined;
  };
  const here = () => {
    const s = seg();
    return !!s && shownRanges(state.board, s).some((r) => sameRange(r, p.pop.lines));
  };
  const notes = () => {
    const mine = notesOf(p.pop.card).filter(
      (n) => n.at.seg === p.pop.seg && !!n.at.lines && within(n.at.lines, p.pop.lines),
    );
    const always = (n: Sidenote) => n.kind === "text" && !!n.alwaysShow;
    return [...mine.filter((n) => !always(n)), ...mine.filter(always)];
  };
  createEffect(() => {
    if (!here()) closePop(p.inst.id);
  });
  const peeks = cardPeeks();
  const [a, z] = p.pop.lines;
  const look = () => state.host.settings.highlightLook;
  const add = () => {
    closePop(p.inst.id);
    A.openAddNote({ card: p.pop.card, seg: p.pop.seg, lines: [a, z] }, "text");
  };
  return (
    <div class="hxpop" classList={hxClasses(look())}>
      <div class="hh">
        <span class="rng">{a === z ? `${a}` : `${a}–${z}`}</span>
        <span>
          Highlight
          {notes().length ? ` · ${notes().length} note${notes().length > 1 ? "s" : ""}` : ""}
        </span>
        <span class="grow" />
        <button class="ib" aria-label="Add Note" data-tip="Add Note" onClick={add}>
          <Icon name="plus" size={14} />
        </button>
        <button
          class="ib"
          aria-label="Remove Highlight"
          data-tip={notes().length ? "Remove Highlight and its notes" : "Remove Highlight"}
          onClick={() => A.removeHighlight(p.pop.card, p.pop.seg, p.pop.lines)}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div class="tray">
        <For each={notes()}>{(n) => <Slip n={n} peeks={peeks} pop={p.inst.id} />}</For>
        <button class="add" onClick={add}>
          + Add Note
        </button>
      </div>
      <Show when={peeks.peek()} keyed>
        {(pk) => <CardPeek id={pk.card} at={pk.at} peeks={peeks} />}
      </Show>
    </div>
  );
}

const KIND_LABEL: Record<Sidenote["kind"], string> = {
  text: "Note",
  code: "Code",
  paste: "Paste",
  link: "Link",
  card: "Card",
};
/** One sidenote on a Highlight: its kind, its tools, and its body (a Text sidenote rendered as a Note is) */
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
        <span class="tag">{KIND_LABEL[n().kind]}</span>
        <Show when={always()}>
          <span class="as">· Always Show</span>
        </Show>
        <span class="grow" />
        <Show when={n().kind === "text"}>
          {tool("pencil", "Edit", () => editText(n()))}
          {tool("eye", "Always Show", () => A.toggleAlwaysShow(n().id), always)}
        </Show>
        <Show when={n().kind !== "card"}>{tool("place", "Place on Board", () => A.placeSidenote(n().id))}</Show>
        <Show when={n().kind !== "card" && sharedOn(n().at.card) > 1}>
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
      <NoteItem n={n()} peeks={p.peeks} slip />
    </div>
  );
}

function NoteItem(p: { n: Sidenote; peeks: CardPeeks; slip?: boolean }) {
  const n = () => p.n;
  return (
    <>
      <Switch>
        <Match when={n().kind === "code"}>
          {(() => {
            const c = () => (n() as Extract<Sidenote, { kind: "code" }>).code;
            const v = () => state.views[c().id];
            return (
              <>
                <div class="sn-head">
                  <b>{c().symbol?.qual ?? `${baseName(c().path)} ${c().start}–${c().end}`}</b>
                  <span>
                    · {baseName(c().path)}:{c().start}
                  </span>
                  <span class="grow" />
                  <span class="rev sm">{versionLabel(c().version)}</span>
                </div>
                <Code start={c().start} html={v()?.html ?? c().text.map(escHtml)} />
              </>
            );
          })()}
        </Match>
        <Match when={n().kind === "paste"}>
          {(() => {
            const q = () => n() as Extract<Sidenote, { kind: "paste" }>;
            return (
              <>
                <div class="sn-head">
                  <b>Paste</b>
                  <span>· {langLabel(q().lang)}</span>
                  <Show when={q().url}>
                    <a class="lnk" onClick={() => A.openLink(q().url!)}>
                      {q().url}
                    </a>
                  </Show>
                </div>
                <Code start={1} html={q().text.split("\n").map(escHtml)} />
              </>
            );
          })()}
        </Match>
        <Match when={kindOf(n(), "text")}>
          {(t) => (
            <Show
              when={snEditing() === t().id}
              fallback={
                <MdStatic
                  class={p.slip ? "sb nbody" : "sn-text"}
                  src={t().md}
                  onDblClick={() => editText(t())}
                  onToggle={(v) => A.writeSidenote(t().id, v)}
                />
              }
            >
              <SidenoteEditor n={t()} />
            </Show>
          )}
        </Match>
        <Match when={p.slip && kindOf(n(), "link")}>
          {(l) => (
            <div class="lk">
              <a onClick={() => A.openLink(l().url)}>{l().title || l().url}</a>
              <span>{hostOf(l().url)}</span>
            </div>
          )}
        </Match>
        <Match when={kindOf(n(), "link")}>
          {(l) => (
            <>
              <div class="sn-head">
                <b>Link</b>
              </div>
              <div class="sn-text">
                <a class="lnk" onClick={() => A.openLink(l().url)}>
                  {l().title || l().url}
                </a>
              </div>
            </>
          )}
        </Match>
        <Match when={kindOf(n(), "card")}>
          {(k) => {
            const t = () => cardById(k().card)?.card;
            const code = () => {
              const c = t();
              return isCode(c) ? c : undefined;
            };
            return (
              <>
                <div class="sn-head">
                  <b>Card · {t() ? cardTitle(t()!) : "deleted"}</b>
                  <span class="grow" />
                  <Show when={t()}>
                    <button
                      class="ib sn-peek"
                      aria-label="Preview Card"
                      onPointerEnter={(e) => p.peeks.on(k().card, e.currentTarget)}
                      onPointerLeave={(e) => p.peeks.off(e)}
                      onPointerDown={() => p.peeks.hide()}
                    >
                      <Icon name="eye" size={13} />
                    </button>
                    <button class="tbtn" onClick={() => A.revealCard(k().card)}>
                      Go to Card
                    </button>
                  </Show>
                </div>
                <Show when={code()}>
                  {(c) => {
                    const s = c().segments[0];
                    const v = state.views[s.id];
                    return <Code start={s.start} html={(v?.html ?? s.text.map(escHtml)).slice(0, 12)} />;
                  }}
                </Show>
              </>
            );
          }}
        </Match>
      </Switch>
      <Show when={n().why}>
        <div class="sn-why">{n().why}</div>
      </Show>
      <Show when={n().lineRemoved}>
        <div class="sn-why warn">Line removed in the new version · attached to the whole card</div>
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
      <Show when={n().boardOnly && sharedOn(n().at.card) > 1}>
        <div class="sn-tag">Board-only · not shown on the other boards</div>
      </Show>
      <Show when={n().variant}>
        <div class="sn-tag">Only in variant {A.variantName(n().at.card, n().variant!) ?? ""}</div>
      </Show>
    </>
  );
}
/** A link's site, as the popup shows it under its title */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const hasVariants = (id: string) => {
  const c = cardById(id)?.card;
  return isCode(c) && !!c.variants?.length;
};
function noteMenu(n: Sidenote, x: number, y: number) {
  const linked = n.kind !== "card" && sharedOn(n.at.card) > 1;
  openMenu(
    [
      ...(n.kind === "text" ? [{ label: "Edit", run: () => editText(n) } as Item] : []),
      ...(n.kind !== "card" ? [{ label: "Place on Board", run: () => A.placeSidenote(n.id) } as Item] : []),
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
// 旁注原地编辑：多行、自动增高，和 Note 卡一样是 Markdown + 公式，下面实时预览。
// 和 Note、问题的编辑一样，Esc、⌘↵、点到外面都是保存（Cancel 才是放弃）。字删光了保存就是删掉这条：Text sidenote 就是那段字，加的时候也不让加空的
const [snEditing, setSnEditing] = boardSignal<string | null>(null);
function editText(n: Sidenote) {
  if (n.kind !== "text") return;
  for (const q of pops())
    if (
      (q.pop.kind === "notes" && q.pop.ids.includes(n.id)) ||
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
  let box!: HTMLDivElement;
  const [v, setV] = createSignal(p.n.md);
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  const { finish } = useFinish(
    (save: boolean) => {
      setSnEditing(null);
      if (save) A.writeSidenote(p.n.id, v().trim());
    },
    (f) => f(true),
  ); // 弹窗被关掉了（点了白板）
  return (
    <div ref={box} class="sn-edit" data-nodrag>
      <textarea
        spellcheck={false}
        value={v()}
        ref={(el) =>
          queueMicrotask(() => {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
            grow(el);
          })
        }
        onInput={(e) => {
          setV(e.currentTarget.value);
          grow(e.currentTarget);
        }}
        onBlur={(e) => {
          if (!(e.relatedTarget instanceof Node && box.contains(e.relatedTarget))) finish(true);
        }}
        onKeyDown={(e) => {
          keepKey(e);
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            finish(true);
          }
        }}
      />
      <Show when={v().trim()}>
        <MdStatic class="sn-text sn-prev" src={v()} />
      </Show>
      {/* 按钮不拿焦点：点的时候字框不失焦 */}
      <div class="sn-eacts" onMouseDown={(e) => e.preventDefault()}>
        <span>Markdown and $math$ · {A.K.mod}↵ or click outside to save</span>
        <span class="grow" />
        <button class="tbtn" onClick={() => finish(false)}>
          Cancel
        </button>
        <button class="tbtn pri" onClick={() => finish(true)}>
          Save
        </button>
      </div>
    </div>
  );
}

const TABS = [
  ["code", "Code"],
  ["paste", "Paste"],
  ["text", "Text"],
  ["link", "Link"],
  ["card", "Card"],
] as const;

/** 新 Sidenote 的内容（at、why 在 done 里补上） */
type NoteBody = Sidenote extends infer S ? (S extends Sidenote ? Omit<S, "id" | "at"> : never) : never;

export function AddNotePop(p: PopProps<"addNote">) {
  const [tab, setTab] = createSignal(p.pop.tab);
  const [why, setWhy] = createSignal("");
  const [q, setQ] = createSignal("");
  const [res, setRes] = createSignal<SearchItem[]>([]);
  const { i, setI, key } = useListNav(() => res().length);
  const [text, setText] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [lang, setLang] = createSignal("python");
  const at = () => p.pop.at;
  const where = () =>
    at().lines
      ? at().lines![0] === at().lines![1]
        ? `Line ${at().lines![0]}`
        : `Lines ${at().lines![0]}–${at().lines![1]}`
      : "Whole card";
  useDebouncedAsk(
    () => (tab() === "code" ? q().trim() : ""),
    (s) => (s ? A.searchCodeForNote(s) : Promise.resolve([])),
    (r) => {
      setRes(r);
      setI(0);
    },
    (s) => (s ? 120 : 0),
  );
  // 加好了、按了 Cancel 或去白板上选卡了。没有的话弹窗关掉时（Esc、点到外面）Text / Paste 里写了的照样加上，和编辑 Note 一样
  const { finish: settle } = useFinish(
    (f: () => void) => f(),
    () => {
      if (tab() === "text" || tab() === "paste") void add();
    },
  );
  const cancel = () => settle(() => closePop(p.inst.id));
  const put = (n: NoteBody, view?: SegView) => {
    A.addSidenote({ ...n, at: at(), why: why().trim() || undefined }, view);
    closePop(p.inst.id);
    toast("Sidenote added");
  };
  const done = (n: NoteBody, view?: SegView) => settle(() => put(n, view));
  const add = async () => {
    switch (tab()) {
      case "code": {
        const it = res()[i()];
        if (!it) return;
        const r = await ask("searchPick", { item: it, alt: true }).catch((e) => (switched(e) ? undefined : null));
        if (r === undefined) return;
        const c = r?.card;
        if (!c || !isCode(c)) return toast("Could not read that code");
        const seg = c.segments[0];
        return done({ kind: "code", code: seg }, r!.views[seg.id]);
      }
      case "paste":
        if (text().trim())
          done({ kind: "paste", text: text().replace(/\s+$/, ""), lang: lang(), url: url().trim() || undefined });
        return;
      case "text":
        if (text().trim()) done({ kind: "text", md: text() });
        return;
      case "link": {
        let u = url().trim();
        if (!u) return;
        if (!/^https?:/.test(u)) u = `https://${u}`;
        done({ kind: "link", url: u });
        return;
      }
    }
  };
  const pickCard = () =>
    settle(() => {
      closePop(p.inst.id);
      toast("Click a card on the board · Esc to cancel");
      pickCardThen((id) => put({ kind: "card", card: id }));
    });
  const onKey = (e: KeyboardEvent) => {
    keepKey(e);
    if (e.key === "Escape") {
      e.preventDefault();
      closePop(p.inst.id);
    }
    if (tab() === "code" && key(e)) return;
    if (e.key === "Enter" && !e.isComposing && (tab() === "code" || tab() === "link" || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      add();
    }
  };
  return (
    <div class="addnote" onKeyDown={onKey}>
      <div class="tabs">
        <For each={TABS}>
          {([k, lb]) => (
            <button class="tab" classList={{ on: tab() === k }} onClick={() => (k === "card" ? pickCard() : setTab(k))}>
              {lb}
            </button>
          )}
        </For>
        <span class="grow" />
        <span class="where">{where()}</span>
      </div>
      <div class="an-body">
        <Switch>
          <Match when={tab() === "code"}>
            <input
              class="fld"
              autofocus
              placeholder="Search functions or files"
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
              ref={(e) => queueMicrotask(() => e.focus())}
            />
            <div class="sres">
              <For each={res()}>
                {(r, k) => (
                  <button
                    class="cand"
                    classList={{ on: k() === i() }}
                    onPointerMove={(e) => {
                      if (e.movementX || e.movementY) setI(k());
                    }}
                    onClick={() => {
                      setI(k());
                      add();
                    }}
                  >
                    <span class="kind">{r.kind === "symbol" ? r.glyph : "▤"}</span>
                    <span class="lb">{r.label}</span>
                    <small>{r.detail}</small>
                  </button>
                )}
              </For>
              <Show when={!res().length}>
                <div class="hint">Or select code in the editor and press {A.K.alt}S</div>
              </Show>
            </div>
          </Match>
          <Match when={tab() === "paste"}>
            <textarea
              class="fld mono"
              placeholder="Paste code here"
              value={text()}
              onInput={(e) => {
                setText(e.currentTarget.value);
                const g = guessLang(e.currentTarget.value);
                if (g) setLang(g);
              }}
              ref={(e) => queueMicrotask(() => e.focus())}
            />
            <input
              class="fld"
              placeholder="Source URL (optional)"
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
            <div class="row">
              Language:{" "}
              <select class="fld sm" value={lang()} onChange={(e) => setLang(e.currentTarget.value)}>
                <For each={LANGS}>{(l) => <option value={l.id}>{l.label}</option>}</For>
              </select>
            </div>
          </Match>
          <Match when={tab() === "text"}>
            <textarea
              class="fld"
              placeholder="Write a note. Markdown and $math$ work."
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              ref={(e) => queueMicrotask(() => e.focus())}
            />
          </Match>
          <Match when={tab() === "link"}>
            <input
              class="fld"
              placeholder="https://…"
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
              ref={(e) => queueMicrotask(() => e.focus())}
            />
          </Match>
        </Switch>
        <Show when={tab() !== "text"}>
          <input
            class="fld"
            placeholder="Why is it related? (optional)"
            value={why()}
            onInput={(e) => setWhy(e.currentTarget.value)}
          />
        </Show>
      </div>
      <div class="db">
        <button onClick={cancel}>Cancel</button>
        <button class="def" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
