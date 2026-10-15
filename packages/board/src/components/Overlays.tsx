import { For, Show, createSignal } from "solid-js";
import { cardTitle, type CodeCard } from "@codeboard/core";
import { state, setState, toast, steps, fitAll } from "../store";
import { send } from "../host";
import { present, startPresent, stopPresent, Icon } from "./Canvas";

// ---------- 顶栏：白板切换、讲解、显示全部 ----------

export function TopBar() {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="topbar" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
      <div class="board-pick">
        <button class="board-name" onClick={() => setOpen(!open())} title="切换白板">
          <span>{state.board.name || "CodeBoard"}</span><Icon d="M7 10l5 5 5-5" />
        </button>
        <Show when={open()}>
          <div class="scrim clear" onPointerDown={() => setOpen(false)} />
          <div class="menu">
            <For each={state.boards}>
              {(b) => (
                <button classList={{ on: b.id === state.board.id }} onClick={() => { setOpen(false); if (b.id !== state.board.id) send({ type: "switchBoard", id: b.id }); }}>
                  <span>{b.name}</span>
                </button>
              )}
            </For>
            <button class="menu-new" onClick={() => { setOpen(false); send({ type: "newBoard" }); }}><span>＋ 新建白板</span></button>
          </div>
        </Show>
      </div>
      <div class="spacer" />
      <button class="ghost" title="按编号依次讲解（P）" onClick={startPresent}><Icon d="M7 5l11 7-11 7z" /><span>讲解</span></button>
      <button class="ghost" title="显示全部（F）" onClick={fitAll}><Icon d="M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5" /></button>
    </div>
  );
}

// ---------- 新版本 diff ----------

export function DiffPopover() {
  const card = () => (state.diff ? (state.board.cards.find((c) => c.id === state.diff!.id) as CodeCard | undefined) : undefined);
  const stat = () => {
    const ls = state.diff?.lines ?? [];
    return { add: ls.filter((l) => l.op === "+").length, del: ls.filter((l) => l.op === "-").length };
  };
  return (
    <Show when={state.diff && card()}>
      <div class="scrim" onPointerDown={() => setState("diff", null)}>
        <div class="diff dialog" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="源码新版本">
          <div class="diff-h">
            <div>
              <h3>{cardTitle(card()!)} 有新版本</h3>
              <p>卡片钉在 <code>{state.diff!.from}</code>，工作区是 <code>{state.diff!.to}</code></p>
            </div>
            <span class="stat"><b class="add">+{stat().add}</b> <b class="del">−{stat().del}</b></span>
          </div>
          <div class="diff-body">
            <For each={state.diff!.lines}>
              {(l) => (
                <div class={`dl op-${l.op === "+" ? "add" : l.op === "-" ? "del" : "eq"}`}>
                  <span class="ln">{l.a ?? ""}</span><span class="ln">{l.b ?? ""}</span><span class="op">{l.op}</span><span class="t">{l.text}</span>
                </div>
              )}
            </For>
          </div>
          <div class="diff-f">
            <span class="hint">跟进后，高亮行和从这张卡片出发的箭头会按内容迁移到新行号。</span>
            <button onClick={() => setState("diff", null)}>留在旧版本</button>
            <button class="primary" onClick={() => send({ type: "follow", id: card()!.id })}>跟进到最新</button>
          </div>
        </div>
      </div>
    </Show>
  );
}

export function Toast() {
  return <Show when={toast()}><div class="toast" role="status">{toast()}</div></Show>;
}

export function PresentBar() {
  const cur = () => (state.present === null ? undefined : steps()[state.present]);
  return (
    <Show when={cur()}>
      <div class="present-bar">
        <button onClick={() => present(Math.max(0, state.present! - 1))} disabled={state.present === 0} aria-label="上一步">←</button>
        <div class="pb-mid">
          <span class="step">{cur()!.step}</span>
          <span class="pb-title">{cardTitle(cur()!)}</span>
          <span class="pb-count">{state.present! + 1} / {steps().length}</span>
        </div>
        <button onClick={() => present(Math.min(steps().length - 1, state.present! + 1))} disabled={state.present === steps().length - 1} aria-label="下一步">→</button>
        <button class="pb-x" onClick={stopPresent}>退出 <kbd>Esc</kbd></button>
      </div>
    </Show>
  );
}
