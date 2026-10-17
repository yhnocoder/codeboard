// 卡片外壳：位置、选中、拖动抬起、弹出动画、讲解变暗；按种类渲染内容。
import { send } from "../host";
import { createMemo, createSignal, Show, Switch, Match, onMount, onCleanup, createEffect, For, type JSX } from "solid-js";
import {
  cardTitle, codeGlyph, versionLabel, fileCount, mixedVersions, langLabel, LANGS, descendants,
  type Card, type CodeCard, type NoteCard, type ImageCard, type WebCard, type Graph, type LinkSide,
} from "@codeboard/core";
import { state, setSizes, isSel, flows, collapsedAway, collapsedSet, sel, placeOf, rectOf } from "../state/store";
import { Glyph } from "../stickers/glyphs";
import { editing, dragging, popIn, walk, pingCard, dropTarget } from "../state/ui";
import { Icon } from "../ui/icons";
import { collapsedHome } from "../state/sections";
import { queueMeasure, observeResize } from "../state/measure";
import { CodeBody } from "./CodeBody";
import { CardStickers, BoundStickers } from "../stickers/Picker";
import { fileHue } from "../state/look";
import { CompareBody } from "./CompareBody";
import { NoteBody, TextToolbar } from "./NoteBody";
import { WebBody, LinksBody } from "./WebBody";
import { Editable } from "../ui/Editable";
import * as act from "../actions";
import { offscreen } from "../state/cull";
import { lodOf, izOf } from "../state/lodcards";
import { whenIdle } from "../state/idle";

