import { For, Show, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import type { Card, Edge, EdgeKind, GroupCard } from "@codeboard/core";
import {
  state, setState, setCam, addCard, addEdge, updateEdge, uid, viewportCenter, removeSelected, fitAll, steps, flyToCard,
  placeFree, zoomAt, say,
} from "../store";
import { send } from "../host";
import { CardView, GroupView } from "./Cards";
import { rectOf, lineY, NORMAL, type Side, type Rect } from "./geom";

// ---------- 连线（拖出箭头） ----------

type LinkDraft = { from: { card: string; line?: number }; x: number; y: number };
const [draft, setDraft] = createSignal<LinkDraft | null>(null);
let canvasEl: HTMLDivElement | undefined;

function toWorld(clientX: number, clientY: number) {
  const r = canvasEl!.getBoundingClientRect();
  const cam = state.board.cam;
  return { x: (clientX - r.left - cam.x) / cam.z, y: (clientY - r.top - cam.y) / cam.z };
}

export function startLink(ev: PointerEvent, from: { card: string; line?: number }) {
  ev.stopPropagation();
  ev.preventDefault();
  setDraft({ from, ...toWorld(ev.clientX, ev.clientY) });
  document.body.classList.add("linking");
  const move = (e: PointerEvent) => setDraft((d) => d && { ...d, ...toWorld(e.clientX, e.clientY) });
  const up = (e: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.classList.remove("linking");
    const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-card]") as HTMLElement | null;
    const to = target?.dataset.card;
    const d = draft();
    setDraft(null);
    if (!d) return;
    if (to && to !== d.from.card) {
      const edge = addEdge({ from: d.from, to: { card: to }, kind: d.from.line ? "call" : "seq" });
      setState("selected", { kind: "edge", id: edge.id });
    } else if (!to) {
      // 拖到空白处：顺手建一张便签并连上
      const p = toWorld(e.clientX, e.clientY);
      const note = addCard({ id: uid("n"), type: "note", x: Math.round(p.x), y: Math.round(p.y - 30), w: 280, text: "" });
      addEdge({ from: d.from, to: { card: note.id }, kind: "data" });
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------- 箭头几何 ----------

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

function fromPoint(c: Card, line: number | undefined, toward: Rect): { p: [number, number]; side: Side } {
  const r = rectOf(c), tc = center(toward);
  if (line && c.type === "code" && !c.collapsed) {
    const y = lineY(c, line);
    // 目标在下方且靠左（缩进的下级）：从左边出；否则看目标在哪一侧
    const below = toward.y > r.y + r.h - 10;
    const right = below ? toward.x > r.x + r.w * 0.5 : tc.x > r.x + r.w - 40 || (tc.x > r.x + r.w / 2 && !(toward.x + toward.w < r.x));
    return right ? { p: [r.x + r.w, y], side: "r" } : { p: [r.x, y], side: "l" };
  }
  return sidePoint(r, tc);
}
function sidePoint(r: Rect, toward: { x: number; y: number }): { p: [number, number]; side: Side } {
  const c = center(r);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (Math.abs(dx) / (r.w / 2 + 1) > Math.abs(dy) / (r.h / 2 + 1))
    return dx > 0 ? { p: [r.x + r.w, c.y], side: "r" } : { p: [r.x, c.y], side: "l" };
  return dy > 0 ? { p: [c.x, r.y + r.h], side: "b" } : { p: [c.x, r.y], side: "t" };
}
function toPoint(r: Rect, from: [number, number], fromSide: Side): { p: [number, number]; side: Side } {
  // 从左侧出发、往下展开：像缩进的树一样从左边进入
  if (fromSide === "l" && from[1] < r.y - 10 && from[0] <= r.x + 10) return { p: [r.x, r.y + Math.min(r.h / 2, 20)], side: "l" };
  if (from[1] < r.y - 40 && from[0] > r.x - 260 && from[0] < r.x + r.w + 260) return { p: [r.x + Math.min(r.w / 2, 60), r.y], side: "t" };
  if (from[1] > r.y + r.h + 40 && from[0] > r.x - 260 && from[0] < r.x + r.w + 260) return { p: [r.x + Math.min(r.w / 2, 60), r.y + r.h], side: "b" };
  if (from[0] <= r.x) return { p: [r.x, r.y + Math.min(r.h / 2, 20)], side: "l" };
  return { p: [r.x + r.w, r.y + Math.min(r.h / 2, 20)], side: "r" };
}
function bez(p0: [number, number], s0: Side, p3: [number, number], s3: Side) {
  const dist = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const d = Math.max(30, Math.min(160, dist * 0.45));
  const c1: [number, number] = [p0[0] + NORMAL[s0][0] * d, p0[1] + NORMAL[s0][1] * d];
  const c2: [number, number] = [p3[0] + NORMAL[s3][0] * d, p3[1] + NORMAL[s3][1] * d];
  const at = (t: number) => {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p3[k]) as [number, number];
  };
  return { d: `M${p0[0]},${p0[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p3[0]},${p3[1]}`, mid: at(0.5) };
}
function edgeGeom(e: Edge) {
  const cards = state.board.cards;
  const a = cards.find((c) => c.id === e.from.card), b = cards.find((c) => c.id === e.to.card);
  if (!a || !b) return null;
  const rb = rectOf(b);
  const f = fromPoint(a, e.from.line, rb);
  const t = toPoint(rb, f.p, f.side);
  return bez(f.p, f.side, t.p, t.side);
}

const KIND_LABEL: Record<EdgeKind, string> = { call: "调用", seq: "然后", data: "数据", loop: "循环" };

function EdgeView(props: { edge: Edge }) {
  const g = createMemo(() => edgeGeom(props.edge));
  const selected = () => state.selected?.kind === "edge" && state.selected.id === props.edge.id;
  const dim = () => {
    if (state.present === null) return false;
    const cur = steps()[state.present]?.id;
    return props.edge.from.card !== cur && props.edge.to.card !== cur;
  };
  return (
    <Show when={g()}>
      <g class={`edge k-${props.edge.kind}`} classList={{ selected: selected(), dim: dim() }}>
        <path class="hit" d={g()!.d} onPointerDown={(e) => { e.stopPropagation(); setState("selected", { kind: "edge", id: props.edge.id }); }} />
        <path class="line" d={g()!.d} marker-end={`url(#arrow-${selected() ? "sel" : props.edge.kind})`} />
      </g>
    </Show>
  );
}

function EdgeLabel(props: { edge: Edge }) {
  const g = createMemo(() => edgeGeom(props.edge));
  const selected = () => state.selected?.kind === "edge" && state.selected.id === props.edge.id;
  return (
    <Show when={g() && (props.edge.label || selected())}>
      <div class={`edge-label k-${props.edge.kind}`} classList={{ selected: selected() }} style={{ left: `${g()!.mid[0]}px`, top: `${g()!.mid[1]}px` }}
        onPointerDown={(e) => { e.stopPropagation(); setState("selected", { kind: "edge", id: props.edge.id }); }}>
        <Show when={selected()} fallback={<span>{props.edge.label}</span>}>
          <input value={props.edge.label ?? ""} placeholder="标签，如 logits [B, V]" size={Math.max(14, (props.edge.label ?? "").length + 2)}
            onInput={(e) => updateEdge(props.edge.id, { label: e.currentTarget.value || undefined })}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }} />
          <div class="kinds">
            <For each={Object.keys(KIND_LABEL) as EdgeKind[]}>
              {(k) => <button classList={{ on: props.edge.kind === k }} onClick={() => updateEdge(props.edge.id, { kind: k })}>{KIND_LABEL[k]}</button>}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

// ---------- 画布 ----------

export function Canvas() {
  const cam = () => state.board.cam;
  const groups = () => state.board.cards.filter((c) => c.type === "group") as GroupCard[];
  const others = () => state.board.cards.filter((c) => c.type !== "group");
  const presentId = () => (state.present === null ? null : steps()[state.present]?.id ?? null);

  onMount(() => {
    const el = canvasEl!;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".dialog")) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // 触控板捏合在 Chromium 里也是 ctrl + wheel
        const r = el.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0085)), e.clientX - r.left, e.clientY - r.top);
      } else if (e.shiftKey && !e.deltaX) setCam({ x: cam().x - e.deltaY });
      else setCam({ x: cam().x - e.deltaX, y: cam().y - e.deltaY });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => el.removeEventListener("wheel", wheel));
  });

  const panStart = (ev: PointerEvent) => {
    if (ev.button !== 0 && ev.button !== 1) return;
    if ((ev.target as HTMLElement).closest(".card,.edge-label,.toolbar,.zoom")) return;
    setState("selected", null);
    const sx = ev.clientX, sy = ev.clientY, o = { ...cam() };
    canvasEl!.setPointerCapture(ev.pointerId);
    canvasEl!.classList.add("panning");
    const move = (e: PointerEvent) => setCam({ x: o.x + e.clientX - sx, y: o.y + e.clientY - sy });
    const up = () => {
      canvasEl!.removeEventListener("pointermove", move);
      canvasEl!.removeEventListener("pointerup", up);
      canvasEl!.classList.remove("panning");
    };
    canvasEl!.addEventListener("pointermove", move);
    canvasEl!.addEventListener("pointerup", up);
  };

  const dbl = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".card,.edge-label,.toolbar,.zoom")) return;
    const p = toWorld(e.clientX, e.clientY);
    addCard({ id: uid("n"), type: "note", x: Math.round(p.x - 20), y: Math.round(p.y - 20), w: 280, text: "" });
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f || !f.type.startsWith("image/")) return;
    const p = toWorld(e.clientX, e.clientY);
    readImage(f, p.x, p.y);
  };

  return (
    <div ref={canvasEl} class="canvas" classList={{ presenting: state.present !== null }}
      style={{ "background-position": `${cam().x}px ${cam().y}px`, "background-size": `${22 * cam().z}px ${22 * cam().z}px` }}
      onPointerDown={panStart} onDblClick={dbl} onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      <div class="world" style={{ transform: `translate(${cam().x}px, ${cam().y}px) scale(${cam().z})` }}>
        <For each={groups()}>{(g) => <GroupView card={g} />}</For>
        <svg class="edges" width="1" height="1">
          <defs>
            <For each={["call", "seq", "data", "loop", "sel"]}>
              {(k) => (
                <marker id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" class={`head h-${k}`} />
                </marker>
              )}
            </For>
          </defs>
          <For each={state.board.edges}>{(e) => <EdgeView edge={e} />}</For>
          <Show when={draft()}>
            {(d) => {
              const path = () => {
                const a = state.board.cards.find((c) => c.id === d().from.card);
                if (!a) return "";
                const f = fromPoint(a, d().from.line, { x: d().x, y: d().y, w: 1, h: 1 });
                return bez(f.p, f.side, [d().x, d().y], f.side === "r" ? "l" : f.side === "l" ? "r" : f.side === "b" ? "t" : "b").d;
              };
              return <path class="draft" d={path()} marker-end="url(#arrow-sel)" />;
            }}
          </Show>
        </svg>
        <For each={others()}>
          {(c) => <div class="card-slot" classList={{ dim: presentId() !== null && presentId() !== c.id }}><CardView card={c} /></div>}
        </For>
        <For each={state.board.edges}>{(e) => <EdgeLabel edge={e} />}</For>
      </div>
      <Show when={state.loaded && !state.board.cards.length}>
        <div class="empty">
          <h2>{state.board.name}</h2>
          <p>在编辑器里选中几行代码，右键选「添加到 CodeBoard」；或者把光标放在函数里，按 <kbd>Alt</kbd>+<kbd>B</kbd> 把整个函数放上来。双击画布可以写便签。</p>
        </div>
      </Show>
      <Toolbar />
      <Zoom />
    </div>
  );
}

