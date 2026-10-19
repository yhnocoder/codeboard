// 浮层：Sidenote、定义预览、加 Sidenote、版本 diff、多个定义选择、commit 列表、变量、只读源码。
import { keepKey } from "./editkeys";
import { For, Show, Switch, Match, createSignal, createMemo, createEffect, onCleanup } from "solid-js";
import { unwrap } from "solid-js/store";
import {
  alignRows, wordDiff, cardTitle, varKey, varText, versionLabel, baseName, isCode, segOf, findCard, langLabel, LANGS, guessLang,
  RPC_MECHS, threeWay, upstreamSegs, activeOf, viewKey, UPSTREAM,
  type GraphMark, type Sidenote, type Segment, type PeekDef, type SearchItem, type Var, type Anchor,
} from "@codeboard/core";
import { state, cardById, toast, mutate, select, flows, shared, sharedOn } from "../state/store";
import { Glyph } from "../stickers/glyphs";
import { cam } from "../state/camera";
import { pops, closePop, pinPop, updatePop, type PopInst, type Pop } from "../state/pop";
import { setConnectFrom } from "../state/ui";
import { markHtml } from "../cards/CompareBody";
import { Icon } from "./icons";
import { autoUpdate } from "@floating-ui/dom";
import { place, virtual } from "./place";
import { ask, send } from "../host";
import * as A from "../actions";
import { MdStatic } from "./Md";
import { Editable } from "./Editable";
import { editing, setEditing } from "../state/ui";
import { openMenu, type Item } from "./Menu";

export function Popovers() {
  return <>
    {/* library 调用的样式跟着 Study Scope 变（这里顺带挂上，免得改 App） */}
    <style>{A.libCallCss()}</style>
    <For each={pops()}>{(p) => <PopFrame inst={p} />}</For>
  </>;
}

function PopFrame(p: { inst: PopInst }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const [anchor, setAnchor] = createSignal<Element | undefined>();
  let last: { x: number; y: number } | undefined, n = 0;
  const reposition = () => {
    const at = p.inst.at;
    // 锚点元素被重画掉了（比如删了一条旁注，标记换成新的）：Sidenote 弹窗改挂到还剩的那条的标记上；找不到就停在原地
    if (at.el && !at.el.isConnected && p.inst.pop.kind === "notes") {
      const ids = p.inst.pop.ids.filter((id) => state.board.sidenotes.some((n) => n.id === id));
      const mk = [...document.querySelectorAll("[data-notes]")].find((m) => (m as HTMLElement).dataset.notes!.split(",").some((id) => ids.includes(id)));
      if (mk) { at.el = mk; setAnchor(mk); }
    }
    if (at.el && !at.el.isConnected && last) return;
    const k = ++n;
    // 贴着锚点元素：下方 / 右侧 / 上方，放不下翻到另一边；没有元素就放在点 (x, y)
    const ref = at.el?.isConnected ? at.el : virtual({ x: at.x ?? 0, y: at.y ?? 0 });
    const r = at.el?.isConnected && at.prefer === "right" ? place(el, ref, "right-start", { gap: { mainAxis: 8, crossAxis: -6 } })
      : place(el, ref, at.prefer === "above" ? "top-start" : "bottom-start", { gap: at.el?.isConnected ? 6 : 0 });
    void r.then((r) => { if (k === n) setPos(last = { x: r.x, y: r.y }); });
  };
  // 镜头动时跟着元素走；弹窗自己或锚点变大小、窗口变大小时重新放（autoUpdate）
  createEffect(() => setAnchor(p.inst.at.el));
  createEffect(() => {
    const a = anchor();
    onCleanup(autoUpdate(a?.isConnected ? a : virtual({ x: 0, y: 0 }), el, reposition, { layoutShift: false }));
  });
  createEffect(() => { void cam.x; void cam.y; void cam.z; reposition(); });
  const k = () => p.inst.pop.kind;
  return (
    <div ref={el} class={`pop open k-${k()}`} classList={{ pinned: p.inst.pinned }} data-pop={p.inst.id} style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
      onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}
      onPointerEnter={() => { A.cancelHideNotes(); A.cancelHidePeek(); }}
      onPointerLeave={() => { if (p.inst.pinned) return; if (k() === "notes") A.scheduleHideNotes(); if (k() === "peek") A.scheduleHidePeek(); }}>
      <Switch>
        <Match when={k() === "notes"}><NotesPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "notes" }>} /></Match>
        <Match when={k() === "peek"}><PeekPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "peek" }>} /></Match>
        <Match when={k() === "addNote"}><AddNotePop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "addNote" }>} /></Match>
        <Match when={k() === "diff"}><DiffPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "diff" }>} /></Match>
        <Match when={k() === "pick"}><PickPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "pick" }>} /></Match>
        <Match when={k() === "commits"}><CommitsPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "commits" }>} /></Match>
        <Match when={k() === "vars"}><VarsPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "vars" }>} /></Match>
        <Match when={k() === "mark"}><MarkPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "mark" }>} /></Match>
        <Match when={k() === "boards"}><BoardsPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "boards" }>} /></Match>
        <Match when={k() === "impls"}><ImplsPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "impls" }>} /></Match>
        <Match when={k() === "vals"}><ValsPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "vals" }>} /></Match>
        <Match when={k() === "names"}><NamesPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "names" }>} /></Match>
        <Match when={k() === "rpc"}><RpcPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "rpc" }>} /></Match>
        <Match when={k() === "three"}><ThreePop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "three" }>} /></Match>
        <Match when={k() === "question"}><QuestionPop inst={p.inst} pop={p.inst.pop as Extract<Pop, { kind: "question" }>} /></Match>
      </Switch>
    </div>
  );
}

function Head(p: { title: any; inst: PopInst; right?: any }) {
  return (
    <div class="ph">
      <span class="pt">{p.title}</span><span class="grow" />{p.right}
      <Show when={p.inst.pinned}><span class="pinned">Pinned</span></Show>
      <button class="ib" aria-label="Close" onClick={() => closePop(p.inst.id)}><Icon name="close" size={13} /></button>
    </div>
  );
}

/** 一小段只读代码（带行号）；rows = 每行的行号（不连续时） */
function Code(p: { start: number; html: string[]; hl?: number; rows?: number[] }) {
  const no = (i: number) => p.rows?.[i] ?? p.start + i;
  return (
    <div class="pcode"><div class="pc-in">
      <For each={p.html}>{(h, i) => <div class="pl" classList={{ hl: p.hl === no(i()), jump: i() > 0 && !!p.rows && no(i()) !== no(i() - 1) + 1 }}><span class="no">{no(i())}</span><span class="t" innerHTML={h || "​"} /></div>}</For>
    </div></div>
  );
}