const EPORT_SIDE: Record<"t" | "r" | "b" | "l", LinkSide> = { t: "top", r: "right", b: "bottom", l: "left" };

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
  const [labelReady, setLabelReady] = createSignal(false);
  onMount(() => whenIdle(() => setLabelReady(true)));
  const pop = () => popIn()[c().id];
  const pl = () => placeOf(c().id);
  const style = (): JSX.CSSProperties => {
    const s: JSX.CSSProperties = { left: `${pl().x}px`, top: `${pl().y}px`, width: `${pl().w}px` };
    if (pl().h && c().kind !== "code") s.height = `${pl().h}px`; // 代码卡的高度给内容区（.carea），卡头 / 底栏按主题撑开
    if (lodOf(c().id) === "map") (s as Record<string, string>)["--iz"] = String(izOf(c().id));
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
  // 拖动中的卡、落点是所有卡共用的信号：直接写进 classList 的话，它们一变，241 张卡的整个 classList 都要重算一遍（松手那一帧 ~5ms）。
  // 先算成这张卡自己的真假，只有值真变了的那张卡才重算 classList
  const lift = createMemo(() => dragging().has(c().id));
  const drop = createMemo(() => {
    const d = dropTarget(), id = c().id;
    if (!d) return 0;
    const m = d.kind === "merge" && d.card === id;
    return (m && d.armed ? 1 : 0) | (m && !d.armed ? 2 : 0) | (d.kind === "card" && d.card === id ? 4 : 0) | (d.cands?.includes(id) ? 8 : 0);
  });
  return (
    <Show when={!collapsedAway().has(c().id) && !collapsedHome(pl().section)}>
      <div ref={el} class={`card ${kindClass()}`} data-id={c().id} data-fc={c().kind === "code" ? fileHue((c() as CodeCard).segments[0]?.path) : undefined} style={style()}
        classList={{
          sel: isSel(c().id), solo: sel.cards.length === 1, lift: lift(), dim: dim(), locked: !!pl().locked, autoh: !pl().h, nobg: act.noBg(c()),
          editing: editing()?.id === c().id, off: offscreen(c().id), "lo-ov": lodOf(c().id) === "overview", "lo-map": lodOf(c().id) === "map",
          lost: c().kind === "code" && act.cardStale(c() as CodeCard) === "lost",
          "merge-hot": !!(drop() & 1), "merge-arm": !!(drop() & 2), "drop-hot": !!(drop() & 4), "drop-cand": !!(drop() & 8),
          "bind-hot": (act.bindHot() as { card?: string } | null)?.card === c().id,
          "bind-anchor": act.boundCardOf(act.selSticker()) === c().id,
        }}
        onPointerDown={(e) => act.cardPointerDown(e, c().id)} onContextMenu={(e) => act.cardContextMenu(e, c().id)} onDblClick={(e) => act.cardDblClick(e, c().id)}>
        <div class="cface">
        <Switch>
          <Match when={c().kind === "code"}><CodeCardView card={c() as CodeCard} /></Match>
          <Match when={c().kind === "note"}><NoteBody card={c() as NoteCard} /></Match>
          <Match when={c().kind === "image"}><ImageView card={c() as ImageCard} /></Match>
          <Match when={c().kind === "web" || c().kind === "links"}>{c().kind === "web" ? <WebBody card={c() as WebCard} /> : <LinksBody card={c() as any} />}</Match>
          <Match when={c().kind === "compare"}><CompareBody card={c() as any} /></Match>
        </Switch>
        {/* 拖动时由 .board.dragging 藏起来（CSS），不在每次拖动开始和结束时把几百张卡的圆点拆掉又建回来 */}
        <For each={["t", "r", "b", "l"] as const}>{(side) => <span class={`eport ${side}`} data-tip="Drag to link" onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); act.linkPortDown(e, { card: c().id }, r.left + r.width / 2, r.top + r.height / 2, EPORT_SIDE[side]); }} />}</For>
        <Show when={c().kind === "note" && !(c() as NoteCard).bg}><TextToolbar card={c() as NoteCard} /></Show>
        <CardStickers card={c().id} />
        <Show when={!pl().locked}>
          <Show when={c().kind === "note" && !(c() as NoteCard).bg} fallback={<div class="grip" data-tip="Drag to resize · Double-click to fit content" onPointerDown={(e) => act.resizeDown(e, c().id, { right: true, bottom: true })} onDblClick={(e) => { e.stopPropagation(); act.fitContent([c().id]); }} />}>
            <span class="hw l" onPointerDown={(e) => act.resizeDown(e, c().id, { left: true })} />
            <span class="hw r" onPointerDown={(e) => act.resizeDown(e, c().id, { right: true })} />
          </Show>
        </Show>
        </div>
        {/* 地图档只留下面这些：.cface 整块藏起来 */}
        <BoundStickers card={c().id} />
        {/* 地图档的名字空闲时就建好、藏着（styles.css），切到地图档只是显示出来 */}
        <Show when={labelReady() || lodOf(c().id) === "map"}><MapLabel card={c()} /></Show>
      </div>
    </Show>
  );
}

// ---------- 代码卡 ----------