export function readImage(f: File, x: number, y: number) {
  const r = new FileReader();
  r.onload = () => addCard({ id: uid("i"), type: "image", x: Math.round(x), y: Math.round(y), w: 420, src: String(r.result), caption: f.name });
  r.readAsDataURL(f);
}

export function addLinkCard(url: string, p: { x: number; y: number }) {
  let title = url;
  try { const u = new URL(url); title = (u.hostname + u.pathname).replace(/^www\./, "").replace(/\/$/, ""); } catch { /* 原样保留 */ }
  addCard({ id: uid("l"), type: "link", x: p.x, y: p.y, w: 340, url, title });
}

function Toolbar() {
  let file!: HTMLInputElement;
  const [linkOpen, setLinkOpen] = createSignal(false);
  const at = (w: number) => { const c = viewportCenter(); return placeFree(c.x - w / 2, c.y - 60, w); };
  return (
    <div class="toolbar" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
      <button title="便签（N）" onClick={() => addCard({ id: uid("n"), type: "note", ...at(280), w: 280, text: "" })}><Icon d="M5 4h14v11l-5 5H5z M14 20v-5h5" /><span>便签</span></button>
      <button title="搜一个函数放到白板上（Alt+B 添加光标所在函数）" onClick={() => send({ type: "pickCode" })}><Icon d="M8 7l-5 5 5 5 M16 7l5 5-5 5" /><span>代码</span></button>
      <button title="分组框" onClick={() => { const c = viewportCenter(); addCard({ id: uid("g"), type: "group", x: Math.round(c.x - 360), y: Math.round(c.y - 200), w: 720, h: 400, label: "新的阶段" }); }}><Icon d="M4 4h6M14 4h6v6M20 14v6h-6M10 20H4v-6M4 10V4" /><span>分组</span></button>
      <button title="图片，也可以直接拖文件进来或粘贴" onClick={() => file.click()}><Icon d="M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4" /><span>图片</span></button>
      <button title="网页链接，也可以直接粘贴网址" onClick={() => setLinkOpen(!linkOpen())}><Icon d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1 M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" /><span>网页</span></button>
      <input type="file" accept="image/*" hidden ref={file} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) { const p = at(420); readImage(f, p.x, p.y); } e.currentTarget.value = ""; }} />
      <Show when={linkOpen()}>
        <form class="link-form" onSubmit={(e) => {
          e.preventDefault();
          const v = (e.currentTarget.elements.namedItem("url") as HTMLInputElement).value.trim();
          if (v) addLinkCard(v, at(340));
          setLinkOpen(false);
        }}>
          <input id="link-url" name="url" placeholder="https://…" ref={(el) => queueMicrotask(() => el.focus())} onKeyDown={(e) => e.stopPropagation()} />
          <button type="submit">添加</button>
        </form>
      </Show>
    </div>
  );
}

