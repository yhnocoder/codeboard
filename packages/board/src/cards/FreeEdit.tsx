// 自由代码卡的编辑：CodeMirror，排版和显示时一模一样（同一个 .code 字体行高、54px 的行号栏、宿主给的着色），进出编辑字的位置不动。
// 改了的行先留着挪过来的旧着色，宿主的着色回来就换上。CodeMirror 还没加载好时先照原样显示，加载好了再换上
import { createEffect, For, onCleanup, onMount, Show, createSignal } from "solid-js";
import { escHtml } from "@codeboard/core";
import { langInfo } from "@codeboard/analysis/langs";
import type { CodeCard, SegView } from "@codeboard/core";
import { state } from "../state/store";
import { loadCm, cmNow, lspHost, ghostHost, nearSeg, hostHighlight } from "../cm/load";
import type { CodeEditor } from "@yhnocoder/markdown/code-editor";
import { lastDown } from "../state/measure";
import { takeEditEntry } from "../state/ui";

export type FreeEditCtl = { text(): string; focus(): void; el: HTMLElement };

export function FreeEdit(p: {
  card: () => CodeCard;
  wrap: () => boolean;
  onBlur: (e: FocusEvent, ctl: FreeEditCtl) => void;
  onExit: (text: string) => void;
}) {
  let box!: HTMLDivElement;
  const seg = () => p.card().segments[0];
  const v0: SegView | undefined = state.views[seg().id];
  const [ed, setEd] = createSignal<CodeEditor | null>(null);
  let gone = false;
  const id = `free-${p.card().id}`;

  // 显示时选了一段代码再按 ⌫ / Delete 进来的：选上同一段，再把这个键交给编辑器
  const entry = takeEditEntry("free", p.card().id);
  const make = (m: typeof import("@yhnocoder/markdown/code-editor")) => {
    if (gone) return;
    const lsp = lspHost(
      id,
      () => seg().lang,
      () => nearSeg(p.card().id, seg().lang),
    );
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
      find: { isMac: state.host.isMac }, // ⌘F 查找、⌥⌘F 替换
      onExit: () => p.onExit(e.text()),
      onBlur: (ev) => p.onBlur(ev, { text: () => e.text(), focus: () => e.view.focus(), el: e.view.contentDOM }),
    });
    setEd(e);
    lsp.sync(e.text());
    const v = e.view;
    // 光标放在双击的地方（新建的空卡在开头）；拿焦点：菜单关掉、卡片刚放上去的那几帧焦点可能被别处拿走，拿到为止（最多 20 帧）
    queueMicrotask(() => {
      if (gone) return;
      const d = lastDown(),
        at = d && v.posAtCoords(d);
      const doc = v.state.doc,
        pos = ([l, c]: [number, number]) =>
          l < doc.lines ? Math.min(doc.line(l + 1).from + c, doc.line(l + 1).to) : null;
      const a = entry && pos(entry.from),
        b = entry && pos(entry.to),
        picked = a !== null && b !== null && a < b;
      v.dispatch({ selection: picked ? { anchor: a, head: b } : { anchor: at ?? 0 } });
      let n = 0;
      const grab = () => {
        if (gone || v.hasFocus || ++n > 20) return;
        v.focus();
        requestAnimationFrame(grab);
      };
      grab();
      if (entry && picked) {
        // 和在编辑器里按这个键一样走它的键表；键表没接（不会发生）就直接删
        const ev = new KeyboardEvent("keydown", { key: entry.key, code: entry.key, bubbles: true, cancelable: true });
        v.contentDOM.dispatchEvent(ev);
        if (!ev.defaultPrevented)
          v.dispatch(v.state.replaceSelection(""), { userEvent: "delete.selection", scrollIntoView: true });
      }
    });
  };
  onMount(() => {
    const m = cmNow();
    if (m) make(m);
    else
      void loadCm()
        .then(make)
        .catch((e) => console.error("code editor:", e));
  });
  onCleanup(() => {
    gone = true;
    ed()?.destroy();
  }); // 编辑器拆掉时关掉语言服务的虚拟文档
  // 换了语言：重新着色（语言服务的虚拟文档下次同步时换语言）
  createEffect(() => {
    const l = seg().lang;
    ed()?.setLang(l);
  });

  return (
    <div class="code freecode" style={{ "--nd": String(String(seg().start + seg().text.length - 1).length) }}>
      {/* CodeMirror 自己的容器（不和 Solid 管的东西放在一起：Solid 清空子节点时会把它一起清掉） */}
      <div ref={box} style={{ display: "contents" }} />
      <Show when={!ed()}>
        <div class="gutter">
          <For each={seg().text}>
            {(_, i) => (
              <span class="no" style={{ top: `calc(var(--code-pt) + ${i() * 20}px)` }}>
                {seg().start + i()}
              </span>
            )}
          </For>
        </div>
        <div class="src">
          <For each={seg().text}>{(t, i) => <div class="l" innerHTML={v0?.html[i()] ?? escHtml(t) ?? "​"} />}</For>
        </div>
      </Show>
    </div>
  );
}
