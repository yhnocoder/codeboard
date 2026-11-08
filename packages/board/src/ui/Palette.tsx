// 鼠标只有真的移动才改高亮项：结果刷新时停在原地的鼠标不该抢走键盘选中的那项。
// 没输入时列出入口（pyproject scripts、__init__ 导出、__main__、examples）。
// Related by Meaning 先按向量的顺序列出；重排（codeboard.search.rerank）回来后，行滑到新位置（FLIP，只动 transform），不跳。
import { scrollIntoBox } from "@yhnocoder/markdown/ui";
import { keepKey } from "./vscodekeys";
import { Icon } from "./icons";
import { useOverlay } from "./overlay";
import { useListNav, useDebouncedAsk } from "./hooks";
import { For, Show, createSignal, createEffect, onMount, createMemo } from "solid-js";
import type { MeaningResult, SearchItem } from "@codeboard/core";
import { state } from "../state/store";
import { select } from "../state/selection";
import { toast } from "../state/toast";
import { paletteOpen, setPaletteOpen } from "../state/ui";
import { MEANING_PAUSE, MEANING_RETRY, RERANK_SLIDE } from "../state/timing";
import { ask, send } from "../host";
import * as A from "../actions";
import { Label, Preview } from "./PalettePreview";

type Group = SearchItem["kind"] | "meaning";
/** The row that opens the rest of a long group */
type More = { kind: "more"; group: Group; n: number };
type Row = SearchItem | More;
/** Results a word-match group shows before its "Show N more" row */
const GROUP_SHOWN = 6;
/** A card or sidenote row's identity across answers ("" for code) */
const keyOf = (r: SearchItem) => (r.kind === "sidenote" ? `s:${r.sidenote}` : r.kind === "card" ? `c:${r.card}` : "");

/** The groups in the order shown: the cards first, then what they mean, then code (which Add Function searches alone) */
const GROUPS: [Group, string][] = [
  ["card", "Cards on Boards"],
  ["sidenote", "Sidenotes"],
  ["meaning", "Related by Meaning"],
  ["entry", "Entry Points"],
  ["symbol", "Functions & Classes"],
  ["file", "Files"],
];