// ---------- 问题（线框 06） ----------

function QuestionPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "question" }> }) {
  const s = () => state.board.stickers.find((k) => k.id === p.pop.sticker);
  createEffect(() => { if (!s()) closePop(p.inst.id); });
  const q = () => s()?.q;
  const where = () => { const at = s()?.at; return at?.kind === "line" ? ` · line ${at.line}` : ""; };
  const answer = () => { const id = q()?.answer; const c = id ? cardById(id)?.card : undefined; return c && { id: c.id, title: cardTitle(c, state.board), kind: c.kind }; };
  const on = () => editing()?.kind === "question" && editing()?.id === p.pop.sticker;
  return (
    <Show when={s()}>
      <Head inst={p.inst} title={<><b>{q()?.done ? "Answered" : "Question"}</b>{where()}</>} />
      <div class="qbody" onDblClick={() => setEditing({ kind: "question", id: p.pop.sticker })}>
        <Editable class="qtext" kind="question" id={p.pop.sticker} value={q()?.md ?? ""} multiline md placeholder="What don't you understand here? Markdown and $math$ work"
          onCommit={(v) => A.setQuestionText(p.pop.sticker, v)} />
      </div>
      <Show when={answer()}>{(a) => (
        <div class="qans">Answered by {a().kind === "note" ? "Note" : "card"} <button class="tlink" onClick={() => { A.selectCard(a().id); A.revealCard(a().id); }}>“{a().title}”</button></div>
      )}</Show>
      <div class="qacts">
        <Show when={!on()} fallback={<span class="qhint">{A.K.mod}↵ or click outside to save</span>}>
          <button class="tbtn" onClick={() => setEditing({ kind: "question", id: p.pop.sticker })}>Edit</button>
        </Show>
        <span class="qbtns">
          <Show when={q()?.done} fallback={<button class="tbtn pri" onClick={() => A.setAnswered(p.pop.sticker, true)}>Mark Answered</button>}>
            <button class="tbtn" onClick={() => A.setAnswered(p.pop.sticker, false)}>Reopen</button>
          </Show>
          <button class="tbtn" onClick={() => A.linkAnswer(p.pop.sticker)}>Link Answer…</button>
        </span>
      </div>
    </Show>
  );
}

// ---------- Sidenote 弹窗 ----------

function NotesPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "notes" }> }) {
  const notes = () => p.pop.ids.map((id) => state.board.sidenotes.find((n) => n.id === id)).filter(Boolean) as Sidenote[];
  const [cur, setCur] = createSignal(p.pop.sel ?? p.pop.ids[0]);
  createEffect(() => { if (!notes().length) closePop(p.inst.id); });
  const curNote = () => notes().find((n) => n.id === cur()) ?? notes()[0];
  return (
    <>
      <Head title={`${p.pop.title} (${notes().length})`} inst={p.inst} />
      <div class="sn-list">
        <For each={notes()}>{(n) => <div class="sn-item" classList={{ on: n.id === curNote()?.id }} onPointerDown={() => setCur(n.id)} onContextMenu={(e) => { e.preventDefault(); setCur(n.id); pinPop(p.inst.id); noteMenu(n, e.clientX, e.clientY); }}><NoteItem n={n} /></div>}</For>
      </div>
      <div class="sn-acts">
        <button class="tbtn" onClick={() => { const n = notes()[0]; if (n) { closePop(p.inst.id); A.openAddNote(n.at); } }}>+ Add</button>
        <Show when={curNote()?.kind === "text"}>
          <button class="tbtn" onClick={() => editText(curNote()!)}>Edit</button>
          <button class="tbtn" classList={{ on: !!(curNote() as any)?.alwaysShow }} onClick={() => A.updateSidenote(curNote()!.id, (n) => { if (n.kind === "text") n.alwaysShow = !n.alwaysShow || undefined; })}>Always Show</button>
        </Show>
        <Show when={curNote() && curNote()!.kind !== "card"}><button class="tbtn" onClick={() => A.placeSidenote(curNote()!.id)}>Place on Board</button></Show>
        <Show when={curNote() && curNote()!.kind !== "card" && sharedOn(curNote()!.at.card) > 1}>
          <button class="tbtn" classList={{ on: !!curNote()!.boardOnly }} data-tip="Keep this sidenote on this board only; otherwise it shows on every board with the card" onClick={() => A.toggleBoardOnly(curNote()!.id)}>Board-only</button>
        </Show>
        <Show when={curNote() && hasVariants(curNote()!.at.card)}>
          <button class="tbtn" classList={{ on: !!curNote()!.variant }} data-tip="Show this sidenote only on this variant of the card" onClick={() => A.toggleVariantOnly(curNote()!.id)}>Only in This Variant</button>
        </Show>
        <span class="grow" />
        <button class="ib" aria-label="Delete Sidenote" data-tip="Delete Sidenote" onClick={() => A.deleteSidenote(curNote()!.id)}><Icon name="trash" size={13} /></button>
      </div>
    </>
  );
}

