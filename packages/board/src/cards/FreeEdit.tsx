// 自由代码卡的编辑：CodeMirror（@codeboard/markdown/code-editor），排版和显示时一模一样（同一个 .code 字体行高、54px 的行号栏、宿主给的着色），
// 进出编辑字的位置不动。改了的行先留着挪过来的旧着色，宿主的着色回来就换上；当前行有底色。
// Tab / ⇧Tab 缩进（多行一起），回车保持缩进（: { [ ( 结尾多缩一级），⌘/ 切换注释，Esc / ⌘↵ 结束。
// 补全菜单、悬停、签名提示问宿主的语言服务（VS Code 里是 Pylance 之类），灰字补全和 Note 一样。
// CodeMirror 还没加载好时（一般空闲时早就预加载了）先照原样显示，加载好了再换上
import { createEffect, For, onCleanup, onMount, Show, createSignal } from "solid-js";
import { escHtml, langInfo } from "@codeboard/core";
import type { CodeCard, SegView } from "@codeboard/core";
import { state } from "../state/store";
import { loadCm, cmNow, lspHost, ghostHost, nearSeg, hostHighlight } from "../cm/load";
import type { CodeEditor } from "@codeboard/markdown/code-editor";
import { lastDown } from "../state/measure";


export type FreeEditCtl = { text(): string; focus(): void; el: HTMLElement };

export function FreeEdit(p: { card: () => CodeCard; wrap: () => boolean; onBlur: (e: FocusEvent, ctl: FreeEditCtl) => void; onExit: (text: string) => void }) {
  let box!: HTMLDivElement;
  const seg = () => p.card().segments[0];
  const v0: SegView | undefined = state.views[seg().id];
  const [ed, setEd] = createSignal<CodeEditor | null>(null);
  let gone = false;
  const id = `free-${p.card().id}`;

  const make = (m: typeof import("@codeboard/markdown/code-editor")) => {
    if (gone) return;
    const lsp = lspHost(id, () => seg().lang, () => nearSeg(p.card().id, seg().lang));
    let e!: CodeEditor;
    e = m.codeEditor({
      parent: box,
      text: seg().text.join("\n"),
      lang: seg().lang,
      wrap: p.wrap(),
      gutter: { start: seg().start },
      html: v0?.html.join("\n"),
      highlight: (t) => hostHighlight(seg(), t),
      comment: (l) => langInfo(l)?.comment,
      lsp,
      stopPointerDown: true, // 按下不让白板当成拖卡片
      ghost: ghostHost(),
      onExit: () => p.onExit(e.text()),
      onBlur: (ev) => p.onBlur(ev, { text: () => e.text(), focus: () => e.view.focus(), el: e.view.contentDOM }),
    });
    setEd(e);
    lsp.sync(e.text());
    const v = e.view;
    // 光标放在双击的地方（新建的空卡在开头）；拿焦点：菜单关掉、卡片刚放上去的那几帧焦点可能被别处拿走，拿到为止（最多 20 帧）
    queueMicrotask(() => {
      if (gone) return;
      const d = lastDown(), at = d && v.posAtCoords(d);
      v.dispatch({ selection: { anchor: at ?? 0 } });
      let n = 0;
      const grab = () => { if (gone || v.hasFocus || ++n > 20) return; v.focus(); requestAnimationFrame(grab); };
      grab();
    });
  };
  onMount(() => { const m = cmNow(); if (m) make(m); else void loadCm().then(make).catch((e) => console.error("code editor:", e)); });
  onCleanup(() => { gone = true; ed()?.destroy(); }); // 编辑器拆掉时关掉语言服务的虚拟文档
  // 换了语言：重新着色（语言服务的虚拟文档下次同步时换语言）
  createEffect(() => { const l = seg().lang; ed()?.setLang(l); });

  return (
    <div class="code freecode">
      {/* CodeMirror 自己的容器（不和 Solid 管的东西放在一起：Solid 清空子节点时会把它一起清掉） */}
      <div ref={box} style={{ display: "contents" }} />
      <Show when={!ed()}>
        <div class="gutter"><For each={seg().text}>{(_, i) => <span class="no" style={{ top: `${6 + i() * 20}px` }}>{seg().start + i()}</span>}</For></div>
        <div class="src"><For each={seg().text}>{(t, i) => <div class="l" innerHTML={v0?.html[i()] ?? escHtml(t) ?? "​"} />}</For></div>
      </Show>
    </div>
  );
}
