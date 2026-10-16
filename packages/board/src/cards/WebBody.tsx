// Web 卡（书签样式：标题 + 两行描述 + 图标和域名，右侧预览图）和 Link List（每行 favicon + 标题 + 域名，可展开成小书签）。
// 抓不全时缺什么收什么：没图 → 没有右栏；只有标题 → 标题 + 域名；什么都没有 → 域名首字母方块 + 域名当标题 + 路径 + Retry / Edit Title。
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { cardTitle, domainOf, urlPath, type LinkItem, type LinksCard, type WebCard, type WebMeta } from "@codeboard/core";
import { editing, setEditing } from "../state/ui";
import { Editable } from "../ui/Editable";
import { Icon } from "../ui/icons";
import * as A from "../actions";
import "./web.css";

const stop = (e: Event) => e.stopPropagation();

/** favicon；拿不到用域名首字母方块 */
function Fav(p: { meta?: WebMeta; url: string; big?: boolean }) {
  const [bad, setBad] = createSignal(false);
  const src = () => A.assetSrc(p.meta?.icon);
  return (
    <Show when={src() && !bad()} fallback={<span class="wfav ini" classList={{ big: p.big }}>{(domainOf(p.url)[0] ?? "?").toUpperCase()}</span>}>
      <img class="wfav" classList={{ big: p.big }} src={src()} alt="" draggable={false} onError={() => setBad(true)} />
    </Show>
  );
}

/** 一张书签：Web 卡的正文，也是 Link List 的 Rich 行 / 悬停预览 */
export function Bookmark(p: {
  url: string; meta?: WebMeta; title?: string; desc?: string; editId?: string; small?: boolean; drag?: boolean;
  onTitle?: (v: string) => void; onDesc?: (v: string) => void; onRetry?: () => void; busy?: boolean;
}) {
  const [imgBad, setImgBad] = createSignal(false);
  // 图的形状（加载后量）：横图（比 1.4:1 还宽）单独一张卡时放在上面当横幅，整张显示；方图 / 竖图还放右栏
  const [wide, setWide] = createSignal(false);
  const title = () => p.title || p.meta?.title;
  const desc = () => p.desc ?? p.meta?.desc;
  const site = () => p.meta?.site && !domainOf(p.url).includes(p.meta.site.toLowerCase()) ? `${domainOf(p.url)} · ${p.meta.site}` : domainOf(p.url);
  const img = () => (imgBad() ? undefined : A.assetSrc(p.meta?.image));
  const loading = () => !!p.busy;
  const none = () => !title() && !desc();
  const eid = () => p.editId ?? "";
  const editingDesc = () => editing()?.kind === "desc" && editing()?.id === eid();
  return (
    <div class="wbm" classList={{ small: p.small, none: none(), wbanner: wide() && !p.small && !!img() }} data-drag={p.drag ? "" : undefined}>
      <div class="wmain">
        <Show when={!none()} fallback={
          <>
            <div class="wtitle wnone"><Fav meta={p.meta} url={p.url} big />
              <Show when={p.onTitle} fallback={<span class="wt">{domainOf(p.url)}</span>}>
                <Editable class="wt" kind="title" id={eid()} value={title() || domainOf(p.url)} onCommit={(v) => p.onTitle!(v)} />
              </Show>
            </div>
            <Show when={urlPath(p.url)}><div class="wpath" data-tip={p.url}>{urlPath(p.url)}</div></Show>
            <Show when={editingDesc()}><Editable class="wdesc" kind="desc" id={eid()} value="" multiline onCommit={(v) => p.onDesc?.(v)} /></Show>
            <Show when={!p.small}>
              <div class="wacts2" onPointerDown={stop}>
                <Show when={loading()} fallback={<>
                  <button class="wlink" onClick={() => p.onRetry?.()}>↻ Retry</button><span class="wsep">·</span>
                  <button class="wlink" onClick={() => setEditing({ kind: "title", id: eid() })}>✎ Edit Title</button>
                </>}><span class="wmuted">Fetching preview…</span></Show>
              </div>
            </Show>
          </>
        }>
          <div class="wtitle">
            <Show when={p.onTitle} fallback={<span class="wt">{title() || domainOf(p.url)}</span>}>
              <Editable class="wt" kind="title" id={eid()} value={title() || domainOf(p.url)} onCommit={(v) => p.onTitle!(v)} />
            </Show>
          </div>
          <Show when={desc() || editingDesc()}>
            <Show when={p.onDesc} fallback={<div class="wdesc">{desc()}</div>}>
              <Editable class="wdesc" kind="desc" id={eid()} value={desc() ?? ""} multiline onCommit={(v) => p.onDesc!(v)} />
            </Show>
          </Show>
          <div class="wsite" data-tip={p.url}><Fav meta={p.meta} url={p.url} /><span>{site()}</span></div>
        </Show>
      </div>
      <Show when={img()}><div class="wimg"><img src={img()} alt="" draggable={false} onError={() => setImgBad(true)}
        onLoad={(e) => { const i = e.currentTarget; setWide(i.naturalWidth > i.naturalHeight * 1.4); }} /></div></Show>
    </div>
  );
}

// ---------- Web 卡 ----------

