import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { cardTitle, type Card, type CodeCard, type NoteCard, type ImageCard, type LinkCard, type GroupCard } from "@codeboard/core";
import { state, setState, setSizes, updateCard, bringToFront, steps } from "../store";
import { send } from "../host";
import { LH, rectOf } from "./geom";
import { startLink } from "./Canvas";

// ---------- 拖动 ----------

function dragCard(ev: PointerEvent, c: Card) {
  if (ev.button !== 0) return;
  if ((ev.target as HTMLElement).closest("button,a,input,textarea")) return;
  ev.stopPropagation();
  ev.preventDefault();
  setState("selected", { kind: "card", id: c.id });
  bringToFront(c.id);
  const z = state.board.cam.z;
  const sx = ev.clientX, sy = ev.clientY;
  // 拖分组时，中心落在框内的卡片一起走
  const riders = c.type === "group"
    ? state.board.cards.filter((o) => {
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
  ev.preventDefault();
  const z = state.board.cam.z;
  const sx = ev.clientX, sy = ev.clientY, ow = rectOf(c).w, oh = c.type === "group" ? c.h : 0;
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
    onCleanup(() => ro.disconnect());
  });
  const selected = () => state.selected?.kind === "card" && state.selected.id === props.card.id;
  const current = () => state.present !== null && steps()[state.present]?.id === props.card.id;
  return (
    <div
      ref={el}
      data-card={props.card.id}
      class={`card ${props.class}`}
      classList={{ selected: selected(), current: current() }}
      style={{ left: `${props.card.x}px`, top: `${props.card.y}px`, width: `${props.card.w}px`, ...(props.card.type === "group" ? { height: `${props.card.h}px` } : {}) }}
      onPointerDown={(e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest("button,a,textarea,.port")) setState("selected", { kind: "card", id: props.card.id });
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function CodeView(props: { card: CodeCard }) {
  const c = () => props.card;
  const view = () => state.views[c().id];
  const lines = createMemo(() => view()?.html ?? c().snapshot.map(esc));
  const sync = () => view()?.sync ?? { state: "unknown" as const };
  const [hoverLine, setHoverLine] = createSignal<number | null>(null);

  const onLineClick = (e: MouseEvent, line: number) => {
    const x = (e.target as HTMLElement).closest("[data-call]") as HTMLElement | null;
    e.stopPropagation();
    if (x) {
      send({ type: "expand", id: c().id, line, name: x.dataset.call!, recv: x.dataset.recv || undefined, col: Number(x.dataset.col ?? 0) });
    } else send({ type: "openCode", id: c().id, line });
  };
  const toggleHl = (line: number) => {
    const hl = c().hl.includes(line) ? c().hl.filter((l) => l !== line) : [...c().hl, line];
    updateCard(c().id, { hl });
  };
  const chip = () => {
    const s = sync().state;
    if (s === "changed") { const v = sync() as Extract<ReturnType<typeof sync>, { state: "changed" }>; return `源码有新版本（+${v.added} −${v.removed}），点开看 diff`; }
    if (s === "lost") return "在当前代码里找不到这段了";
    if (s === "unknown") return "读不到这个文件";
    return c().dirty ? "建卡时这段代码还没提交" : "和当前代码一致";
  };

  return (
    <Shell card={c()} class="code-card">
      <div class="card-head" onPointerDown={(e) => dragCard(e, c())}>
        <Show when={c().step}><span class="step">{c().step}</span></Show>
        <span class="title">{cardTitle(c())}</span>
        <span class="path">{c().path}</span>
        <button class={`rev s-${sync().state}`} title={chip()}
          onClick={(e) => { e.stopPropagation(); if (sync().state === "changed") send({ type: "requestDiff", id: c().id }); }}>
          <i />{c().commit ? c().commit!.slice(0, 7) : "未入库"}{c().dirty ? "*" : ""}
          <Show when={sync().state === "changed"}><em>有新版本</em></Show>
        </button>
        <div class="head-actions">
          <button title="在编辑器中打开" onClick={(e) => { e.stopPropagation(); send({ type: "openCode", id: c().id }); }}>打开</button>
          <button title={c().collapsed ? "展开" : "折叠"} onClick={(e) => { e.stopPropagation(); updateCard(c().id, { collapsed: !c().collapsed }); }}>{c().collapsed ? "展开" : "折叠"}</button>
        </div>
      </div>
      <Show when={!c().collapsed} fallback={<div class="io">{c().io ?? `${c().end - c().start + 1} 行 · 展开查看`}</div>}>
        <div class="code" style={{ "--lh": `${LH}px` }}>
          <For each={lines()}>
            {(html, i) => {
              const ln = () => c().start + i();
              return (
                <div class="code-line" classList={{ hl: c().hl.includes(ln()) }}
                  onPointerEnter={() => setHoverLine(ln())} onPointerLeave={() => setHoverLine(null)}>
                  <span class="ln" title="点击高亮这一行" onClick={(e) => { e.stopPropagation(); toggleHl(ln()); }}>{ln()}</span>
                  <span class="src" innerHTML={html || " "} onClick={(e) => onLineClick(e, ln())} title="点击在编辑器中定位；点下划线的调用可以展开" />
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
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
  const out: string[] = [];
  let list = false;
  for (const raw of text.split("\n")) {
    const l = raw.trimEnd();
    if (/^- /.test(l)) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(l.slice(2))}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    const h = /^#{1,3} (.*)$/.exec(l);
    if (h) out.push(`<h3>${inline(h[1])}</h3>`);
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
      <Show when={editing()}
        fallback={<div class="md" onPointerDown={(e) => dragCard(e, props.card)} onDblClick={() => setEditing(true)} innerHTML={md(props.card.text)} />}>
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

// ---------- 图片、网页、分组 ----------

function ImageView(props: { card: ImageCard }) {
  return (
    <Shell card={props.card} class="image-card">
      <div class="img" onPointerDown={(e) => dragCard(e, props.card)}>
        <img src={props.card.src} alt={props.card.caption ?? ""} draggable={false} />
      </div>
      <Show when={props.card.caption}><div class="caption">{props.card.caption}</div></Show>
    </Shell>
  );
}

function LinkView(props: { card: LinkCard }) {
  const host = () => { try { return new URL(props.card.url).hostname.replace(/^www\./, ""); } catch { return props.card.url; } };
  return (
    <Shell card={props.card} class="link-card">
      <div class="link-body" onPointerDown={(e) => dragCard(e, props.card)}>
        <span class="favicon">{host()[0]?.toUpperCase()}</span>
        <div class="link-text">
          <div class="link-title">{props.card.title}</div>
          <Show when={props.card.desc}><div class="link-desc">{props.card.desc}</div></Show>
          <button class="link-open" onClick={(e) => { e.stopPropagation(); send({ type: "openLink", url: props.card.url }); }}>{host()} ↗</button>
        </div>
      </div>
    </Shell>
  );
}

export function GroupView(props: { card: GroupCard }) {
  const [editing, setEditing] = createSignal(false);
  return (
    <Shell card={props.card} class="group-card" port={false}>
      <Show when={editing()} fallback={
        <div class="group-label" title="拖动移动整组，双击改名" onPointerDown={(e) => dragCard(e, props.card)} onDblClick={() => setEditing(true)}>{props.card.label}</div>
      }>
        <input class="group-label" value={props.card.label} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }}
          onBlur={(e) => { updateCard(props.card.id, { label: e.currentTarget.value.trim() || props.card.label }); setEditing(false); }} />
      </Show>
    </Shell>
  );
}