function NoteItem(p: { n: Sidenote }) {
  const n = () => p.n;
  return (
    <>
      <Switch>
        <Match when={n().kind === "code"}>{(() => {
          const c = () => (n() as Extract<Sidenote, { kind: "code" }>).code;
          const v = () => state.views[c().id];
          return <>
            <div class="sn-head"><b>{c().symbol?.qual ?? `${baseName(c().path)} ${c().start}–${c().end}`}</b><span>· {baseName(c().path)}:{c().start}</span><span class="grow" /><span class="rev sm">{versionLabel(c().version)}</span></div>
            <Code start={c().start} html={v()?.html ?? c().text.map(escH)} />
          </>;
        })()}</Match>
        <Match when={n().kind === "paste"}>{(() => {
          const q = () => n() as Extract<Sidenote, { kind: "paste" }>;
          return <>
            <div class="sn-head"><b>Paste</b><span>· {langLabel(q().lang)}</span><Show when={q().url}><a class="lnk" onClick={() => A.openLink(q().url!)}>{q().url}</a></Show></div>
            <Code start={1} html={q().text.split("\n").map(escH)} />
          </>;
        })()}</Match>
        <Match when={n().kind === "text"}>
          <Show when={snEditing() === n().id} fallback={<MdStatic class="sn-text" tip="Double-click to edit" src={(n() as any).md} onDblClick={() => editText(n())}
            onToggle={(v) => A.updateSidenote(n().id, (k) => { if (k.kind === "text") k.md = v; })} />}>
            <SidenoteEditor n={n() as Extract<Sidenote, { kind: "text" }>} />
          </Show>
        </Match>
        <Match when={n().kind === "link"}>
          <div class="sn-head"><b>Link</b></div>
          <div class="sn-text"><a class="lnk" onClick={() => A.openLink((n() as any).url)}>{(n() as any).title || (n() as any).url}</a></div>
        </Match>
        <Match when={n().kind === "card"}>{(() => {
          const t = () => cardById((n() as any).card)?.card;
          return <>
            <div class="sn-head"><b>Card · {t() ? cardTitle(t()!) : "deleted"}</b><span class="grow" /><Show when={t()}><button class="tbtn" onClick={() => A.revealCard((n() as any).card)}>Go to Card</button></Show></div>
            <Show when={t() && isCode(t()!)}>{(() => { const s = (t() as any).segments[0]; const v = state.views[s.id]; return <Code start={s.start} html={(v?.html ?? s.text.map(escH)).slice(0, 12)} />; })()}</Show>
          </>;
        })()}</Match>
      </Switch>
      <Show when={n().why}><div class="sn-why">{n().why}</div></Show>
      <Show when={n().lineRemoved}><div class="sn-why warn">Line removed in the new version · attached to the whole card</div></Show>
      <Show when={n().review}><div class="sn-why review"><span>Line changed in {n().review}, check it</span><button class="tbtn" onClick={() => A.markReviewed(n().id)}>Mark Reviewed</button></div></Show>
      <Show when={n().boardOnly && sharedOn(n().at.card) > 1}><div class="sn-tag">Board-only · not shown on the other boards</div></Show>
      <Show when={n().variant}><div class="sn-tag">Only in variant {A.variantName(n().at.card, n().variant!) ?? ""}</div></Show>
    </>
  );
}
/** Sidenote 右键：Board-only（共享卡上才有）、Place on Board、看过了、删除 */
const hasVariants = (id: string) => { const c = cardById(id)?.card; return isCode(c) && !!c.variants?.length; };
function noteMenu(n: Sidenote, x: number, y: number) {
  const linked = n.kind !== "card" && sharedOn(n.at.card) > 1;
  openMenu([
    ...(n.kind === "text" ? [{ label: "Edit", run: () => editText(n) } as Item] : []),
    ...(n.kind !== "card" ? [{ label: "Place on Board", run: () => A.placeSidenote(n.id) } as Item] : []),
    ...(linked ? [{ label: "Board-only", checked: !!n.boardOnly, hint: "Keep this sidenote on this board only; otherwise every board with the card shows it", run: () => A.toggleBoardOnly(n.id) } as Item] : []),
    ...(n.review ? [{ label: "Mark Reviewed", run: () => A.markReviewed(n.id) } as Item] : []),
    ...(hasVariants(n.at.card) ? [{ label: "Only in This Variant", checked: !!n.variant, hint: n.variant ? `Only on ${A.variantName(n.at.card, n.variant) ?? "one variant"}` : "Show this sidenote only on the variant shown now", run: () => A.toggleVariantOnly(n.id) } as Item] : []),
    null,
    { label: "Delete Sidenote", danger: true, run: () => A.deleteSidenote(n.id) },
  ], x, y);
}
const escH = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// 旁注原地编辑（#37）：多行、自动增高，和 Note 卡一样是 Markdown + 公式，下面实时预览。
// 和 Note、问题的编辑一样，Esc、⌘↵、点到外面都是保存（Cancel 才是放弃）。字删光了保存就是删掉这条：Text sidenote 就是那段字，加的时候也不让加空的
const [snEditing, setSnEditing] = createSignal<string | null>(null);
function editText(n: Sidenote) {
  if (n.kind !== "text") return;
  for (const q of pops()) if (q.pop.kind === "notes" && q.pop.ids.includes(n.id)) pinPop(q.id);
  setSnEditing(n.id);
}
function SidenoteEditor(p: { n: Extract<Sidenote, { kind: "text" }> }) {
  let box!: HTMLDivElement;
  const [v, setV] = createSignal(p.n.md);
  const grow = (el: HTMLTextAreaElement) => { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    setSnEditing(null);
    const t = v().trim();
    if (!save || t === p.n.md) return;
    if (t) A.updateSidenote(p.n.id, (k) => { if (k.kind === "text") k.md = t; });
    else A.deleteSidenote(p.n.id);
  };
  onCleanup(() => finish(true)); // 弹窗被关掉了（点了白板）
  return (
    <div ref={box} class="sn-edit" onPointerDown={(e) => e.stopPropagation()}>
      <textarea spellcheck={false} value={v()} ref={(el) => queueMicrotask(() => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); grow(el); })}
        onInput={(e) => { setV(e.currentTarget.value); grow(e.currentTarget); }}
        onBlur={(e) => { if (!(e.relatedTarget instanceof Node && box.contains(e.relatedTarget))) finish(true); }}
        onKeyDown={(e) => { keepKey(e); if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); finish(true); } }} />
      <Show when={v().trim()}><MdStatic class="sn-text sn-prev" src={v()} /></Show>
      {/* 按钮不拿焦点：点的时候字框不失焦 */}
      <div class="sn-eacts" onMouseDown={(e) => e.preventDefault()}><span>Markdown and $math$ · {A.K.mod}↵ or click outside to save</span><span class="grow" /><button class="tbtn" onClick={() => finish(false)}>Cancel</button><button class="tbtn pri" onClick={() => finish(true)}>Save</button></div>
    </div>
  );
}

// ---------- 定义预览 ----------

function PeekPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "peek" }> }) {
  const d = () => p.pop.data;
  const def = () => (d() && "seg" in d()! ? (d() as PeekDef) : null);
  const lib = () => { const l = def()?.lib; return l && !state.host.settings.studyScope.includes(l) ? l : ""; };
  const pin = () => {
    const x = def();
    if (!x) return;
    const c = cardById(p.pop.card)?.card;
    const at: Anchor = { card: p.pop.card, seg: p.pop.seg, lines: [p.pop.line, p.pop.line] };
    if (!c) return;
    // Follow 跟过的中间步骤（如 get_context = context._default_context.get_context）按顺序一起放进旁注，最后是最终定义
    const steps = [...(p.pop.trail ?? []), x];
    const segs = steps.map((k, i) => ({ ...structuredClone(unwrap(k.seg)), id: `${crypto.randomUUID?.() ?? Date.now().toString(36)}-${i}` }));
    A.addSidenotes(segs.map((code) => ({ at, kind: "code", code }) as any));
    // 展示数据用定义预览里那几行（段的 id 换了，重新要一次）
    A.requestViews(segs);
    toast(steps.length > 1 ? `Pinned ${steps.length} steps as Sidenotes` : "Pinned as Sidenote");
    closePop(p.inst.id);
  };
  const place = () => {
    const x = def();
    if (!x) return;
    const r = A.hostRect(p.pop.card)!;
    const id = `c${Date.now().toString(36)}`;
    const seg = { ...structuredClone(x.seg) };
    A.addCards([{ card: { id, kind: "code", segments: [seg] }, views: {}, w: 480 }], { at: { x: r.x + r.w + 48, y: r.y } });
    A.requestViews([seg]);
    A.addLink({ card: p.pop.card, seg: p.pop.seg, line: p.pop.line }, { card: id });
    closePop(p.inst.id);
  };
  return (
    <>
      <Show when={def()} fallback={
        <Show when={d()} fallback={<div class="empty">Looking up <code>{p.pop.word}</code>…</div>}>
          <Show when={"pick" in (d() as any)} fallback={
            <>
              <Head title={<>No definition found · <code>{p.pop.word}</code></>} inst={p.inst} />
              <div class="empty">The language server has no definition for this name (setattr, dispatch by string, or no Python extension).</div>
              <div class="sn-acts"><button class="tbtn" onClick={() => { closePop(p.inst.id); A.searchWorkspace(p.pop.word); }}>Search Workspace</button></div>
            </>}>
            <Head title={<>{(d() as any).pick.length} definitions · <code>{p.pop.word}</code></>} inst={p.inst} />
            <For each={(d() as any).pick as PeekDef[]}>{(x) => <button class="cand" onClick={() => updatePop(p.inst.id, (q) => ({ ...(q as any), data: x }))}><span class="lb">{x.path}:{x.line}</span></button>}</For>
          </Show>
        </Show>
      }>
        <Head title={<>Definition · {def()!.title ?? `${baseName(def()!.path)}:${def()!.line}`}</>} inst={p.inst}
          right={lib() ? <span class="lib-tag" data-tip={`Library code · ${lib()}`}>library</span> : <span class="src-tag">{def()!.seg.version.kind === "git" && def()!.kind !== "module" ? "at HEAD" : ""}</span>} />
        <Show when={def()!.dispatch}>{(dp) => (
          <div class="pk-disp"><span class="disp-tag">Dynamic dispatch</span> {dp().n} implementation{dp().n > 1 ? "s" : ""} · Static type: <code>{dp().base}</code>{dp().abstract ? " (abstract)" : ""}<span class="grow" /><small>Click the call to choose</small></div>
        )}</Show>
        <Show when={def()!.sig || def()!.doc}>
          <div class="pk-top">
            <Show when={def()!.sig}><div class="pk-sig" innerHTML={def()!.sigHtml ?? escH(def()!.sig!)} /></Show>
            <Show when={def()!.doc}><MdStatic class="pk-doc" src={def()!.doc!} /></Show>
          </div>
        </Show>
        <Show when={def()!.kind !== "module" && def()!.html.length}>
          <Show when={def()!.head}><div class="pk-head">{def()!.head}</div></Show>
          <Code start={def()!.start} html={def()!.html} hl={def()!.line} rows={def()!.rows} />
          <Show when={def()!.more}><div class="pk-more">⋯ {def()!.more} more line{def()!.more! > 1 ? "s" : ""}</div></Show>
        </Show>
        <Show when={def()!.follow}>
          <div class="follow">↳ <code>{def()!.follow!.label}</code><span class="grow" /><button class="tbtn" onClick={() => {
            const f = def()!.follow!;
            const prev = def()!;
            updatePop(p.inst.id, (q) => ({ ...(q as any), trail: [...((q as any).trail ?? []), prev], data: undefined }));
            ask("peek", { seg: structuredClone(unwrap(def()!.seg)), line: f.line, col: f.col, word: f.label.split(".").pop()!, at: { path: f.path, line: f.line, col: f.col } })
              .then((r) => updatePop(p.inst.id, (q) => ({ ...(q as any), data: r ?? { none: "No definition found", word: f.label } })))
              .catch(() => updatePop(p.inst.id, (q) => ({ ...(q as any), data: { none: "No definition found", word: f.label } })));
          }}>Follow</button></div>
        </Show>
        <div class="sn-acts">
          <Show when={def()!.kind !== "module"}>
            <button class="tbtn" onClick={pin}>Pin as Sidenote</button>
            <button class="tbtn" onClick={place}>Place on Board</button>
          </Show>
          <button class="tbtn" onClick={() => { send({ type: "openPath", path: def()!.path, line: def()!.line }); }}>Open in Editor</button>
        </div>
      </Show>
    </>
  );
}

// ---------- 加 Sidenote ----------

const TABS = [["code", "Code"], ["paste", "Paste"], ["text", "Text"], ["link", "Link"], ["card", "Card"]] as const;

