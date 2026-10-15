import { For, Show, createMemo, createSignal } from "solid-js";
import {
  state, setState, board, toast, followLatest, cardLines, syncOf, addCard, codeCardFromSymbol, viewportCenter, placeFree, flyToCard, steps, fitAll,
  type CodeCard,
} from "../store";
import { allSymbols, listFiles, fileLines, commitInfo } from "../data/repo";
import { diffLines } from "../lib/diff";
import { present } from "./Canvas";

// ---------- ⌘K 搜索 ----------

type Item = { kind: "函数" | "类" | "文件" | "卡片" | "白板"; label: string; hint: string; run: () => void };

export function Palette() {
  const [q, setQ] = createSignal("");
  const [idx, setIdx] = createSignal(0);
  const items = createMemo<Item[]>(() => {
    const s = q().trim().toLowerCase();
    const syms = allSymbols(state.workCommit);
    const all: Item[] = [
      ...board().cards.filter((c) => c.type === "code").map((c) => {
        const cc = c as CodeCard;
        return { kind: "卡片" as const, label: cc.title ?? cc.qual ?? cc.path, hint: "在白板上，跳过去", run: () => flyToCard(c.id) };
      }),
      ...syms.map((s) => ({
        kind: (s.kind === "class" ? "类" : "函数") as Item["kind"], label: s.qual, hint: s.path.replace("nanovllm/", ""),
        run: () => {
          const ex = board().cards.find((c) => c.type === "code" && c.qual === s.qual);
          if (ex) return flyToCard(ex.id);
          const c = viewportCenter();
          const p = placeFree(c.x - 270, c.y - 120, 540);
          addCard(codeCardFromSymbol(s, state.workCommit, p.x, p.y));
        },
      })),
      ...listFiles().map((f) => ({ kind: "文件" as const, label: f, hint: "在源码面板打开", run: () => setState("source", { path: f, commit: state.workCommit }) })),
      ...state.boards.map((b) => ({ kind: "白板" as const, label: b.name, hint: "切换白板", run: () => { setState({ active: b.id, selected: null }); } })),
    ];
    if (!s) return all.filter((i) => i.kind !== "文件").slice(0, 12);
    const score = (i: Item) => {
      const l = i.label.toLowerCase();
      if (l === s) return 0;
      if (l.split(/[./]/).pop()!.startsWith(s)) return 1;
      if (l.includes(s)) return 2;
      let k = 0;
      for (const ch of l) if (ch === s[k]) k++;
      return k === s.length ? 3 : 9;
    };
    return all.map((i) => [score(i), i] as const).filter(([sc]) => sc < 9).sort((a, b) => a[0] - b[0]).slice(0, 14).map(([, i]) => i);
  });
  const go = (i: Item | undefined) => { if (!i) return; setState("palette", false); setQ(""); i.run(); };
  return (
    <Show when={state.palette}>
      <div class="scrim" onPointerDown={() => setState("palette", false)}>
        <div class="palette" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="搜索">
          <input
            id="palette-q"
            autofocus
            ref={(el) => queueMicrotask(() => el.focus())}
            placeholder="搜函数、类、文件或卡片，回车放到白板上"
            value={q()}
            onInput={(e) => { setQ(e.currentTarget.value); setIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setIdx(Math.min(items().length - 1, idx() + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIdx(Math.max(0, idx() - 1)); }
              else if (e.key === "Enter") go(items()[idx()]);
              else if (e.key === "Escape") setState("palette", false);
            }}
          />
          <div class="results">
            <For each={items()}>
              {(it, i) => (
                <button classList={{ on: i() === idx() }} onPointerEnter={() => setIdx(i())} onClick={() => go(it)}>
                  <span class="kind">{it.kind}</span><span class="label">{it.label}</span><span class="hint">{it.hint}</span>
                </button>
              )}
            </For>
            <Show when={!items().length}><p class="none">没有找到「{q()}」</p></Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

// ---------- 新版本 diff ----------

export function DiffPopover() {
  const card = () => board().cards.find((c) => c.id === state.diffFor) as CodeCard | undefined;
  const d = createMemo(() => {
    const c = card();
    if (!c) return null;
    const s = syncOf(c);
    if (s.state !== "changed") return null;
    return { s, lines: diffLines(cardLines(c), fileLines(state.workCommit, c.path).slice(s.start - 1, s.end), c.start, s.start) };
  });
  return (
    <Show when={card() && d()}>
      <div class="scrim" onPointerDown={() => setState("diffFor", null)}>
        <div class="diff" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="源码新版本">
          <div class="diff-h">
            <div>
              <h3>{card()!.qual ?? card()!.title} 有新版本</h3>
              <p>卡片钉在 <code>{card()!.commit}</code>（{commitInfo(card()!.commit).date}），工作区是 <code>{state.workCommit}</code>：{commitInfo(state.workCommit).subject}</p>
            </div>
            <span class="stat"><b class="add">+{(d()!.s as any).added}</b> <b class="del">−{(d()!.s as any).removed}</b></span>
          </div>
          <div class="diff-body">
            <For each={d()!.lines}>
              {(l) => (
                <div class={`dl op-${l.op === "+" ? "add" : l.op === "-" ? "del" : "eq"}`}>
                  <span class="ln">{l.a ?? ""}</span><span class="ln">{l.b ?? ""}</span><span class="op">{l.op}</span><span class="t">{l.text}</span>
                </div>
              )}
            </For>
          </div>
          <div class="diff-f">
            <span class="hint">跟进后，高亮行和从这张卡片出发的箭头会按内容迁移到新行号。</span>
            <button onClick={() => setState("diffFor", null)}>留在旧版本</button>
            <button class="primary" onClick={() => followLatest(card()!.id)}>跟进到 {state.workCommit}</button>
          </div>
        </div>
      </div>
    </Show>
  );
}

// ---------- 小菜单、提示、讲解条 ----------

export function Menu() {
  return (
    <Show when={state.menu}>
      {(m) => (
        <div class="scrim clear" onPointerDown={() => setState("menu", null)}>
          <div class="menu" style={{ left: `${m().x}px`, top: `${m().y + 8}px` }} onPointerDown={(e) => e.stopPropagation()}>
            <div class="menu-h">有多个同名定义，选一个展开</div>
            <For each={m().items}>
              {(it) => <button onClick={() => { setState("menu", null); it.run(); }}><span>{it.label}</span><small>{it.hint}</small></button>}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
}

export function Toast() {
  return <Show when={toast()}><div class="toast" role="status">{toast()}</div></Show>;
}

export function PresentBar() {
  const cur = () => (state.present === null ? null : steps()[state.present] as CodeCard | undefined);
  return (
    <Show when={cur()}>
      <div class="present-bar">
        <button onClick={() => present(Math.max(0, state.present! - 1))} disabled={state.present === 0} aria-label="上一步">←</button>
        <div class="pb-mid">
          <span class="step">{cur()!.step}</span>
          <span class="pb-title">{cur()!.title ?? cur()!.qual}</span>
          <span class="pb-count">{state.present! + 1} / {steps().length}</span>
        </div>
        <button onClick={() => present(Math.min(steps().length - 1, state.present! + 1))} disabled={state.present === steps().length - 1} aria-label="下一步">→</button>
        <button class="pb-x" onClick={() => { setState("present", null); fitAll(); }}>退出 <kbd>Esc</kbd></button>
      </div>
    </Show>
  );
}
