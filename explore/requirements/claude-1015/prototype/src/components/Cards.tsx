import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import {
  state, setState, board, sizes, setSizes, updateCard, bringToFront, addCard, addEdge, cardLines, syncOf,
  codeCardFromSymbol, say, steps, ensureVisible, renumberChildren,
  type Card, type CodeCard, type NoteCard, type ImageCard, type LinkCard, type GroupCard,
} from "../store";
import { fileTokens, resolveCall, commitInfo, type Symbol } from "../data/repo";
import { tokHtml, type Tok } from "../lib/pytok";
import { HEADER, LH, lineY, rectOf, overlaps } from "./geom";
import { traceExample } from "../seed/boards";
import { startLink } from "./Canvas";

// ---------- 拖动 ----------

function dragCard(ev: PointerEvent, c: Card) {
  if (ev.button !== 0) return;
  if ((ev.target as HTMLElement).closest("button,a,input,textarea")) return;
  ev.stopPropagation();
  ev.preventDefault();
  setState("selected", { kind: "card", id: c.id });
  bringToFront(c.id);
  const z = board().cam.z;
  const sx = ev.clientX, sy = ev.clientY;
  // 拖分组时，中心落在框内的卡片一起走
  const riders = c.type === "group"
    ? board().cards.filter((o) => {
        if (o.id === c.id || o.type === "group") return false;
        const r = rectOf(o), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        return cx > c.x && cx < c.x + c.w && cy > c.y && cy < c.y + c.h;
      }).map((o) => ({ id: o.id, x: o.x, y: o.y }))
    : [];
  const ox = c.x, oy = c.y;
  const el = ev.currentTarget as HTMLElement;
  el.setPointerCapture(ev.pointerId);
  document.body.classList.add("dragging");
  const move = (e: PointerEvent) => {
    const dx = (e.clientX - sx) / z, dy = (e.clientY - sy) / z;
    updateCard(c.id, { x: Math.round(ox + dx), y: Math.round(oy + dy) });
    for (const r of riders) updateCard(r.id, { x: Math.round(r.x + dx), y: Math.round(r.y + dy) });
  };
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    document.body.classList.remove("dragging");
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
}

function dragResize(ev: PointerEvent, c: Card, both: boolean) {
  ev.stopPropagation();
  const z = board().cam.z;
  const sx = ev.clientX, sy = ev.clientY, ow = c.w, oh = c.type === "group" ? c.h : 0;
  const el = ev.currentTarget as HTMLElement;
  el.setPointerCapture(ev.pointerId);
  const move = (e: PointerEvent) => {
    const w = Math.max(220, Math.round(ow + (e.clientX - sx) / z));
    if (both) updateCard(c.id, { w, h: Math.max(160, Math.round(oh + (e.clientY - sy) / z)) } as Partial<GroupCard>);
    else updateCard(c.id, { w });
  };
  const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
}

// ---------- 外壳 ----------

function Shell(props: { card: Card; class: string; children: JSX.Element; port?: boolean }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(() => setSizes(props.card.id, { w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    onCleanup(() => { ro.disconnect(); setSizes(props.card.id, undefined!); });
  });
  const selected = () => state.selected?.kind === "card" && state.selected.id === props.card.id;
  const presenting = () => state.present !== null && steps()[state.present]?.id === props.card.id;
  return (
    <div
      ref={el}
      data-card={props.card.id}
      class={`card ${props.class}`}
      classList={{ selected: selected(), current: presenting() }}
      style={{ left: `${props.card.x}px`, top: `${props.card.y}px`, width: `${props.card.w}px`, ...(props.card.type === "group" ? { height: `${props.card.h}px` } : {}) }}
      onPointerDown={(e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest("button,a,textarea,.code-line,.port")) {
          setState("selected", { kind: "card", id: props.card.id });
        }
      }}
    >
      {props.children}
      <Show when={props.port !== false}>
        <div class="port card-port" title="拖出一条箭头" onPointerDown={(e) => startLink(e, { card: props.card.id })} />
      </Show>
      <div class="resize" classList={{ both: props.card.type === "group" }} onPointerDown={(e) => dragResize(e, props.card, props.card.type === "group")} />
    </div>
  );
}

export function CardView(props: { card: Card }) {
  const c = () => props.card;
  return (
    <>
      <Show when={c().type === "code"}><CodeView card={c() as CodeCard} /></Show>
      <Show when={c().type === "note"}><NoteView card={c() as NoteCard} /></Show>
      <Show when={c().type === "image"}><ImageView card={c() as ImageCard} /></Show>
      <Show when={c().type === "link"}><LinkView card={c() as LinkCard} /></Show>
    </>
  );
}

// ---------- 代码卡片 ----------

