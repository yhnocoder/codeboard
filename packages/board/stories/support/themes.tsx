// 「Themes」：同一张卡（这一组里的一个 story）在几个主题下并排。主题挂在整页的根上（themes.css 的 :root.look-*），
// 一页里放不下两个主题，所以每个主题一个 iframe，打开的是那个 story 本身，只换 globals 里的主题
import { For, onCleanup } from "solid-js";
import { THEMES } from "@codeboard/core";
import type { Globals } from "./board";
import { waitFor } from "./play";

/** 并排的主题：常用的这五个 */
export const SIDE_THEMES = ["warm-ink", "graphite", "soft-light", "drafting", "ink-wash"] as const;
const PAD = 24;

function Frame(p: { id: string; theme: string; globals: Globals }) {
  let frame!: HTMLIFrameElement, box!: HTMLDivElement;
  let ro: ResizeObserver | undefined;
  const g = p.globals;
  const src = `iframe.html?id=${p.id}&viewMode=story&globals=theme:${p.theme};scheme:${g.scheme};zoom:${g.zoom}`;
  // 只露出卡片（连同 Section、贴纸）那一块：iframe 大到装下它们，外面的框裁到它们四周留 PAD，白板标题之类的留在框外
  const fit = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    let l = Infinity,
      t = Infinity,
      r = 0,
      b = 0;
    for (const e of doc.querySelectorAll(".card, .sec, .sticker")) {
      const k = e.getBoundingClientRect();
      l = Math.min(l, k.left);
      t = Math.min(t, k.top);
      r = Math.max(r, k.right);
      b = Math.max(b, k.bottom);
    }
    if (!r) return;
    frame.style.width = `${Math.ceil(r + PAD)}px`;
    frame.style.height = `${Math.ceil(b + PAD)}px`;
    frame.style.translate = `${Math.floor(PAD - l)}px ${Math.floor(PAD - t)}px`;
    box.style.width = `${Math.ceil(r - l + 2 * PAD)}px`;
    box.style.height = `${Math.ceil(b - t + 2 * PAD)}px`;
    frame.dataset.ready = "";
  };
  const load = () => {
    const win = frame.contentWindow as (Window & typeof globalThis) | null;
    if (!win) return;
    ro?.disconnect();
    // 卡是渲染完才挂上的，之后量好大小、字体到了还会变：盯着画布里的变化重量
    ro = new win.ResizeObserver(fit);
    const watch = () => {
      for (const e of win.document.querySelectorAll(".card")) ro!.observe(e);
      fit();
    };
    new win.MutationObserver(watch).observe(win.document.body, { childList: true, subtree: true });
    watch();
  };
  onCleanup(() => ro?.disconnect());
  return (
    <figure style={{ margin: 0, display: "flex", "flex-direction": "column", gap: "6px" }}>
      <figcaption style={{ font: "500 12px var(--sys)", color: "var(--ink-3)", "letter-spacing": ".02em" }}>
        {THEMES.find(([t]) => t === p.theme)?.[1]}
      </figcaption>
      <div
        ref={box}
        style={{
          width: "480px",
          height: "320px",
          overflow: "hidden",
          "border-radius": "10px",
          "box-shadow": "0 0 0 1px var(--hair)",
        }}
      >
        <iframe
          ref={frame}
          src={src}
          title={p.theme}
          onLoad={load}
          style={{ display: "block", width: "480px", height: "320px", border: "0" }}
        />
      </div>
    </figure>
  );
}

/** export const Themes: Story = themes("python");  of：要并排的那个 story 的 id 后半（Python → python）；放在 Overview 后面，侧栏里就排在它下面 */
export const themes = (of: string) => ({
  name: "Themes",
  render: (_: unknown, ctx: { id: string; globals: unknown }) => (
    <div
      style={{ display: "flex", "flex-wrap": "wrap", gap: "24px", padding: `${PAD}px`, "align-items": "flex-start" }}
    >
      <For each={SIDE_THEMES}>
        {(t) => <Frame id={ctx.id.replace(/--[^-]+$/, `--${of}`)} theme={t} globals={ctx.globals as Globals} />}
      </For>
    </div>
  ),
  argTypes: {},
  parameters: { controls: { disable: true } },
  // 几个 iframe 都画好了才算这个 story 渲染完：不然换下一个 story 时它们还在加载，请求被中途掐掉
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const all = () => [...canvasElement.querySelectorAll<HTMLIFrameElement>("iframe")];
    await waitFor(
      () => all().length === SIDE_THEMES.length && all().every((f) => f.dataset.ready !== undefined),
      "every theme drawn",
      25000,
    );
  },
});