export function CodeHead(p: { card: CodeCard; col?: boolean }) {
  const c = () => p.card;
  const node = createMemo(() => flows().byId.get(c().id));
  // 折叠后因为它藏起来的卡（别的路径还能走到的不算）
  const hiddenKids = createMemo(() => (placeOf(c().id).collapsed && node() ? descendants(flows(), c().id).filter((k) => collapsedSet().has(k)).length : 0));
  const linkedIn = createMemo(() => act.linksInto(c().id).length);
  const s0 = () => c().segments[0];
  const stale = createMemo(() => act.cardStale(c()));
  const mixed = () => mixedVersions(c());
  const multi = () => c().segments.length > 1;
  const free = () => s0()?.src.kind === "free";
  const notes = () => act.sidenotesOf(c().id).filter((n) => !n.at.lines);
  return (
    <div class="chead" data-drag>
      <Show when={node() && !state.host.settings?.hideNumbers}><span class="step" data-tip="Click: change mark · Drag: move with the cards it calls"><MarkView g={node()!} /></span></Show>
      <Show when={hiddenKids()}><button class="subc" data-tip="Expand Subtree" onPointerDown={(e) => e.stopPropagation()} onClick={() => act.toggleCollapse(c().id)}>▸ {hiddenKids()}</button></Show>
      <Show when={!p.col && placeOf(c().id).locked}><button class="lockb" data-tip="Unlock" data-kbd={act.K.lock} onPointerDown={(e) => e.stopPropagation()} onClick={() => act.toggleLock([c().id])}><Icon name="lock" /></button></Show>
      <span class="kind" classList={{ c: codeGlyph(c()) !== "ƒ" }}>{codeGlyph(c())}</span>
      <Show when={!free() || c().title || (editing()?.kind === "title" && editing()?.id === c().id)}>
        <Editable class="ctitle" kind="title" id={c().id} value={free() ? c().title ?? "" : cardTitle(c())} onCommit={(v) => act.renameCard(c().id, v)} />
      </Show>
      <Show when={c().title && c().segments.length > 1}><span class="plusn">+{c().mergedFrom ? c().mergedFrom!.length - 1 : 0 || ""}</span></Show>
      <Show when={free()} fallback={
        <span class="cpath" data-tip={multi() ? "Open First Segment in Editor" : "Open in Editor"} data-kbd="↵" onClick={() => !act.justDragged() && act.openCode(c().id)}>
          {multi() ? `${c().segments.length} segments${fileCount(c()) > 1 ? ` · ${fileCount(c())} files` : ""}` : `${shortPath(s0()?.path ?? "")}:${s0()?.start}`}
        </span>}>
        <button class="rev lang" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => act.langMenu(c().id, e.currentTarget)}>{langLabel(s0()?.lang ?? "python")} ▾</button>
      </Show>
      <span class="grow" />
      {/* 悬停才出现的按钮放在右侧这一组的最左边：没悬停时右侧的东西挨在一起，中间不空一块 */}
      <button class="ib cpy" aria-label="Copy Code" data-tip="Copy Code" onPointerDown={(e) => e.stopPropagation()} onClick={() => act.copyCard(c())}><Icon name="copy" /></button>
      <Show when={linkedIn()}><button class="linkedin" data-tip="Linked here: show where the arrows come from" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => act.showLinkedHere(c().id, e.currentTarget)}>← {linkedIn()}</button></Show>
      <Show when={notes().length}><button class="mk inline" data-notes={notes().map((n) => n.id).join(",")} onPointerDown={(e) => e.stopPropagation()} onPointerEnter={(e) => act.hoverMarker(e.currentTarget, notes().map((n) => n.id), e)} onClick={(e) => act.pinMarker(e.currentTarget, notes().map((n) => n.id))}>{notes().length}</button></Show>
      <Show when={!free()}>
        <button class="rev" data-dragclick classList={{ new: stale() === "changed" || stale() === "hidden", hollow: stale() === "hidden", lost: stale() === "lost" }}
          data-tip={stale() === "changed" ? "New version · View Diff" : stale() === "hidden" ? "Changes only in hidden lines" : s0()?.version.kind === "hash" ? "Unknown version (not in git)" : "Pinned version"}
          onClick={(e) => act.justDragged() ? undefined : (stale() === "changed" || stale() === "hidden" ? act.openDiff(c().id) : act.commitMenu(c().id, e.currentTarget))}>
          <Show when={stale() === "changed" || stale() === "hidden"}><i /></Show>
          {mixed() ? "Mixed" : versionLabel(s0()?.version, true)}
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

/** 材质用的卡片部件（默认 display: none，由 themes.css 按主题打开）：
 *  cband = 色带 / 大标题（函数名 + 行号区间和版本 + 大号编号），cxfoot = 底栏（行号区间 · 打开 / 看差异），cfig = 卡片下方的图注。
 *  只用卡片已有的数据：标题、flows() 编号、第一段的行号和版本。 */
