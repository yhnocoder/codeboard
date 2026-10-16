// 浮层：Sidenote、定义预览、加 Sidenote、版本 diff、多个定义选择、commit 列表、变量、只读源码。
import { For, Show, Switch, Match, createSignal, createMemo, onMount, createEffect, onCleanup } from "solid-js";
import { unwrap } from "solid-js/store";
import {
  alignRows, wordDiff, cardTitle, varKey, varText, versionLabel, baseName, isCode, segOf, findCard, langLabel, LANGS, guessLang,
  type Sidenote, type DiffData, type PeekDef, type PeekResult, type SearchItem, type NewCard, type Var, type Anchor,
} from "@codeboard/core";
import { state, cardById, toast, mutate, select } from "../state/store";
import { cam } from "../state/camera";
import { pops, closePop, pinPop, updatePop, type PopInst, type Pop } from "../state/pop";
import { setConnectFrom } from "../state/ui";
import { markHtml } from "../cards/CompareBody";
import { Icon } from "./icons";
import { promptText } from "./Menu";
import { ask, send } from "../host";
import * as A from "../actions";

export function Popovers() {
  return <>
    {/* library 调用的样式跟着 Study Scope 变（这里顺带挂上，免得改 App） */}
    <style>{A.libCallCss()}</style>
    <For each={pops()}>{(p) => <PopFrame inst={p} />}</For>
  </>;
}

function PopFrame(p: { inst: PopInst }) {
  let el!: HTMLDivElement;
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  onMount(() => {
    const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  const pos = createMemo(() => {
    void cam.x; void cam.y; void cam.z; // 镜头动时跟着元素走
    const at = p.inst.at, s = size();
    const W = window.innerWidth, H = window.innerHeight;
    let x = at.x ?? 0, y = at.y ?? 0;
    if (at.el?.isConnected) {
      const r = at.el.getBoundingClientRect();
      if (at.prefer === "right") { x = r.right + 8; y = r.top - 6; if (x + s.w > W - 8) x = r.left - s.w - 8; }
      else if (at.prefer === "above") { x = r.left; y = r.top - s.h - 6; }
      else { x = r.left; y = r.bottom + 6; if (y + s.h > H - 8) y = r.top - s.h - 6; }
    }
    return { x: Math.max(8, Math.min(x, W - s.w - 8)), y: Math.max(8, Math.min(y, H - s.h - 8)) };
  });
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
        <For each={notes()}>{(n) => <div class="sn-item" classList={{ on: n.id === curNote()?.id }} onPointerDown={() => setCur(n.id)}><NoteItem n={n} /></div>}</For>
      </div>
      <div class="sn-acts">
        <button class="tbtn" onClick={() => { const n = notes()[0]; if (n) { closePop(p.inst.id); A.openAddNote(n.at); } }}>+ Add</button>
        <Show when={curNote()?.kind === "text"}>
          <button class="tbtn" onClick={() => editText(curNote()!)}>Edit</button>
          <button class="tbtn" classList={{ on: !!(curNote() as any)?.alwaysShow }} onClick={() => A.updateSidenote(curNote()!.id, (n) => { if (n.kind === "text") n.alwaysShow = !n.alwaysShow || undefined; })}>Always Show</button>
        </Show>
        <Show when={curNote() && curNote()!.kind !== "card"}><button class="tbtn" onClick={() => A.placeSidenote(curNote()!.id)}>Place on Board</button></Show>
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
          <Show when={snEditing() === n().id} fallback={<div class="sn-text md" data-tip="Double-click to edit" innerHTML={A.mdBlock((n() as any).md)} onDblClick={() => editText(n())} />}>
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
    </>
  );
}
const escH = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// 旁注原地编辑（#37）：多行、自动增高，和 Note 卡一样是 Markdown + 公式，下面实时预览。⌘↵ 保存，Esc 取消
const [snEditing, setSnEditing] = createSignal<string | null>(null);
function editText(n: Sidenote) {
  if (n.kind !== "text") return;
  for (const q of pops()) if (q.pop.kind === "notes" && q.pop.ids.includes(n.id)) pinPop(q.id);
  setSnEditing(n.id);
}
function SidenoteEditor(p: { n: Extract<Sidenote, { kind: "text" }> }) {
  const [v, setV] = createSignal(p.n.md);
  const grow = (el: HTMLTextAreaElement) => { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };
  const save = () => { const t = v().trim(); setSnEditing(null); if (t && t !== p.n.md) A.updateSidenote(p.n.id, (k) => { if (k.kind === "text") k.md = t; }); };
  return (
    <div class="sn-edit" onPointerDown={(e) => e.stopPropagation()}>
      <textarea spellcheck={false} value={v()} ref={(el) => queueMicrotask(() => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); grow(el); })}
        onInput={(e) => { setV(e.currentTarget.value); grow(e.currentTarget); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); setSnEditing(null); } if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }} />
      <Show when={v().trim()}><div class="sn-text md sn-prev" innerHTML={A.mdBlock(v())} /></Show>
      <div class="sn-eacts"><span>Markdown and $math$ · {A.K.mod}↵ to save</span><span class="grow" /><button class="tbtn" onClick={() => setSnEditing(null)}>Cancel</button><button class="tbtn pri" onClick={save}>Save</button></div>
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
    A.addSidenote({ at, kind: "code", code: { ...structuredClone(x.seg), id: crypto.randomUUID?.() ?? `s${Date.now()}` } } as any);
    // 展示数据用定义预览里那几行（段的 id 换了，重新要一次）
    const n = state.board.sidenotes[state.board.sidenotes.length - 1];
    if (n?.kind === "code") A.requestViews([n.code]);
    toast("Pinned as Sidenote");
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
    A.addPlain({ card: p.pop.card, seg: p.pop.seg, line: p.pop.line }, { card: id });
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
        <Show when={def()!.sig || def()!.doc}>
          <div class="pk-top">
            <Show when={def()!.sig}><div class="pk-sig" innerHTML={def()!.sigHtml ?? escH(def()!.sig!)} /></Show>
            <Show when={def()!.doc}><div class="pk-doc md" innerHTML={docHtml(def()!.doc!)} onClick={onDocClick} /></Show>
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
            updatePop(p.inst.id, (q) => ({ ...(q as any), data: undefined }));
            ask<PeekResult>("peek", { seg: structuredClone(unwrap(def()!.seg)), line: f.line, col: f.col, word: f.label.split(".").pop()!, at: { path: f.path, line: f.line, col: f.col } })
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