export function Palette() {
  const init: Exclude<ReturnType<typeof paletteOpen>, false> = paletteOpen() || { mode: "all" };
  const [q, setQ] = createSignal(init.q ?? "");
  const [res, setRes] = createSignal<SearchItem[]>([]);
  let inp!: HTMLInputElement, list!: HTMLDivElement;
  onMount(() => {
    inp.focus();
    inp.select();
  });
  /** Related by Meaning's answer and the query it is for: one for an earlier query is not shown */
  const [meaningOf, setMeaning] = createSignal<MeaningResult & { q: string; ranked?: true }>({ items: [], q: "" });
  const meaning = (): MeaningResult => (meaningOf().q === q().trim() ? meaningOf() : { items: [] });
  /** asked again while indexing: for which query, how many times */
  const [retry, setRetry] = createSignal({ s: "", n: 0 });
  /** Related by Meaning, without what the words already found */
  const related = createMemo(() => {
    const found = new Set(res().map(keyOf));
    return meaning().items.filter((r) => !found.has(keyOf(r)));
  });
  /** Groups opened past their first few with "Show N more" (for this query) */
  const [opened, setOpened] = createSignal<{ q: string; kinds: Set<string> }>({ q: "", kinds: new Set() });
  const groupAll = (k: Group) => (k === "meaning" ? related() : res().filter((r) => r.kind === k));
  /** A group as listed: searching everything, a word-match group shows its first GROUP_SHOWN and a row for the rest, so
   *  the groups below (Related by Meaning among them) stay in sight */
  const groupOf = (k: Group): Row[] => {
    const all = groupAll(k);
    const open = opened().q === q().trim() && opened().kinds.has(k);
    if (init.mode === "code" || k === "meaning" || open || all.length <= GROUP_SHOWN + 1) return all;
    return [...all.slice(0, GROUP_SHOWN), { kind: "more", group: k, n: all.length - GROUP_SHOWN }];
  };
  const ordered = createMemo(() => GROUPS.flatMap(([k]) => groupOf(k)));
  const expand = (k: Group) => {
    const at = i();
    setOpened((o) => ({ q: q().trim(), kinds: new Set([...(o.q === q().trim() ? o.kinds : []), k]) }));
    setI(at);
  };
  const { i, setI, key } = useListNav(() => ordered().length);
  const busy = useDebouncedAsk(
    () => q().trim(),
    (s) =>
      (s ? ask("search", { q: s, scope: init.mode === "code" ? "code" : "all" }) : ask("entryPoints", {})).catch(
        (): SearchItem[] => [],
      ),
    (r) => {
      setRes(r);
      setI(0);
    },
    (s) => (s ? 90 : 0),
  );
  useDebouncedAsk(
    () => {
      const s = init.mode === "code" ? "" : q().trim();
      return { s, again: retry().s === s && retry().n > 0 };
    },
    ({ s }) =>
      s ? ask("searchMeaning", { q: s }).catch((): MeaningResult => ({ items: [] })) : Promise.resolve({ items: [] }),
    (r, { s }) => {
      setMeaning({ ...r, q: s });
      if (r.left) setRetry((x) => ({ s, n: x.s === s ? x.n + 1 : 1 }));
    },
    ({ again }) => (again ? MEANING_RETRY : MEANING_PAUSE),
  );
  /** The reranker's order, asked once Related by Meaning has its whole answer (not while indexing); the host answers off
   *  while codeboard.search.rerank is off */
  useDebouncedAsk(
    () => {
      const m = meaningOf();
      return m.ranked || m.left || !m.items.length || m.q !== q().trim() ? "" : m.q;
    },
    (s) =>
      s ? ask("rerankMeaning", { q: s }).catch((): MeaningResult => ({ items: [], off: true })) : Promise.resolve(null),
    (r, s) => {
      const m = meaningOf();
      if (!r || r.off || !r.items.length || m.q !== s) return;
      // the rows already shown stay the same objects, so <For> moves their nodes instead of making new ones
      const had = new Map(m.items.map((it) => [keyOf(it), it]));
      const items = r.items.map((it) => had.get(keyOf(it)) ?? it);
      const on = ordered()[i()];
      const was = rowTops();
      setMeaning({ ...m, items, ranked: true });
      const at = on ? ordered().indexOf(on) : -1;
      if (at >= 0) setI(at);
      slide(was);
    },
    () => 0,
  );
  /** Where each card and sidenote row is now (in the list, so scrolling does not count) */
  const rowTops = () =>
    new Map([...list.querySelectorAll<HTMLElement>(".cand[data-k]")].map((e) => [e.dataset.k!, e.offsetTop]));
  /** Rows that moved slide from where they were to where they are (transform only: the compositor runs it at 60 fps) */
  const slide = (was: Map<string, number>) => {
    for (const e of list.querySelectorAll<HTMLElement>(".cand[data-k]")) {
      const from = was.get(e.dataset.k!);
      const dy = from === undefined ? 0 : from - e.offsetTop;
      if (dy)
        e.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
          duration: RERANK_SLIDE,
          easing: "cubic-bezier(.2,.7,.2,1)",
        });
      else if (from === undefined) e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RERANK_SLIDE });
    }
  };
  createEffect(() => {
    i();
    const on = list?.querySelector(".cand.on");
    if (on) scrollIntoBox(on, "nearest");
  });
  /** Searching cards (not Add Function, not the entry points): the preview pane beside the list */
  const wide = () => init.mode !== "code";
  const close = () => setPaletteOpen(false);
  useOverlay({ close, inside: (t) => !!t.closest(".palette"), grab: true, modal: true, outside: true });
  const run = async (it: SearchItem, alt: boolean) => {
    close();
    if (alt) {
      if (it.kind === "card" || it.kind === "sidenote") return send({ type: "openBoard", id: it.board, card: it.card });
      return send({ type: "openPath", path: it.path, line: "line" in it ? it.line : undefined });
    }
    if (it.kind === "card" || it.kind === "sidenote") {
      if (it.board === state.board.id) {
        select({ cards: [it.card] });
        A.revealCard(it.card);
      } else send({ type: "openBoard", id: it.board, card: it.card });
      return;
    }
    const r = await ask("searchPick", { item: it }).catch((e) => {
      toast((e as Error).message);
      return null;
    });
    if (r) A.addCards([r], { besideSel: false });
  };
  const onKey = (e: KeyboardEvent) => {
    keepKey(e);
    if (key(e)) return;
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      const it = ordered()[i()];
      if (it?.kind === "more") expand(it.group);
      else if (it) run(it, e.altKey);
    }
  };
  const icon = (it: SearchItem) =>
    it.kind === "symbol" ? (
      it.glyph
    ) : it.kind === "file" ? (
      "▤"
    ) : it.kind === "card" ? (
      "▣"
    ) : it.kind === "sidenote" ? (
      "◦"
    ) : (
      <Icon name="entry" size={13} />
    );
  const item = (it: Row) => {
    const idx = () => ordered().indexOf(it);
    if (it.kind === "more")
      return (
        <button
          class="cand more"
          classList={{ on: idx() === i() }}
          onPointerMove={(e) => {
            if (e.movementX || e.movementY) setI(idx());
          }}
          onClick={() => expand(it.group)}
        >
          <span class="kind">⋯</span>
          <span class="lb">Show {it.n} more</span>
        </button>
      );
    return (
      <button
        class="cand"
        data-k={keyOf(it) || undefined}
        classList={{ on: idx() === i(), faint: (it.kind === "card" || it.kind === "sidenote") && !!it.faint }}
        onPointerMove={(e) => {
          if (e.movementX || e.movementY) setI(idx());
        }}
        onClick={(e) => run(it, e.altKey)}
      >
        <span class="kind">{icon(it)}</span>
        <Show when={it.kind === "card" ? it.num : undefined}>{(n) => <span class="step sm">{n()}</span>}</Show>
        <Label it={it} />
        <Show when={(it.kind === "card" || it.kind === "sidenote") && it.faint}>
          <span class="maybe">maybe</span>
        </Show>
        <small>{it.detail}</small>
      </button>
    );
  };
  return (
    <div class="scrim light">
      <div class="palette pill" classList={{ wide: wide() }} data-nodrag onKeyDown={onKey}>
        <input
          ref={inp}
          class="pin"
          placeholder="Search Functions, Files, Cards, Sidenotes"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          spellcheck={false}
        />
        <div class="pbody">
          <div ref={list} class="plist">
            <For each={GROUPS}>
              {([k, title]) =>
                k === "meaning" ? (
                  <Show when={related().length || meaning().left || meaning().error}>
                    <div class="pgh">
                      {title}
                      <Show when={meaning().left}>{(n) => <span class="pnote"> · indexing, {n()} left</span>}</Show>
                    </div>
                    <Show when={meaning().error}>{(e) => <div class="empty perr">{e()}</div>}</Show>
                    <For each={related()}>{(it) => item(it)}</For>
                  </Show>
                ) : (
                  <Show when={groupOf(k).length}>
                    <div class="pgh">{title}</div>
                    <For each={groupOf(k)}>{(it) => item(it)}</For>
                  </Show>
                )
              }
            </For>
            <Show when={!res().length && !related().length && !meaning().error && !busy()}>
              <div class="empty">{q().trim() ? "No matches" : "No entry points found. Type to search."}</div>
            </Show>
          </div>
          <Show when={wide()}>
            <Preview it={((r) => (r?.kind === "more" ? undefined : r))(ordered()[i()])} q={q().trim()} />
          </Show>
        </div>
        <div class="pfoot">
          <span>
            <kbd>↵</kbd> Place on Board / Go to Card
          </span>
          <span>
            <kbd>{A.K.alt}↵</kbd> Open in Editor
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  );
}