export function WebBody(p: { card: WebCard }) {
  const c = () => p.card;
  const menu = (e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); A.cardMenu(c().id, r.left, r.bottom + 4); };
  return (
    <>
      <Bookmark url={c().url} meta={c().meta} title={c().title} desc={c().desc} editId={c().id} drag busy={A.fetching(c().id)}
        onTitle={(v) => A.renameCard(c().id, v)} onDesc={(v) => A.setDesc(c().id, v)} onRetry={() => A.retryMeta(c().id)} />
      <div class="wacts" onPointerDown={stop}>
        <button class="ib" aria-label="Open in Browser" data-tip="Open in Browser" data-kbd="Double-click" onClick={() => A.openLink(c().url)}><Icon name="external" size={13} /></button>
        <button class="ib more" aria-label="Card Menu" data-tip="More Actions" onClick={menu}><Icon name="more" size={14} /></button>
      </div>
    </>
  );
}

// ---------- Link List ----------

export function LinksBody(p: { card: LinksCard }) {
  const c = () => p.card;
  const menu = (e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); A.cardMenu(c().id, r.left, r.bottom + 4); };
  const drag = () => { const d = A.rowDrag(); return d?.card === c().id ? d : null; };
  return (
    <>
      <div class="chead" data-drag>
        <span class="kind"><Icon name="link" size={13} /></span>
        <Editable class="ctitle sys" kind="title" id={c().id} value={cardTitle(c())} onCommit={(v) => A.renameCard(c().id, v)} />
        <span class="lcount">{c().items.length}</span>
        <span class="grow" />
        <button class="ib" aria-label="Card Menu" data-tip="More Actions" onPointerDown={stop} onClick={menu}><Icon name="more" /></button>
      </div>
      <div class="lrows" classList={{ dragging: !!drag() }}>
        <For each={c().items}>{(it, i) => (
          <LinkRow card={c()} item={it} dropBefore={!!drag() && !drag()!.out && drag()!.index === i()} dropAfter={!!drag() && !drag()!.out && i() === c().items.length - 1 && drag()!.index === c().items.length} />
        )}</For>
      </div>
      <Show when={drag()}>
        <Portal><div class="lghost" classList={{ out: drag()!.out }} style={{ left: `${drag()!.x + 12}px`, top: `${drag()!.y + 10}px` }}>{drag()!.out ? "Move out as card · " : ""}{drag()!.label}</div></Portal>
      </Show>
    </>
  );
}

function LinkRow(p: { card: LinksCard; item: LinkItem; dropBefore: boolean; dropAfter: boolean }) {
  const it = () => p.item;
  const rich = () => A.isRich(p.card, it());
  const key = () => `${p.card.id}/${it().id}`;
  const title = () => it().title || it().meta?.title || domainOf(it().url);
  const dragged = () => A.rowDrag()?.item === it().id;
  // 悬停 Compact 行一会儿：旁边浮出完整书签
  const [peek, setPeek] = createSignal<{ x: number; y: number } | null>(null);
  let el!: HTMLDivElement, t: number | undefined;
  const enter = () => {
    if (rich() || A.rowDrag()) return;
    clearTimeout(t);
    t = window.setTimeout(() => {
      if (!el?.isConnected || A.rowDrag() || editing()) return;
      const r = el.getBoundingClientRect(), cr = (el.closest(".card") as HTMLElement).getBoundingClientRect();
      const W = window.innerWidth;
      const x = cr.right + 10 + 340 < W ? cr.right + 10 : Math.max(8, cr.left - 350);
      setPeek({ x, y: Math.max(8, Math.min(r.top - 8, window.innerHeight - 170)) });
    }, 550);
  };
  const leave = () => { clearTimeout(t); setPeek(null); };
  onCleanup(() => clearTimeout(t));
  return (
    <div ref={el} class="lrow" classList={{ rich: rich(), "drop-before": p.dropBefore, "drop-after": p.dropAfter, dragged: dragged() }}
      onPointerEnter={enter} onPointerLeave={leave} onPointerDown={leave}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); leave(); A.rowMenu(p.card.id, it().id, e.clientX, e.clientY); }}
      onDblClick={(e) => { if ((e.target as HTMLElement).closest("button, [contenteditable]")) return; A.openLink(it().url); }}>
      <span class="lgrip" data-tip="Drag to reorder · drag out to split" onPointerDown={(e) => { leave(); A.rowGripDown(e, p.card.id, it().id); }}>⋮⋮</span>
      <Show when={rich()} fallback={
        <div class="lcompact">
          <Fav meta={it().meta} url={it().url} />
          <Editable class="lt" kind="title" id={key()} value={title()} onCommit={(v) => A.renameItem(p.card.id, it().id, v)} />
          <span class="ld" data-tip={it().url}>{domainOf(it().url)}</span>
        </div>
      }>
        <Bookmark url={it().url} meta={it().meta} title={it().title} editId={key()} small busy={A.fetching(key())}
          onTitle={(v) => A.renameItem(p.card.id, it().id, v)} onRetry={() => A.retryMeta(p.card.id, it().id)} />
      </Show>
      <div class="ltools" onPointerDown={stop}>
        <button class="lb" aria-label={rich() ? "Show as Compact" : "Show as Rich"} data-tip={rich() ? "Show as Compact" : "Show as Rich"} onClick={() => A.toggleItemRich(p.card.id, it().id)}><Icon name={rich() ? "compact" : "rich"} size={12} /></button>
        <button class="lb" aria-label="Open in Browser" data-tip="Open in Browser" onClick={() => A.openLink(it().url)}><Icon name="external" size={12} /></button>
        <button class="lb" aria-label="Remove from List" data-tip="Remove from List" onClick={() => A.removeItem(p.card.id, it().id)}><Icon name="close" size={12} /></button>
      </div>
      <Show when={peek()}>
        <Portal><div class="lpeek" style={{ left: `${peek()!.x}px`, top: `${peek()!.y}px` }}><Bookmark url={it().url} meta={it().meta} title={it().title} /></div></Portal>
      </Show>
    </div>
  );
}
