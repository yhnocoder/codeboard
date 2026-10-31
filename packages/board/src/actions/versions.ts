import { batch } from "solid-js";
import { unwrap } from "solid-js/store";
import { uid, isCode, rebaseSegment, rebaseUpstream, upstreamSegs, viewKeyOf, UPSTREAM, type CodeCard, type Segment, type DiffData, type Commit, type SegView } from "@codeboard/core";
import * as V from "@codeboard/core/commands";
import { state, cardById, hostOf } from "../state/store";
import { putViews, staleOk, putStale } from "../state/views";
import { mutate } from "../state/changes";
import { select } from "../state/selection";
import { toast } from "../state/toast";
import { openPop, updatePop } from "../state/pop";
import { send, ask } from "../host";
import { addCards } from "./create";
import { hostRect, revealCard } from "./common";
import { lastPointer } from "../state/measure";
import { updateScoped, reviewToast } from "./shared";
import { versionEnv } from "./env";
import { COMMITS_WAIT } from "../state/timing";
import { cardSel } from "../cardsel";

const staleOf = (id: string) => state.stale[id];
export const cardStale = (c: CodeCard) => V.cardStale(c, staleOf);
export const uncommitted = V.uncommitted;
export const staleCount = () => V.staleCount(state.board, staleOf);
export const updateAll = () => V.updateAll(versionEnv);
export const keepVersion = (cardId: string, segId: string) => V.keepVersion(versionEnv, cardId, segId);

export async function openDiff(id: string, segId?: string) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  // 有 Variant 的卡：新版本说的是上游的段，跟上游分支比
  const ups = upstreamSegs(c);
  const s = segId ? ups.find((q) => q.id === segId) : ups.find((q) => state.stale[q.id]?.state === "changed") ?? ups[0];
  if (!s) return;
  const el = document.querySelector(`${cardSel(hostOf(id))} .rev`) ?? undefined;
  const pid = openPop({ kind: "diff", card: id, seg: s.id }, el ? { el, prefer: "below" } : lastPointer());
  try {
    const data = await ask("diff", { seg: s, against: c.variants?.length ? "upstream" : undefined });
    updatePop(pid, "diff", (p) => ({ ...p, data }));
  } catch (e) { updatePop(pid, "diff", (p) => ({ ...p, error: (e as Error).message })); }
}
/** Update：换成新版本；Sidenote 跟着行走，那一行被删了改挂整卡，挂着的行变了的标上复查。共享卡先问范围（shared.updateScoped） */
export async function applyNewVersion(cardId: string, segId: string, data: DiffData) {
  if (!data.newSeg) return;
  await updateScoped(cardId, segId, data, (id) => { V.applyVersion(versionEnv, id, segId, data); toast(`Updated to the new version${reviewToast(id)}`); }, () => keepVersion(cardId, segId));
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
  const quick = await Promise.race([req, new Promise<null>((r) => setTimeout(() => r(null), COMMITS_WAIT))]);
  if (quick) return void openPop({ kind: "commits", card: id, seg, list: quick }, { el, prefer: "below" });
  const pid = openPop({ kind: "commits", card: id, seg }, { el, prefer: "below" });
  const list = await req;
  updatePop(pid, "commits", (p) => ({ ...p, list }));
}
export async function switchCommit(id: string, commit: string) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const segs: { seg: Segment; view: SegView }[] = [];
  for (const s of c.segments) {
    if (s.src.kind !== "repo" && s.src.kind !== "external") continue;
    try { segs.push(await ask("switchCommit", { seg: s, commit })); }
    catch (e) { return toast((e as Error).message); }
  }
  // 走 rebaseSegment：段上的隐藏 / 高亮，Link、Sidenote、Sticker 的行号按内容跟到那个 commit 的行上
  mutate((b) => { for (const r of segs) rebaseSegment(b, id, r.seg); });
  batch(() => {
    putViews(Object.fromEntries(segs.map((r) => [r.seg.id, r.view])));
    putStale(Object.fromEntries(segs.map((r) => [r.seg.id, undefined])));
  });
  send({ type: "checkVersions" });
  toast(`Switched to ${commit.slice(0, 7)}`);
}

/** Relocate 之后宿主送来新段（同一个 id）：换掉旧段，行号跟过去，状态回到正常 */
export function replaceSegment(cardId: string, seg: Segment, view: SegView) {
  const c = cardById(cardId)?.card;
  if (isCode(c)) putViews({ [viewKeyOf(c, seg.id, UPSTREAM)]: view });
  staleOk([seg.id]);
  mutate((b) => rebaseUpstream(b, cardId, seg));
}

/** Review in the new-version banner: open the diffs one by one */
export function reviewNext() {
  const id = V.nextToReview(state.board, staleOf);
  if (!id) return toast("All cards are up to date");
  select({ cards: [hostOf(id)] });
  void revealCard(id, false).then(() => openDiff(id));
}
