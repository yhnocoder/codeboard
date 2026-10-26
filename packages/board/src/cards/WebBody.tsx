// 抓不全时缺什么收什么：没图 → 没有右栏；只有标题 → 标题 + 域名；什么都没有 → 域名首字母方块 + 域名当标题 + 路径 + Retry / Edit Title。
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { cardTitle, domainOf, urlPath, type LinkItem, type LinksCard, type WebCard, type WebMeta, type WebStyle } from "@codeboard/core";
import { editing, setEditing } from "../state/ui";
import { Editable } from "../ui/Editable";
import { Icon } from "../ui/icons";
import { place, virtual } from "@yhnocoder/markdown/ui";
import { below } from "../ui/Menu";
import * as A from "../actions";
import "./web.css";
import { fetching, rowDrag } from "../state/web";

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
function Bookmark(p: {
  url: string; meta?: WebMeta; title?: string; desc?: string; editId?: string; small?: boolean; drag?: boolean; style?: WebStyle;
  onTitle?: (v: string) => void; onDesc?: (v: string) => void; onRetry?: () => void; busy?: boolean;
}) {
  const [imgBad, setImgBad] = createSignal(false);
  // 图的形状（加载后量）：横图（比 1.4:1 还宽）单独一张卡时放在上面当横幅，整张显示；方图 / 竖图还放右栏
  const [wide, setWide] = createSignal(false);
  const title = () => p.title || p.meta?.title;
  const desc = () => p.desc ?? p.meta?.desc;
  const site = () => p.meta?.site && !domainOf(p.url).includes(p.meta.site.toLowerCase()) ? `${domainOf(p.url)} · ${p.meta.site}` : domainOf(p.url);
  const img = () => (imgBad() || p.style === "text" || p.style === "compact" ? undefined : A.assetSrc(p.meta?.image));
  const banner = () => !p.small && !!img() && (p.style === "banner" || (!p.style && wide()));
  const loading = () => !!p.busy;
  const none = () => !title() && !desc();
  const eid = () => p.editId ?? "";
  const editingDesc = () => editing()?.kind === "desc" && editing()?.id === eid();
  return (
    <div class="wbm" classList={{ small: p.small, none: none(), wbanner: banner(), wcompact: p.style === "compact" && !none() }} data-drag={p.drag ? "" : undefined}>
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
              <div class="wacts2" data-nodrag>
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
          <Show when={(desc() && p.style !== "compact") || editingDesc()}>
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

export function WebBody(p: { card: WebCard }) {
  const c = () => p.card;
  const menu = (e: MouseEvent) => A.cardMenu(c().id, ...below(e.currentTarget as Element));
  return (
    <>
      <Bookmark url={c().url} meta={c().meta} title={c().title} desc={c().desc} editId={c().id} drag busy={fetching(c().id)} style={c().style}
        onTitle={(v) => A.renameCard(c().id, v)} onDesc={(v) => A.setDesc(c().id, v)} onRetry={() => A.retryMeta(c().id)} />
      <div class="wacts" data-nodrag>
        <button class="ib" aria-label="Open in Browser" data-tip="Open in Browser" data-kbd="Double-click" onClick={() => A.openLink(c().url)}><Icon name="external" size={13} /></button>
        <button class="ib more" aria-label="Card Menu" data-export="strip" data-tip="More Actions" onClick={menu}><Icon name="more" size={14} /></button>
      </div>
    </>
  );
}

export function LinksBody(p: { card: LinksCard }) {
  const c = () => p.card;
  const menu = (e: MouseEvent) => A.cardMenu(c().id, ...below(e.currentTarget as Element));
  const drag = () => { const d = rowDrag(); return d?.card === c().id ? d : null; };
  return (
    <>
      <div class="chead" data-drag>
        <span class="kind"><Icon name="link" size={13} /></span>
        <Editable class="ctitle sys" kind="title" id={c().id} value={cardTitle(c())} onCommit={(v) => A.renameCard(c().id, v)} />
        <span class="lcount">{c().items.length}</span>
        <span class="grow" />
        <button class="ib" aria-label="Card Menu" data-tip="More Actions" data-nodrag data-export="strip" onClick={menu}><Icon name="more" /></button>
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
  const dragged = () => rowDrag()?.item === it().id;
  // 悬停 Compact 行一会儿：旁边浮出完整书签
  const [peek, setPeek] = createSignal(false);
  const [peekPos, setPeekPos] = createSignal<{ x: number; y: number } | null>(null);
  let el!: HTMLDivElement, t: number | undefined;
  const enter = () => {
    if (rich() || rowDrag()) return;
    clearTimeout(t);
    t = window.setTimeout(() => { if (el?.isConnected && !rowDrag() && !editing()) setPeek(true); }, 550);
  };
  // 卡片右边、和这一行齐平（右边放不下翻到左边）：锚点是卡片在这一行高度上的那一条
  const placePeek = (pe: HTMLElement) => {
    const r = el.getBoundingClientRect(), cr = (el.closest(".card") as HTMLElement).getBoundingClientRect();
    void place(pe, virtual({ x: cr.left, y: r.top, width: cr.width, height: r.height }), "right-start", { gap: { mainAxis: 10, crossAxis: -8 }, strategy: "fixed" })
      .then(({ x, y }) => { if (peek()) setPeekPos({ x, y }); });
  };
  const leave = () => { clearTimeout(t); setPeek(false); setPeekPos(null); };
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
        <Bookmark url={it().url} meta={it().meta} title={it().title} editId={key()} small busy={fetching(key())}
          onTitle={(v) => A.renameItem(p.card.id, it().id, v)} onRetry={() => A.retryMeta(p.card.id, it().id)} />
      </Show>
      <div class="ltools" data-nodrag>
        <button class="lb" aria-label={rich() ? "Show as Compact" : "Show as Rich"} data-tip={rich() ? "Show as Compact" : "Show as Rich"} onClick={() => A.toggleItemRich(p.card.id, it().id)}><Icon name={rich() ? "compact" : "rich"} size={12} /></button>
        <button class="lb" aria-label="Open in Browser" data-tip="Open in Browser" onClick={() => A.openLink(it().url)}><Icon name="external" size={12} /></button>
        <button class="lb" aria-label="Remove from List" data-tip="Remove from List" onClick={() => A.removeItem(p.card.id, it().id)}><Icon name="close" size={12} /></button>
      </div>
      <Show when={peek()}>
        <Portal><div ref={(e) => queueMicrotask(() => placePeek(e))} class="lpeek" style={{ left: `${peekPos()?.x ?? 0}px`, top: `${peekPos()?.y ?? 0}px`, visibility: peekPos() ? undefined : "hidden" }}><Bookmark url={it().url} meta={it().meta} title={it().title} /></div></Portal>
      </Show>
    </div>
  );
}
