// 卡片外壳：位置、选中、拖动抬起、弹出动画、讲解变暗；按种类渲染内容。
import { send } from "../host";
import { createMemo, Show, Switch, Match, onMount, onCleanup, createEffect, For, type JSX } from "solid-js";
import {
  cardTitle, codeGlyph, versionLabel, fileCount, mixedVersions, langLabel, LANGS, domainOf,
  type Card, type CodeCard, type NoteCard, type ImageCard, type WebCard,
} from "@codeboard/core";
import { state, setSizes, isSel, flows, collapsedAway, sel, placeOf, rectOf } from "../state/store";
import { editing, dragging, popIn, walk, pingCard, dropTarget } from "../state/ui";
import { Icon } from "../ui/icons";
import { collapsedHome } from "../state/sections";
import { queueMeasure, observeResize } from "../state/measure";
import { CodeBody } from "./CodeBody";
import { CardStickers } from "../stickers/Picker";
import { lod } from "../state/camera";
import { CompareBody } from "./CompareBody";
import { NoteBody, TextToolbar } from "./NoteBody";
import { WebBody, LinksBody } from "./WebBody";
import { Editable } from "../ui/Editable";
import * as act from "../actions";

export function CardView(p: { card: Card }) {
  let el!: HTMLDivElement;
  const c = () => p.card;
  const read = () => {
    if (!el?.isConnected) return; // 卡被藏起来（折叠的 Section、折叠的子树）时不量：量到的是 0
    const id = c().id, w = el.offsetWidth, h = el.offsetHeight;
    return () => setSizes(id, { w, h });
  };
  onMount(() => onCleanup(observeResize(el, () => queueMeasure(read, read))));
  createEffect(() => {
    const pg = pingCard();
    if (pg?.id === c().id && el) { el.classList.remove("ping"); void el.offsetWidth; el.classList.add("ping"); }
  });
  const pop = () => popIn()[c().id];
  const pl = () => placeOf(c().id);
  const style = (): JSX.CSSProperties => {
    const s: JSX.CSSProperties = { left: `${pl().x}px`, top: `${pl().y}px`, width: `${pl().w}px` };
    if (pl().h) s.height = `${pl().h}px`;
    const pi = pop();
    if (pi?.slide) { s.transform = `translate(${(1 - pi.v) * pi.ox}px, ${(1 - pi.v) * pi.oy}px)`; s.transition = "none"; }
    else if (pi) { s.transform = `translate(${(1 - pi.v) * pi.ox}px, ${(1 - pi.v) * pi.oy}px) scale(${0.9 + 0.1 * pi.v})`; s.opacity = String(Math.min(1, pi.v * 1.8)); s.transition = "none"; }
    return s;
  };
  const dim = () => {
    const w = walk();
    if (!w) return false;
    const cur = w.order[w.i];
    const h = c();
    if (h.kind === "compare") return !h.cols.includes(cur);
    return c().id !== cur;
  };
  const kindClass = () => (c().kind === "note" ? ((c() as NoteCard).bg ? "note" : "text") : c().kind === "compare" ? "cmp" : c().kind === "code" ? "ccard" : c().kind);
  const drop = () => dropTarget();
  return (
    <Show when={!collapsedAway().has(c().id) && !collapsedHome(pl().section)}>
      <div ref={el} class={`card ${kindClass()}`} data-id={c().id} style={style()}
        classList={{
          sel: isSel(c().id), solo: sel.cards.length === 1, lift: dragging().has(c().id), dim: dim(), locked: !!pl().locked, autoh: !pl().h, nobg: act.noBg(c()),
          editing: editing()?.id === c().id,
          lost: c().kind === "code" && act.cardStale(c() as CodeCard) === "lost",
          "merge-hot": drop()?.kind === "merge" && drop()?.card === c().id && !!drop()?.armed,
          "merge-arm": drop()?.kind === "merge" && drop()?.card === c().id && !drop()?.armed,
          "drop-hot": drop()?.kind === "card" && drop()?.card === c().id,
          "drop-cand": !!drop()?.cands?.includes(c().id),
        }}
        onPointerDown={(e) => act.cardPointerDown(e, c().id)} onContextMenu={(e) => act.cardContextMenu(e, c().id)} onDblClick={(e) => act.cardDblClick(e, c().id)}>
        <Switch>
          <Match when={c().kind === "code"}><CodeCardView card={c() as CodeCard} /></Match>
          <Match when={c().kind === "note"}><NoteBody card={c() as NoteCard} /></Match>
          <Match when={c().kind === "image"}><ImageView card={c() as ImageCard} /></Match>
          <Match when={c().kind === "web" || c().kind === "links"}>{c().kind === "web" ? <WebBody card={c() as WebCard} /> : <LinksBody card={c() as any} />}</Match>
          <Match when={c().kind === "compare"}><CompareBody card={c() as any} /></Match>
        </Switch>
        {/* 拖动时由 .board.dragging 藏起来（CSS），不在每次拖动开始和结束时把几百张卡的圆点拆掉又建回来 */}
        <For each={["t", "r", "b", "l"] as const}>{(side) => <span class={`eport ${side}`} data-tip="Drag to link" onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); act.linkPortDown(e, { card: c().id }, r.left + r.width / 2, r.top + r.height / 2); }} />}</For>
        <Show when={c().kind === "note" && !(c() as NoteCard).bg}><TextToolbar card={c() as NoteCard} /></Show>
        <CardStickers card={c().id} />
        <Show when={lod() === "map"}><MapLabel card={c()} /></Show>
        <Show when={!pl().locked}>
          <Show when={c().kind === "note" && !(c() as NoteCard).bg} fallback={<div class="grip" data-tip="Drag to resize · Double-click to fit content" onPointerDown={(e) => act.resizeDown(e, c().id, { right: true, bottom: true })} onDblClick={(e) => { e.stopPropagation(); act.fitContent([c().id]); }} />}>
            <span class="hw l" onPointerDown={(e) => act.resizeDown(e, c().id, { left: true })} />
            <span class="hw r" onPointerDown={(e) => act.resizeDown(e, c().id, { right: true })} />
          </Show>
        </Show>
      </div>
    </Show>
  );
}