function Zoom() {
  const z = () => Math.round(state.board.cam.z * 100);
  return (
    <div class="zoom" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
      <button title="缩小（-）" onClick={() => zoomAt(1 / 1.2)}>−</button>
      <button class="pct" title="回到 100%（0）" onClick={() => zoomAt(1 / state.board.cam.z)}>{z()}%</button>
      <button title="放大（+）" onClick={() => zoomAt(1.2)}>+</button>
      <button title="显示全部（F）" onClick={fitAll}><Icon d="M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5" /></button>
    </div>
  );
}

export function Icon(props: { d: string }) {
  return <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={props.d} /></svg>;
}

// ---------- 键盘与粘贴 ----------

export function installKeys() {
  const key = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input,textarea,[contenteditable]")) return;
    if (state.present !== null) {
      const n = steps().length;
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); present(Math.min(n - 1, state.present + 1)); }
      else if (e.key === "ArrowLeft") present(Math.max(0, state.present - 1));
      else if (e.key === "Escape" || e.key.toLowerCase() === "p") stopPresent();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    else if (e.key === "Escape") setState({ selected: null, diff: null });
    else if (e.key.toLowerCase() === "n") { e.preventDefault(); const c = viewportCenter(); addCard({ id: uid("n"), ...placeFree(c.x - 140, c.y - 40, 280), w: 280, type: "note", text: "" }); }
    else if (e.key.toLowerCase() === "f") fitAll();
    else if (e.key.toLowerCase() === "p") startPresent();
    else if (e.key === "+" || e.key === "=") zoomAt(1.2);
    else if (e.key === "-") zoomAt(1 / 1.2);
    else if (e.key === "0") zoomAt(1 / state.board.cam.z);
  };
  const paste = (e: ClipboardEvent) => {
    if ((e.target as HTMLElement).closest("input,textarea")) return;
    const text = e.clipboardData?.getData("text/plain")?.trim();
    const img = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
    const c = viewportCenter();
    if (img) readImage(img, c.x - 200, c.y - 120);
    else if (text && /^https?:\/\/\S+$/.test(text)) addLinkCard(text, placeFree(c.x - 170, c.y - 40, 340));
    else if (text) addCard({ id: uid("n"), type: "note", ...placeFree(c.x - 160, c.y - 40, 320), w: 320, text });
  };
  window.addEventListener("keydown", key);
  window.addEventListener("paste", paste);
}

export function startPresent() {
  if (!steps().length) return say("这张白板还没有编号的卡片；从带编号的卡片里展开调用会自动编号");
  setState("selected", null);
  present(0);
}
export function stopPresent() {
  setState("present", null);
  fitAll();
}
export function present(i: number) {
  setState("present", i);
  const c = steps()[i];
  if (c) flyToCard(c.id, 1.05);
  setState("selected", null);
}
