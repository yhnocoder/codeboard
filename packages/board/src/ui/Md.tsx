// 静态 Markdown：缓存好的 HTML 直接放进去，挂上以后补引用 / 图表；点链接、[[引用]]、勾选框
import { createEffect, onCleanup } from "solid-js";
import { mdClick } from "@codeboard/markdown";
import { mdInto, mdForget } from "../md/lazy";
import { prepareHover, prepareLeave } from "../md/load";
import * as A from "../actions";

const openRef = (id: string) => { A.selectCard(id); A.revealCard(id); };

export function MdStatic(p: { src: string; class?: string; style?: any; ph?: string; tip?: string; inline?: boolean; onToggle?: (next: string) => void; onDblClick?: (e: MouseEvent) => void;
  /** 能双击编辑的：鼠标停上来就先在页面外准备好编辑器 */
  prep?: boolean }) {
  let el!: HTMLDivElement;
  createEffect(() => mdInto(el, p.src, p.inline));
  onCleanup(() => mdForget(el));
  return <div ref={el} class={`${p.class ?? ""} md`} style={p.style} data-ph={p.ph} data-tip={p.tip}
    onClick={(e) => mdClick(e, p.src, { openLink: A.openLink, openRef, onToggle: p.onToggle })} onDblClick={p.onDblClick}
    onPointerEnter={p.prep ? () => prepareHover(p.src) : undefined} onPointerLeave={p.prep ? () => prepareLeave(p.src) : undefined}
    onPointerDown={p.prep ? () => prepareHover(p.src, true) : undefined} />;
}