function AddNotePop(p: { inst: PopInst; pop: Extract<Pop, { kind: "addNote" }> }) {
  const [tab, setTab] = createSignal(p.pop.tab);
  const [why, setWhy] = createSignal("");
  const [q, setQ] = createSignal("");
  const [res, setRes] = createSignal<SearchItem[]>([]);
  const [i, setI] = createSignal(0);
  const [text, setText] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [lang, setLang] = createSignal("python");
  const at = () => p.pop.at;
  const where = () => (at().lines ? (at().lines![0] === at().lines![1] ? `Line ${at().lines![0]}` : `Lines ${at().lines![0]}–${at().lines![1]}`) : "Whole card");
  let t: number | undefined;
  createEffect(() => {
    const s = q();
    clearTimeout(t);
    if (tab() !== "code" || !s.trim()) { setRes([]); return; }
    t = window.setTimeout(() => ask("search", { q: s, scope: "code" }).then((r) => { setRes(r.filter((x) => x.kind === "symbol" || x.kind === "file").slice(0, 8)); setI(0); }).catch(() => setRes([])), 120);
  });
  // 加好了、按了 Cancel 或去白板上选卡了。没有的话弹窗关掉时（Esc、点到外面）Text / Paste 里写了的照样加上，和编辑 Note 一样
  let settled = false;
  onCleanup(() => { if (!settled && (tab() === "text" || tab() === "paste")) void add(); });
  const cancel = () => { settled = true; closePop(p.inst.id); };
  const done = (n: Omit<Sidenote, "id" | "at">, view?: any) => {
    settled = true;
    A.addSidenote({ ...n, at: at(), why: why().trim() || undefined } as any, view);
    closePop(p.inst.id);
    toast("Sidenote added");
  };
  const add = async () => {
    switch (tab()) {
      case "code": {
        const it = res()[i()];
        if (!it) return;
        const r = await ask("searchPick", { item: it, alt: true }).catch(() => null);
        const c = r?.card;
        if (!c || !isCode(c)) return toast("Could not read that code");
        const seg = c.segments[0];
        return done({ kind: "code", code: seg } as any, r!.views[seg.id]);
      }
      case "paste": if (text().trim()) done({ kind: "paste", text: text().replace(/\s+$/, ""), lang: lang(), url: url().trim() || undefined } as any); return;
      case "text": if (text().trim()) done({ kind: "text", md: text() } as any); return;
      case "link": { let u = url().trim(); if (!u) return; if (!/^https?:/.test(u)) u = `https://${u}`; done({ kind: "link", url: u } as any); return; }
    }
  };
  const pickCard = () => {
    settled = true;
    closePop(p.inst.id);
    toast("Click a card on the board · Esc to cancel");
    A.pickCardThen((id) => { A.addSidenote({ at: at(), kind: "card", card: id, why: why().trim() || undefined } as any); toast("Sidenote added"); });
  };
  const onKey = (e: KeyboardEvent) => {
    keepKey(e);
    if (e.key === "Escape") { e.preventDefault(); closePop(p.inst.id); }
    if (tab() === "code" && e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(res().length - 1, x + 1)); }
    if (tab() === "code" && e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    if (e.key === "Enter" && !e.isComposing && (tab() === "code" || tab() === "link" || e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); }
  };
  return (
    <div class="addnote" onKeyDown={onKey}>
      <div class="tabs">
        <For each={TABS}>{([k, lb]) => <button class="tab" classList={{ on: tab() === k }} onClick={() => (k === "card" ? pickCard() : setTab(k))}>{lb}</button>}</For>
        <span class="grow" /><span class="where">{where()}</span>
      </div>
      <div class="an-body">
        <Switch>
          <Match when={tab() === "code"}>
            <input class="fld" autofocus placeholder="Search functions or files" value={q()} onInput={(e) => setQ(e.currentTarget.value)} ref={(e) => queueMicrotask(() => e.focus())} />
            <div class="sres">
              <For each={res()}>{(r, k) => <button class="cand" classList={{ on: k() === i() }} onPointerMove={(e) => { if (e.movementX || e.movementY) setI(k()); }} onClick={() => { setI(k()); add(); }}><span class="kind">{r.kind === "symbol" ? r.glyph : "▤"}</span><span class="lb">{r.label}</span><small>{r.detail}</small></button>}</For>
              <Show when={!res().length}><div class="hint">Or select code in the editor and press {A.K.alt}S</div></Show>
            </div>
          </Match>
          <Match when={tab() === "paste"}>
            <textarea class="fld mono" placeholder="Paste code here" value={text()} onInput={(e) => { setText(e.currentTarget.value); const g = guessLang(e.currentTarget.value); if (g) setLang(g); }} ref={(e) => queueMicrotask(() => e.focus())} />
            <input class="fld" placeholder="Source URL (optional)" value={url()} onInput={(e) => setUrl(e.currentTarget.value)} />
            <div class="row">Language: <select class="fld sm" value={lang()} onChange={(e) => setLang(e.currentTarget.value)}><For each={LANGS}>{(l) => <option value={l.id}>{l.label}</option>}</For></select></div>
          </Match>
          <Match when={tab() === "text"}>
            <textarea class="fld" placeholder="Write a note. Markdown and $math$ work." value={text()} onInput={(e) => setText(e.currentTarget.value)} ref={(e) => queueMicrotask(() => e.focus())} />
          </Match>
          <Match when={tab() === "link"}>
            <input class="fld" placeholder="https://…" value={url()} onInput={(e) => setUrl(e.currentTarget.value)} ref={(e) => queueMicrotask(() => e.focus())} />
          </Match>
        </Switch>
        <Show when={tab() !== "text"}><input class="fld" placeholder="Why is it related? (optional)" value={why()} onInput={(e) => setWhy(e.currentTarget.value)} /></Show>
      </div>
      <div class="db"><button onClick={cancel}>Cancel</button><button class="def" onClick={add}>Add</button></div>
    </div>
  );
}

// ---------- 版本 diff（和 Compare 同一套对齐） ----------

