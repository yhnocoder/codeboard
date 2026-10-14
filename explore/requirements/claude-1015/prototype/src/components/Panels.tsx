import { For, Show, createMemo, createSignal, createEffect, on } from "solid-js";
import {
  state, setState, board, newBoard, placeFree, flyToCard, syncOf, addCard, codeCardFromSymbol, viewportCenter, uid, steps,
  type CodeCard, type Card,
} from "../store";
import { repo, listFiles, fileTokens, fileLines, symbols, commitInfo, symbolAt } from "../data/repo";
import { tokHtml } from "../lib/pytok";
import { Icon, startPresent } from "./Canvas";

// ---------- 顶栏 ----------

export function TopBar() {
  const [verOpen, setVerOpen] = createSignal(false);
  const stale = createMemo(() => board().cards.filter((c) => c.type === "code" && syncOf(c).state === "changed").length);
  return (
    <header class="topbar">
      <div class="brand">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="8" height="6" rx="1.5" /><rect x="13" y="14" width="8" height="6" rx="1.5" /><path d="M11 7h3a3 3 0 0 1 3 3v4" /></svg>
        </span>
        <span class="name">CodeBoard</span>
        <span class="sep">/</span>
        <span class="ws">{repo.name}</span>
        <span class="sep">/</span>
        <span class="bname">{board().name}</span>
      </div>
      <div class="seg" role="tablist" aria-label="布局">
        <button role="tab" classList={{ on: state.layout === "studio" }} onClick={() => setState("layout", "studio")} title="三栏：文件和大纲、画布、源码">工作台</button>
        <button role="tab" classList={{ on: state.layout === "focus" }} onClick={() => setState("layout", "focus")} title="只有画布，其他按需浮出（\\ 切换）">专注</button>
      </div>
      <div class="right">
        <div class="ver">
          <button class="chip" onClick={() => setVerOpen(!verOpen())} title="工作区当前看的版本">
            <i class="dot" />工作区 {state.workCommit}
            <Show when={stale()}><em>{stale()} 张卡片有新版本</em></Show>
          </button>
          <Show when={verOpen()}>
            <div class="pop ver-pop" onPointerLeave={() => setVerOpen(false)}>
              <For each={repo.commits}>
                {(c) => (
                  <button classList={{ on: state.workCommit === c.short }} onClick={() => { setState("workCommit", c.short); setVerOpen(false); }}>
                    <code>{c.short}</code><span>{c.subject}</span><small>{c.date}{c.short === repo.head ? " · HEAD" : ""}</small>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <button class="ghost" classList={{ on: state.showTrace }} onClick={() => setState("showTrace", !state.showTrace)} title="叠加一份示例追踪数据，看阶段二的运行时追踪会填在哪里"><Icon d="M3 12h4l3-7 4 14 3-7h4" />追踪<small>示例</small></button>
        <button class="ghost" onClick={startPresent} title="按编号逐步讲解（P）"><Icon d="M7 5l12 7-12 7z" />讲解</button>
        <button class="ghost search" onClick={() => setState("palette", true)}><Icon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M16 16l4 4" />搜索<kbd>⌘K</kbd></button>
      </div>
    </header>
  );
}

// ---------- 左侧栏 ----------

export function Sidebar() {
  return (
    <aside class="sidebar">
      <section class="boards">
        <div class="sec-h">白板<button class="add" title="新白板" onClick={newBoard}>＋</button></div>
        <For each={state.boards}>
          {(b) => (
            <button class="board-item" classList={{ on: b.id === state.active }} onClick={() => setState({ active: b.id, selected: null, present: null })}>
              <span>{b.name}</span><small>{b.cards.filter((c) => c.type === "code").length}</small>
            </button>
          )}
        </For>
      </section>
      <div class="tabs">
        <button classList={{ on: state.sidebarTab === "outline" }} onClick={() => setState("sidebarTab", "outline")}>大纲</button>
        <button classList={{ on: state.sidebarTab === "files" }} onClick={() => setState("sidebarTab", "files")}>文件</button>
      </div>
      <Show when={state.sidebarTab === "outline"} fallback={<FileTree />}>
        <Outline />
      </Show>
    </aside>
  );
}

type Node = { card: Card; kids: Node[] };
/** 按箭头关系把卡片排成树：没有入边的是根，子节点按出发行号排序 */
export function outlineTree(): Node[] {
  const b = board();
  const code = b.cards.filter((c) => c.type === "code") as CodeCard[];
  const ids = new Set(code.map((c) => c.id));
  const incoming = new Set(b.edges.filter((e) => ids.has(e.from.card) && ids.has(e.to.card)).map((e) => e.to.card));
  const seen = new Set<string>();
  const build = (c: Card): Node => {
    seen.add(c.id);
    const kids = b.edges
      .filter((e) => e.from.card === c.id && ids.has(e.to.card))
      .sort((x, y) => (x.from.line ?? 0) - (y.from.line ?? 0))
      .map((e) => code.find((k) => k.id === e.to.card)!)
      .filter((k) => !seen.has(k.id))
      .map(build);
    return { card: c, kids };
  };
  const roots = code.filter((c) => !incoming.has(c.id)).map((c) => (seen.has(c.id) ? null : build(c))).filter(Boolean) as Node[];
  for (const c of code) if (!seen.has(c.id)) roots.push(build(c));
  return roots;
}

function Outline() {
  const tree = createMemo(outlineTree);
  const Row = (p: { n: Node; depth: number }) => {
    const c = p.n.card as CodeCard;
    const s = createMemo(() => syncOf(c).state);
    return (
      <>
        <button class="ol-row" classList={{ on: state.selected?.id === c.id }} style={{ "padding-left": `${12 + p.depth * 14}px` }} onClick={() => flyToCard(c.id)}>
          <Show when={c.step} fallback={<span class="ol-dot" />}><span class="ol-step">{c.step}</span></Show>
          <span class="ol-name">{c.title ?? c.qual ?? c.path}</span>
          <Show when={s() === "changed"}><i class="mini-dot warn" title="源码有新版本" /></Show>
        </button>
        <For each={p.n.kids}>{(k) => <Row n={k} depth={p.depth + 1} />}</For>
      </>
    );
  };
  return (
    <div class="outline">
      <Show when={tree().length} fallback={<p class="hint">白板上还没有代码卡片。大纲会按箭头关系自动排成调用树。</p>}>
        <For each={tree()}>{(n) => <Row n={n} depth={0} />}</For>
      </Show>
      <Show when={tree().length}><p class="hint">大纲按箭头自动生成：谁连向谁，谁就是它的下一层。</p></Show>
    </div>
  );
}

function FileTree() {
  const files = listFiles();
  const dirs = createMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of files) {
      const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
      m.set(d, [...(m.get(d) ?? []), f]);
    }
    return [...m.entries()];
  });
  const [closed, setClosed] = createSignal<Record<string, boolean>>({});
  return (
    <div class="files">
      <For each={dirs()}>
        {([d, fs]) => (
          <div>
            <Show when={d}>
              <button class="dir" onClick={() => setClosed({ ...closed(), [d]: !closed()[d] })}>
                <span class="caret" classList={{ shut: closed()[d] }}>▾</span>{d}/
              </button>
            </Show>
            <Show when={!closed()[d]}>
              <For each={fs}>
                {(f) => (
                  <button class="file" classList={{ on: state.source?.path === f }} style={{ "padding-left": d ? "30px" : "14px" }}
                    onClick={() => setState("source", { path: f, commit: state.workCommit })}>
                    {f.split("/").pop()}
                  </button>
                )}
              </For>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

// ---------- 源码面板 ----------

export function SourcePanel() {
  const src = () => state.source!;
  const lines = createMemo(() => fileTokens(src().commit, src().path).map((ts) => ts.map(tokHtml).join("")));
  const defs = createMemo(() => new Map(symbols(src().commit, src().path).map((s) => [s.defLine, s])));
  const [sel, setSel] = createSignal<[number, number] | null>(null);
  let body!: HTMLDivElement;

  createEffect(on(() => [src().path, src().commit, src().reveal?.[0]], () => {
    setSel(null);
    const r = src().reveal;
    queueMicrotask(() => {
      if (!body) return;
      body.scrollTop = r ? Math.max(0, (r[0] - 4) * 20) : 0;
    });
  }));

  const range = () => { const s = sel(); return s ? [Math.min(s[0], s[1]), Math.max(s[0], s[1])] as const : null; };
  const inSel = (n: number) => { const r = range(); return !!r && n >= r[0] && n <= r[1]; };

  const down = (e: PointerEvent, n: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const start = e.shiftKey && sel() ? sel()![0] : n;
    setSel([start, n]);
    const move = (ev: PointerEvent) => {
      const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest("[data-n]") as HTMLElement | null;
      if (row) setSel([start, Number(row.dataset.n)]);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const makeCard = () => {
    const r = range();
    if (!r) return;
    const c = viewportCenter();
    const p = placeFree(c.x - 260, c.y - 120, 520);
    const sym = symbolAt(src().commit, src().path, r[0]);
    const exact = sym && sym.start === r[0] && sym.end === r[1];
    addCard({
      id: uid("c"), type: "code", x: p.x, y: p.y, w: 520,
      path: src().path, start: r[0], end: r[1], commit: src().commit, hl: [],
      ...(exact ? { qual: sym!.qual } : { title: sym ? `${sym.qual} · 片段` : undefined }),
    });
  };
  const addFn = (line: number) => {
    const s = defs().get(line)!;
    const c = viewportCenter();
    const p = placeFree(c.x - 270, c.y - 120, 540);
    addCard(codeCardFromSymbol(s, src().commit, p.x, p.y));
  };
  const onBoard = createMemo(() => board().cards.filter((c) => c.type === "code" && c.path === src().path) as CodeCard[]);
  const cardAt = (n: number) => onBoard().find((c) => n >= c.start && n <= c.end && c.commit === src().commit);

  return (
    <aside class="source-panel" classList={{ floating: state.layout === "focus" }}>
      <div class="sp-head">
        <div class="sp-path"><span>{src().path.split("/").slice(0, -1).join("/")}/</span><b>{src().path.split("/").pop()}</b></div>
        <span class="chip small" title={commitInfo(src().commit).subject}><i class="dot" />{src().commit}</span>
        <button class="x" title="关闭" onClick={() => setState("source", null)}>×</button>
      </div>
      <div class="sp-body" ref={body}>
        <For each={lines()}>
          {(html, i) => {
            const n = i() + 1;
            const def = () => defs().get(n);
            return (
              <div class="sp-line" data-n={n} classList={{ sel: inSel(n), reveal: !!src().reveal && n >= src().reveal![0] && n <= src().reveal![1], oncard: !!cardAt(n) }} onPointerDown={(e) => down(e, n)}>
                <span class="ln">{n}</span>
                <span class="src" innerHTML={html || " "} />
                <Show when={def() && def()!.kind === "def"}>
                  <button class="add-fn" title={`把 ${def()!.qual} 放到白板上`} onClick={() => addFn(n)}>＋ 卡片</button>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <div class="sp-foot">
        <Show when={range()} fallback={<span class="hint">拖选几行生成卡片，或点函数旁的「＋ 卡片」。左侧竖条表示已经在白板上的代码。</span>}>
          <span>已选 {range()![0]}–{range()![1]} 行</span>
          <button class="primary" onClick={makeCard}>生成卡片</button>
        </Show>
      </div>
    </aside>
  );
}


