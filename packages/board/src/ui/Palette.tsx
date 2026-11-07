// 鼠标只有真的移动才改高亮项：结果刷新时停在原地的鼠标不该抢走键盘选中的那项。
// 没输入时列出入口（pyproject scripts、__init__ 导出、__main__、examples）。
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
import { MEANING_PAUSE, MEANING_RETRY } from "../state/timing";
import { ask, send } from "../host";
import * as A from "../actions";

const GROUPS: [SearchItem["kind"], string][] = [
  ["entry", "Entry Points"],
  ["symbol", "Functions & Classes"],
  ["file", "Files"],
  ["card", "Cards on Boards"],
  ["sidenote", "Sidenotes"],
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
  const [meaning, setMeaning] = createSignal<MeaningResult>({ items: [] });
  /** asked again while indexing: for which query, how many times */
  const [retry, setRetry] = createSignal({ s: "", n: 0 });
  /** Related by Meaning, without what the words already found */
  const related = createMemo(() => {
    const key = (r: SearchItem) => (r.kind === "sidenote" ? `s:${r.sidenote}` : r.kind === "card" ? `c:${r.card}` : "");
    const found = new Set(res().map(key));
    return meaning().items.filter((r) => !found.has(key(r)));
  });
  const ordered = createMemo(() => [...GROUPS.flatMap(([k]) => res().filter((r) => r.kind === k)), ...related()]);
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
      setMeaning(r);
      if (r.left) setRetry((x) => ({ s, n: x.s === s ? x.n + 1 : 1 }));
    },
    ({ again }) => (again ? MEANING_RETRY : MEANING_PAUSE),
  );
  createEffect(() => {
    i();
    const on = list?.querySelector(".cand.on");
    if (on) scrollIntoBox(on, "nearest");
  });
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
      if (it) run(it, e.altKey);
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
  const item = (it: SearchItem) => {
    const idx = () => ordered().indexOf(it);
    return (
      <button
        class="cand"
        classList={{ on: idx() === i() }}
        onPointerMove={(e) => {
          if (e.movementX || e.movementY) setI(idx());
        }}
        onClick={(e) => run(it, e.altKey)}
      >
        <span class="kind">{icon(it)}</span>
        <Show when={it.kind === "card" ? it.num : undefined}>{(n) => <span class="step sm">{n()}</span>}</Show>
        <span class="lb">{it.label}</span>
        <small>{it.detail}</small>
      </button>
    );
  };
  return (
    <div class="scrim light">
      <div class="palette pill" data-nodrag onKeyDown={onKey}>
        <input
          ref={inp}
          class="pin"
          placeholder="Search Functions, Files, Cards, Sidenotes"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          spellcheck={false}
        />
        <div ref={list} class="plist">
          <For each={GROUPS}>
            {([k, title]) => (
              <Show when={res().some((r) => r.kind === k)}>
                <div class="pgh">{title}</div>
                <For each={res().filter((r) => r.kind === k)}>{(it) => item(it)}</For>
              </Show>
            )}
          </For>
          <Show when={related().length || meaning().left || meaning().error}>
            <div class="pgh">
              Related by Meaning
              <Show when={meaning().left}>{(n) => <span class="pnote"> · indexing, {n()} left</span>}</Show>
            </div>
            <Show when={meaning().error}>{(e) => <div class="empty perr">{e()}</div>}</Show>
            <For each={related()}>{(it) => item(it)}</For>
          </Show>
          <Show when={!res().length && !related().length && !busy()}>
            <div class="empty">{q().trim() ? "No matches" : "No entry points found. Type to search."}</div>
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
