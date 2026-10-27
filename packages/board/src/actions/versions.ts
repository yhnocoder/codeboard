import { unwrap } from "solid-js/store";
import {
  uid, findCard, isCode, allCodeCards, rebaseSegment, rebaseUpstream, upstreamSegs, viewKeyOf, UPSTREAM, type CodeCard, type Segment, type DiffData, type Commit, type SegView,
} from "@codeboard/core";
import { state, setState, mutate, select, cardById, hostOf, toast } from "../state/store";
import { openPop, updatePop } from "../state/pop";
import { send, ask } from "../host";
import { addCards } from "./create";
import { hostRect, revealCard } from "./common";
import { lastPointer } from "../state/measure";
import { updateScoped, reviewToast } from "./shared";
import { choose } from "../ui/Menu";
import { unlinkCard, versionLabel } from "@codeboard/core";
import { sharedOn } from "../state/store";

/** 卡片标题上的版本点：changed = 黄点；hidden = 只有隐藏的行变了（空心点） */
export function cardStale(c: CodeCard): "changed" | "hidden" | "lost" | "missing" | null {
  let hidden = false;
  for (const s of upstreamSegs(c)) {
    const st = state.stale[s.id];
    if (!st) continue;
    if (st.state === "changed" && s.keep && st.head.startsWith(s.keep)) continue;
    if (st.state === "changed") { if (!st.hiddenOnly) return "changed"; hidden = true; }
    if ((st.state === "lost" || st.state === "many") && !c.keepOld) return "lost";
    if (st.state === "missing") return "missing";
  }
  return hidden ? "hidden" : null;
}
export const uncommitted = (c: CodeCard) => c.segments.some((s) => s.version.kind === "git" && s.version.uncommitted);

export async function openDiff(id: string, segId?: string) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  // 有 Variant 的卡：新版本说的是上游的段，跟上游分支比
  const ups = upstreamSegs(c);
  const s = segId ? ups.find((q) => q.id === segId) : ups.find((q) => state.stale[q.id]?.state === "changed") ?? ups[0];
  if (!s) return;
  const el = document.querySelector(`.card[data-id="${hostOf(id)}"] .rev`) ?? undefined;
  const pid = openPop({ kind: "diff", card: id, seg: s.id }, el ? { el, prefer: "below" } : lastPointer());
  try {
    const data = await ask("diff", { seg: structuredClone(unwrap(s)), against: c.variants?.length ? "upstream" : undefined });
    updatePop(pid, (p) => ({ ...(p as any), data }));
  } catch (e) { updatePop(pid, (p) => ({ ...(p as any), error: (e as Error).message })); }
}
/** Update：换成新版本；Sidenote 跟着行走，那一行被删了改挂整卡，挂着的行变了的标上复查。共享卡先问范围（shared.updateScoped） */
export async function applyNewVersion(cardId: string, segId: string, data: DiffData) {
  if (!data.newSeg) return;
  await updateScoped(cardId, segId, data, (id) => { updateNow(id, segId, data); toast(`Updated to the new version${reviewToast(id)}`); }, () => keepVersion(cardId, segId));
}
function updateNow(cardId: string, segId: string, data: DiffData) {
  const ns = structuredClone(data.newSeg!);
  ns.id = segId;
  const c = cardById(cardId)?.card;
  mutate((b) => rebaseUpstream(b, cardId, ns, undefined, { review: versionLabel(ns.version) }));
  // 上游不在显示：展示数据存在它的 viewKey 下
  if (data.newView && isCode(c)) setState("views", { [viewKeyOf(c, segId, UPSTREAM)]: data.newView });
  setState("stale", segId, { state: "ok" });
}
/** Keep：留在钉住的版本，记下这次的 HEAD，同一个新版本不再提醒 */
export function keepVersion(cardId: string, segId: string) {
  const st = state.stale[segId];
  const head = st?.state === "changed" ? st.head : undefined;
  if (head) mutate((b) => { const c = findCard(b, cardId)?.card; if (isCode(c)) { const s = upstreamSegs(c).find((q) => q.id === segId); if (s) s.keep = head; } });
  else setState("stale", segId, { state: "ok" });
}
/** 横幅里的 Update All：每段都取 diff 再更新，跟一张张点 Update 一样 */
export async function updateAll() {
  const todo: [string, Segment][] = [];
  for (const c of allCodeCards(state.board)) if (cardStale(c) === "changed") for (const s of upstreamSegs(c)) if (state.stale[s.id]?.state === "changed") todo.push([c.id, s]);
  // 共享卡：范围按设置；要问的话一批只问一次
  const linked = [...new Set(todo.map(([c]) => c))].filter((c) => sharedOn(c) > 1);
  let scope = state.host.settings.sharedUpdate;
  if (linked.length && scope === "ask") {
    const i = await choose(`${linked.length} of these cards ${linked.length > 1 ? "are" : "is"} also on other boards`, ["Update on All Boards", "This Board Only", "Skip Linked Cards"], {
      note: "This Board Only makes a copy here, so the other boards keep the old version.",
    });
    if (i === null) return;
    scope = i === 0 ? "all" : i === 1 ? "this" : "skip" as any;
  }
  const ren = new Map<string, string>();
  if (scope === "this") mutate((b) => { for (const c of linked) ren.set(c, unlinkCard(b, c)); });
  let n = 0;
  for (const [cid0, s] of todo) {
    if (linked.includes(cid0) && (scope as string) === "skip") continue;
    const cid = ren.get(cid0) ?? cid0;
    try {
      const k = cardById(cid)?.card;
      const data = await ask("diff", { seg: structuredClone(unwrap(s)), against: isCode(k) && k.variants?.length ? "upstream" : undefined });
      if (data.canUpdate) { updateNow(cid, s.id, data); n++; }
    } catch { /* 这张跳过 */ }
  }
  toast(n === todo.length ? `Updated ${n} card${n === 1 ? "" : "s"}` : `Updated ${n} of ${todo.length}; open the others to review`);
}
export async function duplicateNewVersion(cardId: string, segId: string, data: DiffData) {
  if (!data.newSeg) return;
  const c = cardById(cardId)?.card;
  if (!isCode(c)) return;
  const d = structuredClone(unwrap(c)) as CodeCard;
  d.id = uid("c");
  d.title = undefined;
  d.segments = d.segments.map((s) => (s.id === segId ? { ...structuredClone(data.newSeg!), id: uid("s") } : { ...s, id: uid("s") }));
  const r = hostRect(cardId)!;
  const views: Record<string, SegView> = {};
  c.segments.forEach((s, i) => { const v = s.id === segId ? data.newView : state.views[s.id]; if (v) views[d.segments[i].id] = v; });
  addCards([{ card: d, views }], { at: { x: r.x + r.w + 40, y: r.y } });
}