// ---------- 代码卡 ----------

export function CodeHead(p: { card: CodeCard; col?: boolean }) {
  const c = () => p.card;
  const node = createMemo(() => flows().byId.get(c().id));
  const hiddenKids = createMemo(() => (placeOf(c().id).collapsed && node() ? countDesc(node()!) : 0));
  const s0 = () => c().segments[0];
  const stale = createMemo(() => act.cardStale(c()));
  const mixed = () => mixedVersions(c());
  const multi = () => c().segments.length > 1;
  const free = () => s0()?.src.kind === "free";
  const notes = () => act.sidenotesOf(c().id).filter((n) => !n.at.lines);
  return (
    <div class="chead" data-drag>
      <Show when={node() && !state.board.hideNumbers}><span class="step" data-tip="Click: select subtree · Drag: move subtree">{node()!.label}</span></Show>
      <Show when={hiddenKids()}><button class="subc" data-tip="Expand Subtree" onPointerDown={(e) => e.stopPropagation()} onClick={() => act.toggleCollapse(c().id)}>▸ {hiddenKids()}</button></Show>
      <Show when={!p.col && placeOf(c().id).locked}><button class="lockb" data-tip="Unlock" data-kbd={act.K.lock} onPointerDown={(e) => e.stopPropagation()} onClick={() => act.toggleLock([c().id])}><Icon name="lock" /></button></Show>
      <span class="kind" classList={{ c: codeGlyph(c()) !== "ƒ" }}>{codeGlyph(c())}</span>
      <Show when={!free() || c().title || (editing()?.kind === "title" && editing()?.id === c().id)}>
        <Editable class="ctitle" kind="title" id={c().id} value={free() ? c().title ?? "" : cardTitle(c())} onCommit={(v) => act.renameCard(c().id, v)} />
      </Show>
      <Show when={c().title && c().segments.length > 1}><span class="plusn">+{c().mergedFrom ? c().mergedFrom!.length - 1 : 0 || ""}</span></Show>
      <Show when={free()} fallback={
        <span class="cpath" data-tip={multi() ? "Open First Segment in Editor" : "Open in Editor"} data-kbd="↵" onPointerDown={(e) => e.stopPropagation()} onClick={() => act.openCode(c().id)}>
          {multi() ? `${c().segments.length} segments${fileCount(c()) > 1 ? ` · ${fileCount(c())} files` : ""}` : `${shortPath(s0()?.path ?? "")}:${s0()?.start}`}
        </span>}>
        <button class="rev lang" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => act.langMenu(c().id, e.currentTarget)}>{langLabel(s0()?.lang ?? "python")} ▾</button>
      </Show>
      <span class="grow" />
      <Show when={notes().length}><button class="mk inline" onPointerDown={(e) => e.stopPropagation()} onPointerEnter={(e) => act.hoverMarker(e.currentTarget, notes().map((n) => n.id), e)} onClick={(e) => act.pinMarker(e.currentTarget, notes().map((n) => n.id))}>{notes().length}</button></Show>
      <Show when={!free()}>
        <button class="rev" classList={{ new: stale() === "changed" || stale() === "hidden", hollow: stale() === "hidden", lost: stale() === "lost" }}
          data-tip={stale() === "changed" ? "New version · View Diff" : stale() === "hidden" ? "Changes only in hidden lines" : "Pinned version"}
          onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (stale() === "changed" || stale() === "hidden" ? act.openDiff(c().id) : act.commitMenu(c().id, e.currentTarget))}>
          <Show when={stale() === "changed" || stale() === "hidden"}><i /></Show>
          {mixed() ? "Mixed versions" : versionLabel(s0()?.version)}
          <Show when={stale() !== "changed" && stale() !== "hidden" && s0()?.src.kind !== "github"}> ▾</Show>
        </button>
      </Show>
      <Show when={act.uncommitted(c()) || c().segments.some((s) => state.stale[s.id]?.state === "uncommitted")}>
        <button class="rev unc" data-tip="HEAD vs Working Tree" onPointerDown={(e) => e.stopPropagation()} onClick={() => act.openWorktreeDiff(c().id)}>+ uncommitted</button>
      </Show>
      <Show when={!p.col}><button class="ib" aria-label="Card Menu" data-tip="More Actions" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); act.cardMenu(c().id, r.left, r.bottom + 4); }}><Icon name="more" /></button></Show>
    </div>
  );
}

