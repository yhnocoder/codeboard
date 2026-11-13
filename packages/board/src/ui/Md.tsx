// 静态 Markdown：缓存好的 HTML 直接放进去，挂上以后补引用 / 图表；点链接、[[引用]]、勾选框
import { createEffect, onCleanup, type JSX } from "solid-js";
import type { MdLayout, RefTarget } from "@yhnocoder/markdown";
import { mdInto, mdForget } from "../md/lazy";
import { mathRev } from "../md/math";
import { useMd } from "../md/context";
import { prepareHover, prepareLeave } from "../md/load";
import * as A from "../actions";
import { attachAnims, detachAnims } from "../md/anim";

const openRef = (id: string, to: RefTarget) => A.clickToCardRef(id, to.place);

export function MdStatic(p: {
  src: string;
  layout?: MdLayout | null;
  class?: string;
  style?: JSX.CSSProperties | string;
  ph?: string;
  tip?: string;
  inline?: boolean;
  onToggle?: (next: string) => void;
  onDblClick?: (e: MouseEvent) => void;
  /** 能双击编辑的：鼠标停上来就先在页面外准备好编辑器 */
  prep?: boolean;
  /** A Note's body (its card id): animated images in it are drawn as players (md/anim.ts) */
  anims?: string;
  /** A click on a [[reference]] or a link to an item (el) to `to`: true when it took the click (a card's preview), else the
   *  board goes there */
  onRef?: (to: RefTarget, el: HTMLElement) => boolean;
  /** Only drawn, nothing in it pressed (the text a Note shows until its editor has loaded): a click on a reference in it would
   *  go to the card, or open another board, in the middle of a double-click that is starting the editing */
  inert?: boolean;
}) {
  const md = useMd();
  let el!: HTMLDivElement;
  createEffect(() => {
    mathRev();
    const card = p.anims;
    mdInto(md, el, p.src, p.inline, p.layout, card ? (box) => attachAnims(box, card) : undefined);
  });
  onCleanup(() => {
    mdForget(el);
    detachAnims(el);
  });
  return (
    <div
      ref={el}
      class={`${p.class ?? ""} md`}
      style={p.style}
      data-ph={p.ph}
      data-tip={p.tip}
      inert={p.inert}
      onClick={(e) =>
        !p.inert &&
        md.click(e, p.src, {
          openLink: (url) => A.openMdLink(url, md),
          // a reference, or a link to an item (Copy Link): the page's preview when it takes it; ⌘-click goes there
          openRef: (id, to) => {
            const r = (e.target as Element).closest<HTMLElement>(".md-ref, .md-cardlink"),
              go = e.metaKey || e.ctrlKey;
            if (!(r && !go && p.onRef?.(to, r))) openRef(id, to);
          },
          onToggle: p.onToggle,
        })
      }
      onDblClick={p.onDblClick}
      // resting on a link shows its whole address (a long one is drawn as its site); a link to a card shows nothing, its click
      // previews the card
      onPointerOver={(e) => {
        const a = (e.target as Element).closest?.<HTMLElement>("a.md-link[data-href]:not(.md-cardlink)");
        if (a && !a.dataset.tip) {
          a.dataset.tip = a.dataset.href;
          a.setAttribute("data-tip-long", "");
        }
      }}
      onPointerEnter={p.prep ? () => prepareHover(md, p.src, p.layout) : undefined}
      onPointerLeave={p.prep ? () => prepareLeave(p.src) : undefined}
      onPointerDown={p.prep ? () => prepareHover(md, p.src, p.layout, true) : undefined}
    />
  );
}
