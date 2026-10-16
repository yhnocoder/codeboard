// ⌘K：搜函数、类、文件、白板上的卡片、Sidenote。↵ 放到白板 / 跳到卡片；⌥↵ 在编辑器里打开；Esc 关。
// 鼠标只有真的移动才改高亮项：结果刷新时停在原地的鼠标不该抢走键盘选中的那项。
// 没输入时列出入口（pyproject scripts、__init__ 导出、__main__、examples）。
import { Icon } from "./icons";
import { For, Show, createSignal, createEffect, onMount, createMemo } from "solid-js";
import type { SearchItem, NewCard } from "@codeboard/core";
import { state, select, toast } from "../state/store";
import { paletteOpen, setPaletteOpen } from "../state/ui";
import { ask, send } from "../host";
import * as A from "../actions";

const GROUPS: [SearchItem["kind"], string][] = [["entry", "Entry Points"], ["symbol", "Functions & Classes"], ["file", "Files"], ["card", "Cards on Boards"], ["sidenote", "Sidenotes"]];

export function Palette() {
  const init = paletteOpen() || { mode: "all" as const };
  const [q, setQ] = createSignal((init as any).q ?? "");
  const [res, setRes] = createSignal<SearchItem[]>([]);
  const [i, setI] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  let inp!: HTMLInputElement, list!: HTMLDivElement;
  onMount(() => { inp.focus(); inp.select(); });
  let t: number | undefined, n = 0;
  createEffect(() => {
    const s = q().trim();
    clearTimeout(t);
    const my = ++n;
    t = window.setTimeout(async () => {
      setBusy(true);
      const r = s ? await ask("search", { q: s, scope: init.mode === "code" ? "code" : "all" }).catch(() => []) : await ask("entryPoints", {}).catch(() => []);
      if (my !== n) return;
      setRes(r); setI(0); setBusy(false);
    }, s ? 90 : 0);
  });
  const ordered = createMemo(() => GROUPS.flatMap(([k]) => res().filter((r) => r.kind === k)));
  createEffect(() => { i(); list?.querySelector(".cand.on")?.scrollIntoView({ block: "nearest" }); });
  const close = () => setPaletteOpen(false);
  const run = async (it: SearchItem, alt: boolean) => {
    close();
    if (alt) {
      if (it.kind === "card" || it.kind === "sidenote") return send({ type: "openBoard", id: it.board, card: it.card });
      return send({ type: "openPath", path: it.path, line: "line" in it ? it.line : undefined });
    }
    if (it.kind === "card" || it.kind === "sidenote") {
      if (it.board === state.board.id) { select({ cards: [it.card] }); A.revealCard(it.card); }
      else send({ type: "openBoard", id: it.board, card: it.card });
      return;
    }
    const r = await ask("searchPick", { item: it }).catch((e) => { toast((e as Error).message); return null; });
    if (r) A.addCards([r], { besideSel: false });
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const n2 = ordered().length;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => (x + 1) % Math.max(1, n2)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => (x - 1 + n2) % Math.max(1, n2)); }
    else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); const it = ordered()[i()]; if (it) run(it, e.altKey); }
  };
  const icon = (it: SearchItem) => (it.kind === "symbol" ? it.glyph : it.kind === "file" ? "▤" : it.kind === "card" ? "▣" : it.kind === "sidenote" ? "◦" : <Icon name="entry" size={13} />);
  return (
    <div class="scrim light" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="palette pill" onKeyDown={onKey}>
        <input ref={inp} class="pin" placeholder="Search Functions, Files, Cards, Sidenotes" value={q()} onInput={(e) => setQ(e.currentTarget.value)} spellcheck={false} />
        <div ref={list} class="plist">
          <For each={GROUPS}>{([k, title]) => (
            <Show when={res().some((r) => r.kind === k)}>
              <div class="pgh">{title}</div>
              <For each={res().filter((r) => r.kind === k)}>{(it) => {
                const idx = () => ordered().indexOf(it);
                return (
                  <button class="cand" classList={{ on: idx() === i() }} onPointerMove={(e) => { if (e.movementX || e.movementY) setI(idx()); }} onClick={(e) => run(it, e.altKey)}>
                    <span class="kind">{icon(it)}</span>
                    <Show when={it.kind === "card" && it.num}><span class="step sm">{(it as any).num}</span></Show>
                    <span class="lb">{it.label}</span><small>{it.detail}</small>
                  </button>
                );
              }}</For>
            </Show>
          )}</For>
          <Show when={!res().length && !busy()}><div class="empty">{q().trim() ? "No matches" : "No entry points found. Type to search."}</div></Show>
        </div>
        <div class="pfoot"><span><kbd>↵</kbd> Place on Board / Go to Card</span><span><kbd>{A.K.alt}↵</kbd> Open in Editor</span><span><kbd>Esc</kbd> Close</span></div>
      </div>
    </div>
  );
}