const countDesc = (n: { kids: any[] }): number => n.kids.reduce((s, k) => s + 1 + countDesc(k), 0);
export const shortPath = (p: string) => p.split("/").slice(-1)[0];

function CodeCardView(p: { card: CodeCard }) {
  const c = () => p.card;
  return (
    <>
      <CodeHead card={c()} />
      <Desc id={c().id} desc={c().desc} />
      <Show when={act.missingNote(c())}>
        <div class="cmiss" onPointerDown={(e) => e.stopPropagation()}>
          <span>{act.missingNote(c())}</span>
          <Show when={act.cardStale(c()) === "lost"}>
            <button onClick={() => send({ type: "relocate", card: c().id })}>Relocate…</button>
            <button onClick={() => act.keepLost(c().id)}>Keep Old Version</button>
          </Show>
          <Show when={act.cardStale(c()) === "missing"}><button onClick={() => send({ type: "locateRepo" })}>Locate Repo…</button></Show>
        </div>
      </Show>
      <Show when={c().members} fallback={<CodeBody card={c()} hostId={c().id} />}>
        <ClassBody card={c()} />
      </Show>
      <Show when={c().segments[0]?.src.kind === "free" && c().segments[0]?.src.kind === "free" && (c().segments[0].src as any).url}>
        <div class="cfoot"><span>Source</span><a class="lnk" onPointerDown={(e) => e.stopPropagation()} onClick={() => act.openLink((c().segments[0].src as any).url)}>{(c().segments[0].src as any).url}</a></div>
      </Show>
    </>
  );
}