function DiffTable(p: { left: { start: number; text: string[]; html: string[] }; right: { start: number; text: string[]; html: string[] } }) {
  const rows = createMemo(() => {
    const norm = (s: string) => s.trim().replace(/\s+/g, " ");
    return alignRows(p.left.text.map(norm), p.right.text.map(norm)).map((r) => {
      let lh = r.l !== undefined ? p.left.html[r.l] : undefined, rh = r.r !== undefined ? p.right.html[r.r] : undefined;
      if (r.kind === "changed") { const w = wordDiff(p.left.text[r.l!], p.right.text[r.r!]); lh = markHtml(lh!, w.a); rh = markHtml(rh!, w.b); }
      return { ...r, lh, rh };
    });
  });
  // 只显示改动附近的行（上下各 2 行），其余收起
  const items = createMemo(() => {
    const rs = rows(), keep = new Set<number>();
    rs.forEach((r, i) => { if (r.kind !== "same") for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
    const out: ({ t: "row"; i: number } | { t: "gap"; n: number })[] = [];
    for (let i = 0; i < rs.length; i++) {
      if (keep.has(i) || rs.length < 14) { out.push({ t: "row", i }); continue; }
      let j = i; while (j < rs.length && !keep.has(j)) j++;
      out.push({ t: "gap", n: j - i }); i = j - 1;
    }
    return out;
  });
  const cell = (l: number | undefined, start: number, h?: string) => (l === undefined ? <div class="cl void" /> : <div class="cl"><span class="cno">{start + l}</span><span class="l" innerHTML={h || "​"} /></div>);
  return (
    <div class="crows dt">
      <For each={items()}>{(it) => it.t === "gap" ? <div class="cgap">⋯ {it.n} same lines</div> : (() => { const r = rows()[it.i]; return <div class={`crow ${r.kind}`}>{cell(r.l, p.left.start, r.lh)}{cell(r.r, p.right.start, r.rh)}</div>; })()}</For>
    </div>
  );
}

function DiffPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "diff" }> }) {
  const d = () => p.pop.data;
  const seg = () => { const c = cardById(p.pop.card)?.card; return isCode(c) ? segOf(c, p.pop.seg) : undefined; };
  const impact = createMemo(() => {
    const links = state.board.links.filter((l) => l.from.card === p.pop.card && l.from.seg === p.pop.seg && l.from.line).length;
    const notes = state.board.sidenotes.filter((n) => n.at.card === p.pop.card && n.at.seg === p.pop.seg && n.at.lines).length;
    const hl = seg()?.hl?.length ?? 0;
    const parts = [hl && `${hl} highlight${hl > 1 ? "s" : ""}`, links && `${links} link${links > 1 ? "s" : ""}`, notes && `${notes} sidenote${notes > 1 ? "s" : ""}`].filter(Boolean);
    return parts.length ? `On update: ${parts.join(", ")} move with their lines; anything on a removed line attaches to the whole card.` : "";
  });
  return (
    <div class="diffpop">
      <Head title={d()?.title ?? "Loading diff…"} inst={p.inst} />
      <Show when={p.pop.error}><div class="empty">{p.pop.error}</div></Show>
      <Show when={d()}>
        <Show when={d()!.lastChange}><div class="lastc">{d()!.lastChange}</div></Show>
        <div class="colh dh"><div><b>{d()!.left.label}</b><span>{d()!.left.path}:{d()!.left.start}</span></div><div><b>{d()!.right.label}</b><span>{d()!.right.path}:{d()!.right.start}</span></div></div>
        <div class="dbody"><DiffTable left={d()!.left} right={d()!.right} /></div>
        <Show when={impact()}><div class="lastc">{impact()}</div></Show>
        <div class="db">
          <button onClick={() => { A.duplicateNewVersion(p.pop.card, p.pop.seg, d()!); closePop(p.inst.id); }} disabled={!d()!.newSeg}>Duplicate as New Version</button>
          <span class="grow" />
          <button onClick={() => { A.keepVersion(p.pop.card, p.pop.seg); closePop(p.inst.id); }}>Keep {d()!.left.label.replace(/^Pinned /, "")}</button>
          <button class="def" disabled={!d()!.canUpdate} onClick={() => { A.applyNewVersion(p.pop.card, p.pop.seg, d()!); closePop(p.inst.id); }}>Update to {d()!.right.label.replace(/^HEAD /, "")}</button>
        </div>
      </Show>
    </div>
  );
}

// ---------- 三方对照（线框 07）：原版 / 我的 / 上游最新，两边都改了的行高亮 ----------

function ThreePop(p: { inst: PopInst; pop: Extract<Pop, { kind: "three" }> }) {
  const c = () => { const k = cardById(p.pop.card)?.card; return isCode(k) ? k : undefined; };
  const cols = createMemo(() => {
    const k = c(), l = A.vlive[p.pop.card]?.latest;
    if (!k || !l) return [];
    const ups = upstreamSegs(k), cur = activeOf(k);
    const html = (s: Segment, key: string) => state.views[key]?.html ?? s.text.map(escH);
    return k.segments.map((s) => {
      const b = ups.find((x) => x.id === s.id) ?? s, t = l.segs.find((x) => x.id === s.id) ?? b;
      const tw = threeWay(b.text, s.text, t.text);
      return {
        id: s.id, conflicts: tw.conflicts,
        cols: [
          { label: `Base ${versionLabel(b.version, true)}`, start: b.start, html: html(b, cur === UPSTREAM ? b.id : viewKey(b.id, UPSTREAM)), kinds: tw.base },
          { label: `Mine ${k.variants?.find((v) => v.id === cur)?.name ?? ""}`, start: s.start, html: html(s, s.id), kinds: tw.mine },
          { label: `Upstream latest ${l.label}`, start: t.start, html: l.views[t.id]?.html ?? t.text.map(escH), kinds: tw.latest },
        ],
      };
    });
  });
  const total = () => cols().reduce((n, x) => n + x.conflicts, 0);
  return (
    <div class="threepop">
      <Head title={`Three-way view · ${c() ? cardTitle(c()!) : ""}`} inst={p.inst} />
      <div class="lastc">{total() ? `${total()} line${total() > 1 ? "s" : ""} changed on both sides (highlighted)` : "No conflicting lines: your changes and upstream's don't touch the same lines"}</div>
      <For each={cols()}>{(sg) => (
        <div class="three">
          <For each={sg.cols}>{(col) => (
            <div class="tcol">
              <div class="th"><b>{col.label}</b></div>
              <div class="tb">
                <For each={col.html}>{(h, i) => <div class={`tl k-${col.kinds[i()] ?? "same"}`}><span class="cno">{col.start + i()}</span><span class="l" innerHTML={h || "​"} /></div>}</For>
              </div>
            </div>
          )}</For>
        </div>
      )}</For>
    </div>
  );
}

// ---------- 共享卡：在哪几块白板上 ----------

function BoardsPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "boards" }> }) {
  const bs = () => shared[p.pop.card]?.boards ?? [];
  createEffect(() => { if (bs().length < 2) closePop(p.inst.id); });
  return (
    <>
      <div class="picker-h">Also on</div>
      <For each={bs()}>{(b) => {
        const here = () => b.id === state.board.id;
        return (
          <button class="cand sb" classList={{ here: here() }} onClick={() => { closePop(p.inst.id); A.openOnBoard(b.id, p.pop.card); }}>
            <span class="lb">{b.name}</span>
            <Show when={b.mark || b.icon}><span class="step sm">{b.icon ? <Glyph icon={{ pack: "builtin", name: b.icon }} size={11} /> : b.mark}</span></Show>
            <small>{here() ? "This board" : "Open ↗"}</small>
          </button>
        );
      }}</For>
    </>
  );
}

// ---------- 选择 / commit / 变量 / 源码 ----------

function PickPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "pick" }> }) {
  return (
    <>
      <div class="picker-h">{p.pop.title}</div>
      <For each={p.pop.items}>{(it) => <button class="cand" onClick={() => { closePop(p.inst.id); it.run(); }}><span class="lb">{it.label}</span><small>{it.detail}</small></button>}</For>
    </>
  );
}

function CommitsPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "commits" }> }) {
  const [ref, setRef] = createSignal("");
  const pinned = () => (p.pop.seg.version.kind === "git" ? p.pop.seg.version.commit : "");
  const go = async () => {
    const r = ref().trim();
    if (!r) return;
    const got = await ask("resolveRef", { text: r }).catch((e) => { toast((e as Error).message); return null; });
    const sha = typeof got === "string" ? got : got?.commit;
    if (!got) toast(`No commit matches “${r}”`);
    if (sha) { closePop(p.inst.id); A.switchCommit(p.pop.card, sha); }
  };
  return (
    <>
      <div class="picker-h">Commits that changed this {p.pop.seg.symbol ? "symbol" : "range"}</div>
      <Show when={p.pop.list} fallback={<div class="empty">Loading…</div>}>
        <div class="sres">
          <For each={p.pop.list}>{(c) => (
            <button class="cand" classList={{ on: c.commit === pinned() }} onClick={() => { closePop(p.inst.id); if (c.commit !== pinned()) A.switchCommit(p.pop.card, c.commit); }}>
              <span class="sha">{c.commit.slice(0, 7)}</span><span class="lb">{c.msg}</span><small classList={{ cur: c.commit === pinned() }}>{c.commit === pinned() ? "✓ Current" : c.head ? "= HEAD" : c.date}</small>
            </button>
          )}</For>
          <Show when={!p.pop.list!.length}><div class="empty">No history (not in git).</div></Show>
        </div>
      </Show>
      <div class="an-body"><input class="fld" placeholder="Enter commit, branch or tag" value={ref()} onInput={(e) => setRef(e.currentTarget.value)} onKeyDown={(e) => { keepKey(e); if (e.key === "Enter") go(); if (e.key === "Escape") closePop(p.inst.id); }} /></div>
      <Show when={A.uncommitted(cardById(p.pop.card)?.card as any) || state.stale[p.pop.seg.id]?.state === "uncommitted"}>
        <button class="cand" onClick={() => { closePop(p.inst.id); A.openWorktreeDiff(p.pop.card); }}><span class="lb">Show Uncommitted Changes</span><small>HEAD vs Working Tree</small></button>
      </Show>
    </>
  );
}

function VarsPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "vars" }> }) {
  const L = () => state.board.links.find((l) => l.id === p.pop.link)?.call;
  const [custom, setCustom] = createSignal("");
  const has = (v: Var) => (L()?.vars ?? []).some((x) => varKey(x) === varKey(v));
  const all = () => { const l = L(); if (!l) return []; const c = l.cands ?? []; return [...c, ...(l.vars ?? []).filter((v) => !c.some((x) => varKey(x) === varKey(v)))]; };
  return (
    <>
      <div class="picker-h">Arguments</div>
      <div class="sres">
        <For each={all()}>{(v) => <label class="chk"><input type="checkbox" checked={has(v)} onChange={() => A.toggleVar(p.pop.link, v)} />{varText(v)}</label>}</For>
        <Show when={!all().length}><div class="empty">No arguments or return value found.</div></Show>
      </div>
      <div class="an-body"><input class="fld" placeholder="Add your own (e.g. seqs[0].block_table)" value={custom()} onInput={(e) => setCustom(e.currentTarget.value)}
        onKeyDown={(e) => { keepKey(e); if (e.key === "Enter" && custom().trim()) { A.toggleVar(p.pop.link, { a: custom().trim(), custom: true }); setCustom(""); } if (e.key === "Escape") closePop(p.inst.id); }} /></div>
    </>
  );
}

// ---------- 调用图标记 ----------

/** 图标用内置贴纸（名字引用，画法跟着贴纸走） */
const MARK_ICONS = ["star", "flag", "zap", "bug", "heart", "question", "check", "hourglass"];
const MARK_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function MarkPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "mark" }> }) {
  const g = () => flows().byId.get(p.pop.card);
  // 别的图正在用的字母（自动的或用户选的）：灰一点，但还能选
  const used = createMemo(() => new Set(flows().graphs.filter((x) => x !== g() && x.label).map((x) => x.label)));
  const pick = (m: GraphMark | null) => { closePop(p.inst.id); A.setGraphMark(p.pop.card, m); };
  const isLetter = (l: string) => { const m = g()?.mark; return !!m && "letter" in m && m.letter === l; };
  const isIcon = (n: string) => { const m = g()?.mark; return !!m && "icon" in m && m.icon === n; };
  return (
    <Show when={g()}>
      <div class="picker-h">Call Graph Mark</div>
      <div class="markgrid">
        <For each={MARK_LETTERS}>{(l) => <button class="mk-l" classList={{ on: isLetter(l), used: used().has(l) }} onClick={() => pick({ letter: l })}>{l}</button>}</For>
      </div>
      <div class="markgrid icons">
        <For each={MARK_ICONS}>{(n) => <button class="mk-i" classList={{ on: isIcon(n) }} aria-label={n} onClick={() => pick({ icon: n })}><Glyph icon={{ pack: "builtin", name: n }} size={16} /></button>}</For>
      </div>
      <button class="cand" disabled={!g()!.custom} onClick={() => pick(null)}><span class="lb">Auto</span><small>Letter by creation order</small></button>
    </Show>
  );
}

// ---------- 接上断掉的调用链（线框 01、02） ----------

