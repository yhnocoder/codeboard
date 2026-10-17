// 静态 Markdown：缓存好的 HTML 直接放进去，挂上以后补引用 / 图表；点链接、[[引用]]、勾选框
import { createEffect } from "solid-js";
import { renderMd, hydrate, mdClick } from "../md/view";
import { renderMdInline } from "../md/render";
import * as A from "../actions";

const openRef = (id: string) => { A.selectCard(id); A.revealCard(id); };

export function MdStatic(p: { src: string; class?: string; style?: any; ph?: string; tip?: string; inline?: boolean; onToggle?: (next: string) => void; onDblClick?: (e: MouseEvent) => void }) {
  let el!: HTMLDivElement;
  const html = () => (p.inline ? renderMdInline(p.src) : renderMd(p.src));
  createEffect(() => { const h = html(); el.innerHTML = h; hydrate(el, h); });
  return <div ref={el} class={`${p.class ?? ""} md`} style={p.style} data-ph={p.ph} data-tip={p.tip}
    onClick={(e) => mdClick(e, p.src, { openLink: A.openLink, openRef, onToggle: p.onToggle })} onDblClick={p.onDblClick} />;
}
