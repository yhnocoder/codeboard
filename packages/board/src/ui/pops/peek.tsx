import { For, Show } from "solid-js";
import { baseName, escHtml, isCode, segOf } from "@codeboard/core";
import { langInfo } from "@codeboard/analysis/langs";
import { state, cardById } from "../../state/store";
import { closePop, updatePop } from "../../state/pop";
import { send } from "../../host";
import * as A from "../../actions";
import { MdStatic } from "../Md";
import { PopHead, Code, type PopProps } from "./common";

export function PeekPop(p: PopProps<"peek">) {
  const d = () => p.pop.data;
  const def = () => { const x = d(); return x && "seg" in x ? x : null; };
  const picks = () => { const x = d(); return x && "pick" in x ? x.pick : null; };
  const lib = () => { const l = def()?.lib; return l && !state.host.settings.studyScope.includes(l) ? l : ""; };
  const pin = () => { const x = def(); if (x) A.pinPeek(p.inst.id, p.pop, x); };
  const place = () => { const x = def(); if (x) A.placePeek(p.inst.id, p.pop, x); };
  // 找不到定义的原因按语言说：Python 的 setattr，C++ 要装 clangd / cpptools…
  const noDef = () => {
    const c = cardById(p.pop.card)?.card;
    const lang = p.pop.trail?.at(-1)?.seg.lang ?? (isCode(c) ? segOf(c, p.pop.seg)?.lang : undefined);
    const l = langInfo(lang);
    return l?.noDef ?? `no language extension${l ? ` for ${l.label}` : ""}`;
  };
  return (
    <>
      <Show when={def()} fallback={
        <Show when={d()} fallback={<div class="empty">Looking up <code>{p.pop.word}</code>…</div>}>
          <Show when={picks()} fallback={
            <>
              <PopHead title={<>No definition found · <code>{p.pop.word}</code></>} inst={p.inst} />
              <div class="empty">The language server has no definition for this name ({noDef()}).</div>
              <div class="sn-acts"><button class="tbtn" onClick={() => { closePop(p.inst.id); A.searchWorkspace(p.pop.word); }}>Search Workspace</button></div>
            </>}>
            <PopHead title={<>{picks()!.length} definitions · <code>{p.pop.word}</code></>} inst={p.inst} />
            <For each={picks()!}>{(x) => <button class="cand" onClick={() => updatePop(p.inst.id, (q) => (q.kind === "peek" ? { ...q, data: x } : q))}><span class="lb">{x.path}:{x.line}</span></button>}</For>
          </Show>
        </Show>
      }>
        <PopHead title={<>Definition · {def()!.title ?? `${baseName(def()!.path)}:${def()!.line}`}</>} inst={p.inst}
          right={lib() ? <span class="lib-tag" data-tip={`Library code · ${lib()}`}>library</span> : <span class="src-tag">{def()!.seg.version.kind === "git" && def()!.kind !== "module" ? "at HEAD" : ""}</span>} />
        <Show when={def()!.dispatch}>{(dp) => (
          <div class="pk-disp"><span class="disp-tag">Dynamic dispatch</span> {dp().n} implementation{dp().n > 1 ? "s" : ""} · Static type: <code>{dp().base}</code>{dp().abstract ? " (abstract)" : ""}<span class="grow" /><small>Click the call to choose</small></div>
        )}</Show>
        <Show when={def()!.sig || def()!.doc}>
          <div class="pk-top">
            <Show when={def()!.sig}><div class="pk-sig" innerHTML={def()!.sigHtml ?? escHtml(def()!.sig!)} /></Show>
            <Show when={def()!.doc}><MdStatic class="pk-doc" src={def()!.doc!} /></Show>
          </div>
        </Show>
        <Show when={def()!.kind !== "module" && def()!.html.length}>
          <Show when={def()!.head}><div class="pk-head">{def()!.head}</div></Show>
          <Code start={def()!.start} html={def()!.html} hl={def()!.line} rows={def()!.rows} />
          <Show when={def()!.more}><div class="pk-more">⋯ {def()!.more} more line{def()!.more! > 1 ? "s" : ""}</div></Show>
        </Show>
        <Show when={def()!.follow}>
          <div class="follow">↳ <code>{def()!.follow!.label}</code><span class="grow" /><button class="tbtn" onClick={() => A.followPeek(p.inst.id, def()!)}>Follow</button></div>
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