/** 动态分发：N 个实现选一个。library 的要 ⌥；Why this one? 写进箭头的标签框。键盘在输入框里：↑ / ↓ 选、↵ 定、Esc 关 */
function ImplsPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "impls" }> }) {
  const d = () => p.pop.data;
  const [why, setWhy] = createSignal("");
  const [i, setI] = createSignal(0);
  const go = (k: number, alt: boolean) => { if (A.pickImpl(d(), k, why(), alt)) closePop(p.inst.id); };
  const short = (q: string) => q.split(".").slice(-2).join(".");
  return (
    <>
      <Head title={<>{d().impls.length} implementations of <code>{short(d().base)}</code></>} inst={p.inst} right={<span class="disp-tag">Dynamic dispatch</span>} />
      <div class="sres impls">
        <For each={d().impls}>{(it, k) => {
          const lib = () => !!it.lib && !state.host.settings.studyScope.includes(it.lib);
          return (
            <button class="cand impl" classList={{ on: k() === i(), lib: lib() }} onPointerMove={() => setI(k())}
              onClick={(e) => go(k(), e.altKey)} data-tip={lib() ? `Library code (${it.lib}) · ${A.K.alt}-click to expand` : undefined}>
              <span class="kind">ƒ</span><span class="lb">{it.label}</span>
              <Show when={it.base}><span class="src-tag">base</span></Show>
              <Show when={lib()}><span class="lib-tag">library</span></Show>
              <small>{it.detail}</small>
            </button>
          );
        }}</For>
      </div>
      <div class="an-body"><input class="fld" placeholder="Why this one? (optional)" value={why()} onInput={(e) => setWhy(e.currentTarget.value)}
        ref={(el) => queueMicrotask(() => el.focus())}
        onKeyDown={(e) => {
          keepKey(e);
          const n = d().impls.length;
          if (e.key === "Escape") { e.preventDefault(); closePop(p.inst.id); }
          else if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => (x + 1) % n); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => (x - 1 + n) % n); }
          else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(i(), e.altKey); }
        }} /></div>
      <div class="pk-more">The others stay as grey branches next to the card you pick.</div>
    </>
  );
}

/** 跨边界的取值：kNumRanks 取几，其余的留成灰色分支 */
function ValsPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "vals" }> }) {
  const v = () => state.board.links.find((l) => l.id === p.pop.link)?.call?.vals?.[p.pop.val];
  createEffect(() => { if (!v()) closePop(p.inst.id); });
  return (
    <Show when={v()}>
      <div class="picker-h"><code>{v()!.name}</code>: pick a value</div>
      <Show when={v()!.from}><div class="pk-more">Comes from <code>{v()!.from}</code></div></Show>
      <For each={v()!.opts ?? [v()!.value]}>{(o) => (
        <button class="cand" classList={{ on: o === v()!.value }} onClick={() => { closePop(p.inst.id); A.setVal(p.pop.link, p.pop.val, o); }}>
          <span class="lb"><code>{v()!.name} → {o}</code></span><small>{o === v()!.value ? "✓ Current" : ""}</small>
        </button>
      )}</For>
      <div class="pk-more">Other values stay as grey branches.</div>
    </Show>
  );
}

const LANG_NAMES: Record<string, string> = { py: "Python", cpp: "C++", cuda: "CUDA", rust: "Rust" };

/** 解析不到的调用：按名字在所有语言里搜，按语言分组；点一处建卡 + 虚线 Call 箭头（via registry · manual） */
function NamesPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "names" }> }) {
  const d = () => p.pop.data;
  const groups = createMemo(() => {
    const hs = d().hits ?? [];
    const keys = [...new Set(["py", "cpp", ...hs.map((h) => h.lang)])];
    return keys.map((k) => ({ lang: k, hits: hs.filter((h) => h.lang === k) }));
  });
  return (
    <>
      <Head title={<>Search <code>{A.searchedName(d().call)}</code> in all languages</>} inst={p.inst} />
      <Show when={d().hits} fallback={<div class="empty">Searching…</div>}>
        <div class="sres names">
          <For each={groups()}>{(g) => (
            <>
              <div class="grp-h">{LANG_NAMES[g.lang] ?? g.lang}</div>
              <For each={g.hits} fallback={<div class="empty sm">no matches</div>}>{(h) => (
                <button class="cand" onClick={() => { closePop(p.inst.id); void A.placeNameHit(d(), h); }}>
                  <span class="kind">{h.def ? "ƒ" : "“”"}</span><span class="lb">{h.label}</span><small>{h.detail}</small>
                </button>
              )}</For>
            </>
          )}</For>
        </div>
      </Show>
      <div class="sn-acts"><button class="tbtn" onClick={() => { closePop(p.inst.id); A.drawManual(d().card, d().seg, d().call); }}>Draw Call Arrow Manually…</button></div>
    </>
  );
}

/** RPC 箭头的属性（线框 03 三）：机制、消息 / 方法名、一对多、插一张消息卡、↩ back to。改了马上生效，都能以后再改 */
function RpcPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "rpc" }> }) {
  const L = () => state.board.links.find((l) => l.id === p.pop.link);
  const r = () => L()?.rpc;
  createEffect(() => { if (!r()) closePop(p.inst.id); });
  const msg = () => A.msgOf(p.pop.link);
  const commit = (f: (x: NonNullable<ReturnType<typeof r>>) => void) => A.setRpc(p.pop.link, f);
  return (
    <Show when={r()}>
      <Head title={<b>RPC Arrow</b>} inst={p.inst} />
      <div class="rpcf">
        <label>Mechanism
          <select class="fld sel" value={r()!.mech} onChange={(e) => commit((x) => { x.mech = e.currentTarget.value; })}>
            <For each={RPC_MECHS}>{(m) => <option value={m}>{m}</option>}</For>
          </select>
        </label>
        <Show when={r()!.mech === "custom"}>
          <label>Name<input class="fld" value={r()!.custom ?? ""} placeholder="e.g. NCCL p2p" onKeyDown={keepKey} onChange={(e) => commit((x) => { x.custom = e.currentTarget.value.trim() || undefined; })} /></label>
        </Show>
        <label>Message / method<input class="fld mono" value={r()!.msg ?? ""} placeholder={`"run"  ·  TokenizedGenerateReqInput`} onKeyDown={(e) => { keepKey(e); if (e.key === "Enter") e.currentTarget.blur(); }} onChange={(e) => commit((x) => { x.msg = e.currentTarget.value.trim() || undefined; })} /></label>
        <label>Fan-out
          <select class="fld sel" value={r()!.fan ?? "one"} onChange={(e) => commit((x) => { x.fan = e.currentTarget.value === "all" ? "all" : undefined; })}>
            <option value="one">One to one</option>
            <option value="all">One to all ranks</option>
          </select>
        </label>
        <label class="chk"><input type="checkbox" checked={!!msg()} onChange={() => A.toggleMsgCard(p.pop.link)} />Insert message card<small>sender → message → receiver</small></label>
        <label class="chk"><input type="checkbox" checked={!!L()?.back} onChange={() => A.toggleBack(p.pop.link)} />↩ Back to start<small>Walkthrough stops here</small></label>
      </div>
      <div class="sn-acts"><span class="grow" /><button class="tbtn" onClick={() => { closePop(p.inst.id); A.clearRpc(p.pop.link); }}>Remove RPC Mark</button></div>
    </Show>
  );
}

void pinPop; void mutate; void select; void setConnectFrom; void findCard;