/** 类卡：只列成员签名，点成员 → 展开成函数卡并连 Call link */
function ClassBody(p: { card: CodeCard }) {
  const s = () => p.card.segments[0];
  const defs = () => (state.views[s().id]?.defs ?? []).filter((d) => d.qual.split(".").length === (s().symbol?.qual.split(".").length ?? 0) + 1);
  const shown = () => defs().filter((d) => p.card.members!.shown.length === 0 || p.card.members!.shown.includes(d.qual));
  const more = () => defs().length - shown().length;
  const sig = (line: number) => (s().text[line - s().start] ?? "").trim().replace(/:\s*$/, "");
  return (
    <div class="cbody">
      <div class="members">
        <For each={shown()}>
          {(d) => (
            <div class="mrow">
              <span class="no">{d.line}</span>
              <span class="msig"><span class="call" onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); act.expandMember(p.card.id, d); }}>{d.name}</span>{sig(d.line).replace(/^.*?\bdef\s+\w+/, "")}</span>
            </div>
          )}
        </For>
        <Show when={more() > 0}><button class="more" onPointerDown={(e) => e.stopPropagation()} onClick={() => act.showAllMembers(p.card.id)}>+ {more()} more method{more() > 1 ? "s" : ""}</button></Show>
      </div>
    </div>
  );
}

export function Desc(p: { id: string; desc?: string }) {
  return (
    <Show when={p.desc || editing()?.kind === "desc" && editing()?.id === p.id}>
      <Editable class="cdesc" kind="desc" id={p.id} value={p.desc ?? ""} multiline md onCommit={(v) => act.setDesc(p.id, v)} />
    </Show>
  );
}

// ---------- 图片 / 网页 ----------

function ImageView(p: { card: ImageCard }) {
  const src = () => (p.card.src.startsWith("data:") || /^https?:/.test(p.card.src) ? p.card.src : `${state.host.assetBase}/${p.card.src}`);
  return (
    <>
      <div class="chead" data-drag><span class="kind"><Icon name="image" size={13} /></span><Editable class="ctitle" kind="title" id={p.card.id} value={cardTitle(p.card)} onCommit={(v) => act.renameCard(p.card.id, v)} /><span class="grow" />
        <button class="ib" aria-label="Card Menu" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); act.cardMenu(p.card.id, r.left, r.bottom + 4); }}><Icon name="more" /></button></div>
      <Desc id={p.card.id} desc={p.card.desc} />
      <div class="imgb"><img src={src()} alt={p.card.alt ?? ""} draggable={false} /></div>
    </>
  );
}

/** 地图档：卡片只剩编号 + 名字，字号按缩放反向放大，始终看得清 */
function MapLabel(p: { card: Card }) {
  const n = () => flows().byId.get(p.card.kind === "compare" ? p.card.cols[0] : p.card.id)?.label;
  const t = () => (p.card.kind === "note" ? p.card.md.split("\n")[0].replace(/^#+\s*/, "").slice(0, 60) : cardTitle(p.card, state.board));
  // 名字只在 . 和 _ 后面换行，不在单词中间断开
  const parts = () => t().split(/(?<=[._])/);
  // 一行放得下的字号：宽 / (字数 × 平均字宽)，高度最多占 45%
  const fit = () => {
    const r = rectOf(p.card);
    const chars = t().length + (n() ? n()!.length + 2 : 0);
    return `${Math.max(1, Math.min((r.w - 24) / (Math.max(chars, 4) * 0.58), r.h * 0.45))}px`;
  };
  return (
    <div class="maplabel" style={{ "--fit": fit() }}>
      <Show when={n() && !state.board.hideNumbers}><span class="step">{n()}</span></Show>
      <span class="mt"><For each={parts()}>{(x) => <>{x}<wbr /></>}</For></span>
    </div>
  );
}

export { LANGS };