/** hover 文档：Markdown，代码块顺手着色 */
function docHtml(src: string) {
  return A.mdBlock(src).replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, c: string) => `<pre><code>${hlPy(c)}</code></pre>`);
}
// 极简 Python 着色（在转义过的 HTML 上做）：注释、字符串、数字、关键字
const PY_RE = /(#[^\n]*)|(&quot;(?:(?!&quot;)[^\n])*&quot;|'[^'\n]*')|(\b\d+(?:\.\d+)?\b)|\b(def|class|return|if|else|elif|for|while|in|not|and|or|is|None|True|False|import|from|as|with|lambda|yield|raise|try|except|finally|pass|async|await)\b/g;
const hlPy = (h: string) => h.replace(PY_RE, (m, com, str, num) => `<span class="${com ? "com" : str ? "str" : num ? "num" : "kw"}">${m}</span>`);
const onDocClick = (e: MouseEvent) => {
  const a = (e.target as HTMLElement).closest?.("a.lnk") as HTMLElement | null;
  if (a?.dataset.href) { e.preventDefault(); A.openLink(a.dataset.href); }
};

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
    t = window.setTimeout(() => ask<SearchItem[]>("search", { q: s, scope: "code" }).then((r) => { setRes(r.filter((x) => x.kind === "symbol" || x.kind === "file").slice(0, 8)); setI(0); }).catch(() => setRes([])), 120);
  });
  const done = (n: Omit<Sidenote, "id" | "at">, view?: any) => {
    A.addSidenote({ ...n, at: at(), why: why().trim() || undefined } as any, view);
    closePop(p.inst.id);
    toast("Sidenote added");
  };
  const add = async () => {
    switch (tab()) {
      case "code": {
        const it = res()[i()];
        if (!it) return;
        const r = await ask<NewCard>("searchPick", { item: it, alt: true }).catch(() => null);
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
    closePop(p.inst.id);
    toast("Click a card on the board · Esc to cancel");
    A.pickCardThen((id) => { A.addSidenote({ at: at(), kind: "card", card: id, why: why().trim() || undefined } as any); toast("Sidenote added"); });
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
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
      <div class="db"><button onClick={() => closePop(p.inst.id)}>Cancel</button><button class="def" onClick={add}>Add</button></div>
    </div>
  );
}

// ---------- 版本 diff（和 Compare 同一套对齐） ----------

export function DiffTable(p: { left: { start: number; text: string[]; html: string[] }; right: { start: number; text: string[]; html: string[] } }) {
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
    const got = await ask<string | { commit: string } | null>("resolveRef", { text: r }).catch((e) => { toast((e as Error).message); return null; });
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
      <div class="an-body"><input class="fld" placeholder="Enter commit, branch or tag" value={ref()} onInput={(e) => setRef(e.currentTarget.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") go(); if (e.key === "Escape") closePop(p.inst.id); }} /></div>
      <Show when={A.uncommitted(cardById(p.pop.card)?.card as any) || state.stale[p.pop.seg.id]?.state === "uncommitted"}>
        <button class="cand" onClick={() => { closePop(p.inst.id); A.openWorktreeDiff(p.pop.card); }}><span class="lb">Show Uncommitted Changes</span><small>HEAD vs Working Tree</small></button>
      </Show>
    </>
  );
}

function VarsPop(p: { inst: PopInst; pop: Extract<Pop, { kind: "vars" }> }) {
  const L = () => { const l = state.board.links.find((l) => l.id === p.pop.link); return l?.kind === "call" ? l : undefined; };
  const [custom, setCustom] = createSignal("");
  const has = (v: Var) => (L()?.vars ?? []).some((x) => varKey(x) === varKey(v));
  const all = () => { const l = L(); if (!l) return []; const c = l.cands ?? []; return [...c, ...(l.vars ?? []).filter((v) => !c.some((x) => varKey(x) === varKey(v)))]; };
  return (
    <>
      <div class="picker-h">Variables on this call</div>
      <div class="sres">
        <For each={all()}>{(v) => <label class="chk"><input type="checkbox" checked={has(v)} onChange={() => A.toggleVar(p.pop.link, v)} />{varText(v)}</label>}</For>
        <Show when={!all().length}><div class="empty">No arguments or return value found.</div></Show>
      </div>
      <div class="an-body"><input class="fld" placeholder="Add your own (e.g. seqs[0].block_table)" value={custom()} onInput={(e) => setCustom(e.currentTarget.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && custom().trim()) { A.toggleVar(p.pop.link, { a: custom().trim(), custom: true }); setCustom(""); } if (e.key === "Escape") closePop(p.inst.id); }} /></div>
    </>
  );
}

void pinPop; void mutate; void select; void setConnectFrom; void findCard;