export async function commitMenu(id: string, el: Element) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const s = c.segments[0];
  if (s.src.kind === "github" || s.src.kind === "free") return;
  // 先拿列表再开弹窗：弹窗不会先以 Loading 打开再变大、换位置；拿得慢才先开
  const seg = structuredClone(unwrap(s));
  const req = ask("commits", { seg }).catch(() => [] as Commit[]);
  const quick = await Promise.race([req, new Promise<null>((r) => setTimeout(() => r(null), 250))]);
  if (quick) return void openPop({ kind: "commits", card: id, seg, list: quick }, { el, prefer: "below" });
  const pid = openPop({ kind: "commits", card: id, seg }, { el, prefer: "below" });
  const list = await req;
  updatePop(pid, (p) => ({ ...(p as any), list }));
}
export async function switchCommit(id: string, commit: string) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const segs: { seg: Segment; view: SegView }[] = [];
  for (const s of c.segments) {
    if (s.src.kind !== "repo" && s.src.kind !== "external") continue;
    try { segs.push(await ask("switchCommit", { seg: structuredClone(unwrap(s)), commit })); }
    catch (e) { return toast((e as Error).message); }
  }
  // 走 rebaseSegment：段上的隐藏 / 高亮，Link、Sidenote、Sticker 的行号按内容跟到那个 commit 的行上
  mutate((b) => { for (const r of segs) rebaseSegment(b, id, r.seg); });
  for (const r of segs) { setState("views", r.seg.id, r.view); setState("stale", r.seg.id, undefined as any); }
  send({ type: "checkVersions" });
  toast(`Switched to ${commit.slice(0, 7)}`);
}

/** Relocate 之后宿主送来新段（同一个 id）：换掉旧段，行号跟过去，状态回到正常 */
export function replaceSegment(cardId: string, seg: Segment, view: SegView) {
  const c = cardById(cardId)?.card;
  if (isCode(c)) setState("views", { [viewKeyOf(c, seg.id, UPSTREAM)]: view });
  setState("stale", seg.id, { state: "ok" });
  mutate((b) => rebaseUpstream(b, cardId, seg));
}

/** 新版本横幅里的 Review：一张张打开 diff */
export function reviewNext() {
  for (const c of allCodeCards(state.board)) {
    const st = cardStale(c);
    if (st === "changed" || st === "hidden") { select({ cards: [hostOf(c.id)] }); void revealCard(c.id, false).then(() => openDiff(c.id)); return; }
  }
  toast("All cards are up to date");
}
export const staleCount = () => allCodeCards(state.board).filter((c) => cardStale(c) === "changed").length;