/** 把一行 token 渲染成 HTML，能解析到定义的调用加上可点击标记 */
function lineHtml(toks: Tok[], commit: string): string {
  let html = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let name: string | undefined, recv: string | undefined;
    if (t.k === "call") {
      name = t.t;
      if (toks[i - 1]?.t === "." && toks[i - 2]) recv = toks[i - 2].t;
    } else if (t.k === "str" && toks[i - 1]?.t === "(" && toks[i - 2]?.t === "call") {
      // self.model_runner.call("run", ...) 这种按名字分发的调用
      name = t.t.replace(/^["']|["']$/g, "");
      recv = toks[i - 4]?.t;
    }
    if (name && resolveCall(commit, name, recv).length) {
      html += `<span class="xref" data-call="${name}" data-recv="${recv ?? ""}">${tokHtml(t)}</span>`;
    } else html += tokHtml(t);
  }
  return html;
}

function cardTitle(c: CodeCard) {
  return c.title ?? c.qual ?? `${c.path.split("/").pop()}:${c.start}`;
}

/** 给展开出来的卡片找位置：优先放在那一行的右边；右边挤了就缩进放到源卡片下方 */
function placeNear(src: CodeCard, line: number, w: number): { x: number; y: number } {
  const others = board().cards.filter((o) => o.type !== "group" && o.id !== src.id);
  const free = (x: number, y: number) => !others.some((o) => overlaps({ x, y, w, h: 220 }, rectOf(o)));
  const srcR = rectOf(src);
  const right = { x: srcR.x + srcR.w + 90, y: Math.round(lineY(src, line) - HEADER) };
  for (let i = 0; i < 3; i++) if (free(right.x, right.y + i * 60)) return { x: right.x, y: right.y + i * 60 };
  // 放到源卡片和它已有下级的下面，向右缩进 50
  const kids = board().edges.filter((e) => e.from.card === src.id).map((e) => others.find((o) => o.id === e.to.card)).filter(Boolean) as Card[];
  let y = Math.max(srcR.y + srcR.h, ...kids.filter((k) => k.x >= srcR.x - 20 && k.x <= srcR.x + 120).map((k) => rectOf(k).y + rectOf(k).h)) + 30;
  const x = srcR.x + 50;
  for (let i = 0; i < 60 && !free(x, y); i++) y += 40;
  return { x, y };
}

export function expandCall(src: CodeCard, line: number, sym: Symbol) {
  const existing = board().cards.find((o) => o.type === "code" && o.qual === sym.qual && o.path === sym.path);
  if (existing) {
    addEdge({ from: { card: src.id, line }, to: { card: existing.id }, kind: "call" });
    say(`已连到画布上已有的 ${sym.qual}`);
    return;
  }
  const p = placeNear(src, line, 540);
  const card = codeCardFromSymbol(sym, src.commit, p.x, p.y);
  if (src.step) card.step = `${src.step}.0`;
  addCard(card);
  addEdge({ from: { card: src.id, line }, to: { card: card.id }, kind: "call" });
  renumberChildren(src.id);
  ensureVisible(card.id);
}

function CodeView(props: { card: CodeCard }) {
  const c = () => props.card;
  const lines = createMemo(() => {
    const toks = fileTokens(c().commit, c().path);
    return cardLines(c()).map((_, i) => lineHtml(toks[c().start - 1 + i] ?? [], c().commit));
  });
  const sync = createMemo(() => syncOf(c()));
  const info = () => commitInfo(c().commit);
  const [hoverLine, setHoverLine] = createSignal<number | null>(null);

  const onCodeClick = (e: MouseEvent, line: number) => {
    const x = (e.target as HTMLElement).closest("[data-call]") as HTMLElement | null;
    if (!x) return;
    e.stopPropagation();
    const cands = resolveCall(c().commit, x.dataset.call!, x.dataset.recv || undefined);
    if (cands.length === 1) return expandCall(c(), line, cands[0]);
    setState("menu", {
      x: e.clientX, y: e.clientY,
      items: cands.map((s) => ({ label: s.qual, hint: s.path.replace("nanovllm/", ""), run: () => expandCall(c(), line, s) })),
    });
  };
  const toggleHl = (line: number) => {
    const hl = c().hl.includes(line) ? c().hl.filter((l) => l !== line) : [...c().hl, line];
    updateCard(c().id, { hl });
  };

  return (
    <Shell card={c()} class="code-card" >
      <div class="card-head" onPointerDown={(e) => dragCard(e, c())}>
        <Show when={c().step}><span class="step">{c().step}</span></Show>
        <span class="title">{cardTitle(c())}</span>
        <Show when={state.showTrace && traceExample.cards[c().id]}><span class="calls" title="示例追踪：调用次数">{traceExample.cards[c().id]}</span></Show>
        <span class="path">{c().path.replace("nanovllm/", "")}</span>
        <button
          class={`rev s-${sync().state}`}
          title={sync().state === "changed" ? `源码有新版本（+${(sync() as any).added} −${(sync() as any).removed}），点开看 diff` : sync().state === "lost" ? "在工作区版本里找不到这段代码" : `${info().date} · ${info().subject}`}
          onClick={(e) => { e.stopPropagation(); if (sync().state === "changed") setState("diffFor", c().id); }}
        >
          <i />{c().commit}
          <Show when={sync().state === "changed"}><em>有新版本</em></Show>
        </button>
        <div class="head-actions">
          <button title="在源码面板中打开" onClick={(e) => { e.stopPropagation(); setState("source", { path: c().path, commit: c().commit, reveal: [c().start, c().end] }); }}>源码</button>
          <button title={c().collapsed ? "展开" : "折叠"} onClick={(e) => { e.stopPropagation(); updateCard(c().id, { collapsed: !c().collapsed }); }}>{c().collapsed ? "展开" : "折叠"}</button>
        </div>
      </div>
      <Show when={!c().collapsed} fallback={<div class="io">{c().io ?? `${c().end - c().start + 1} 行 · 展开查看`}</div>}>
        <div class="code" style={{ "--lh": `${LH}px` }}>
          <For each={lines()}>
            {(html, i) => {
              const ln = () => c().start + i();
              return (
                <div
                  class="code-line"
                  classList={{ hl: c().hl.includes(ln()) }}
                  onPointerEnter={() => setHoverLine(ln())}
                  onPointerLeave={() => setHoverLine(null)}
                >
                  <span class="ln" title="点击高亮这一行" onClick={() => toggleHl(ln())}>{ln()}</span>
                  <span class="src" innerHTML={html} onClick={(e) => onCodeClick(e, ln())} />
                  <Show when={hoverLine() === ln()}>
                    <span class="port line-port" title="从这一行拖出箭头" onPointerDown={(e) => startLink(e, { card: c().id, line: ln() })} />
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={c().note}><div class="card-note">{c().note}</div></Show>
      </Show>
    </Shell>
  );
}

// ---------- 便签 ----------

export function md(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
  const out: string[] = [];
  let list = false;
  for (const raw of text.split("\n")) {
    const l = raw.trimEnd();
    if (/^- /.test(l)) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(l.slice(2))}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    if (/^# /.test(l)) out.push(`<h3>${inline(l.slice(2))}</h3>`);
    else if (l) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("");
}

function NoteView(props: { card: NoteCard }) {
  const [editing, setEditing] = createSignal(props.card.text === "");
  let ta!: HTMLTextAreaElement;
  return (
    <Shell card={props.card} class={`note-card tone-${props.card.tone ?? "plain"}`}>
      <div class="grip" onPointerDown={(e) => dragCard(e, props.card)} />
      <Show
        when={editing()}
        fallback={<div class="md" onPointerDown={(e) => dragCard(e, props.card)} onDblClick={() => setEditing(true)} innerHTML={md(props.card.text)} />}
      >
        <textarea
          ref={(el) => { ta = el; queueMicrotask(() => { el.focus(); el.style.height = el.scrollHeight + "px"; }); }}
          value={props.card.text}
          placeholder="写点什么，支持 **粗体**、`代码`、# 标题、- 列表"
          onInput={(e) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; updateCard(props.card.id, { text: e.currentTarget.value }); }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === "Escape") ta.blur(); e.stopPropagation(); }}
        />
      </Show>
    </Shell>
  );
}

// ---------- 图片 ----------

function ImageView(props: { card: ImageCard }) {
  return (
    <Shell card={props.card} class="image-card">
      <div class="img" onPointerDown={(e) => dragCard(e, props.card)}>
        <Show when={props.card.svg} fallback={<img src={props.card.src} alt={props.card.caption ?? ""} draggable={false} />}>
          <div class="svg" innerHTML={props.card.svg} />
        </Show>
      </div>
      <Show when={props.card.caption}><div class="caption">{props.card.caption}</div></Show>
    </Shell>
  );
}

// ---------- 网页 ----------

function LinkView(props: { card: LinkCard }) {
  const host = () => { try { return new URL(props.card.url).hostname.replace(/^www\./, ""); } catch { return props.card.url; } };
  return (
    <Shell card={props.card} class="link-card">
      <div class="link-body" onPointerDown={(e) => dragCard(e, props.card)}>
        <span class="favicon">{host()[0]?.toUpperCase()}</span>
        <div class="link-text">
          <div class="link-title">{props.card.title}</div>
          <Show when={props.card.desc}><div class="link-desc">{props.card.desc}</div></Show>
          <a href={props.card.url} target="_blank" rel="noreferrer" onPointerDown={(e) => e.stopPropagation()}>{host()} ↗</a>
        </div>
      </div>
    </Shell>
  );
}

// ---------- 分组 ----------

export function GroupView(props: { card: GroupCard }) {
  return (
    <Shell card={props.card} class="group-card" port={false}>
      <div class="group-label" onPointerDown={(e) => dragCard(e, props.card)}>{props.card.label}</div>
    </Shell>
  );
}