function CodeBand(p: { card: CodeCard }) {
  const c = () => p.card;
  const s0 = () => c().segments[0];
  const label = () => (state.host.settings?.hideNumbers ? "" : flows().byId.get(c().id)?.label ?? "");
  const big = () => (/^\d$/.test(label()) ? `0${label()}` : label());
  const stale = () => act.cardStale(c());
  const isNew = () => stale() === "changed" || stale() === "hidden";
  return (
    <>
      <div class="cband" data-drag>
        <span class="cname">{c().title || cardTitle(c())}</span>
        <Show when={s0() && s0()!.src.kind !== "free"}>
          <span class="cmeta">
            <span class="cm"><small>Lines</small>{s0()!.start}–{s0()!.end}</span>
            <button class="cm v" classList={{ new: isNew() }} onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => (isNew() ? act.openDiff(c().id) : act.commitMenu(c().id, e.currentTarget))}><small>Commit</small>{isNew() ? "New version" : mixedVersions(c()) ? "Mixed" : versionLabel(s0()?.version)}</button>
          </span>
        </Show>
        <Show when={big()}><span class="big">{big()}</span></Show>
      </div>
      <Show when={label()}><span class="cfig">Fig. {label()} — {c().title || cardTitle(c())}</span></Show>
    </>
  );
}

function CodeFoot(p: { card: CodeCard }) {
  const c = () => p.card;
  const s0 = () => c().segments[0];
  const isNew = () => { const s = act.cardStale(c()); return s === "changed" || s === "hidden"; };
  return (
    <Show when={s0() && s0()!.src.kind !== "free"}>
      <div class="cxfoot" classList={{ new: isNew() }} data-drag>
        <span class="fl"><Icon name="clock" />L{s0()!.start}–{s0()!.end}</span>
        <button class="act" onPointerDown={(e) => e.stopPropagation()} onClick={() => (isNew() ? act.openDiff(c().id) : act.openCode(c().id))}>
          {isNew() ? "View Diff" : "Open in Editor"}<Icon name="arrowR" />
        </button>
      </div>
    </Show>
  );
}

/** 调用图标记：字母，或用户选的图标（内置贴纸） */
export function MarkView(p: { g: Graph }) {
  return <Show when={"icon" in p.g.mark} fallback={<>{p.g.label}</>}><Glyph icon={{ pack: "builtin", name: (p.g.mark as { icon: string }).icon }} size={13} /></Show>;
}
export const shortPath = (p: string) => p.split("/").slice(-1)[0];

function CodeCardView(p: { card: CodeCard }) {
  const c = () => p.card;
  return (
    <>
      <CodeHead card={c()} />
      <CodeBand card={c()} />
      <div class="carea" style={placeOf(c().id).h ? { height: `${placeOf(c().id).h}px` } : undefined}>
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
      </div>
      <CodeFoot card={c()} />
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
      {/* 跟 Note 一样没有标题栏：整张图都能拖，菜单用右键 */}
      <div class="imgb" data-drag><img src={src()} alt={p.card.alt ?? ""} draggable={false} /></div>
      <Desc id={p.card.id} desc={p.card.desc} />
    </>
  );
}

/** 地图档：卡片只剩编号 + 名字，字号按缩放反向放大，始终看得清 */
function MapLabel(p: { card: Card }) {
  const g = () => { const c = p.card; return c.kind === "compare" ? flows().byId.get(c.cols[0]) ?? flows().byId.get(c.cols[1]) : flows().byId.get(c.id); };
  const n = () => g()?.label || (g() ? "•" : "");
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
      <Show when={g() && !state.host.settings?.hideNumbers}><span class="step"><MarkView g={g()!} /></span></Show>
      <span class="mt"><For each={parts()}>{(x) => <>{x}<wbr /></>}</For></span>
    </div>
  );
}

export { LANGS };
