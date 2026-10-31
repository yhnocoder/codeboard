// 切换只在白板里换段和展示数据（宿主事先把每个 Variant 的代码和高亮都给了），一帧之内完成。
import { batch, createEffect, untrack } from "solid-js";
import { rooted } from "../state/root";
import { unwrap } from "solid-js/store";
import {
  activeOf, addVariant as addV, dropVariants, findCard, isCode, isMine, removeVariant as removeV, segsOf, setVariantSegs, switchVariant as switchV, upstreamSegs, variantMarks, variantTitle, viewKey, UPSTREAM, parseViewKey, type AddVariantFrom, type VariantSources, type Card, type CodeCard, type Segment, type SegView, type VariantMarks, type VariantSync,
} from "@codeboard/core";
import { state, cardById } from "../state/store";
import { putViews, staleOk } from "../state/views";
import { mutate, sync } from "../state/changes";
import { toast } from "../state/toast";
import { ask } from "../host";
import { openMenu, promptText, choose, type Item } from "../ui/Menu";
import { openPop } from "../state/pop";
import { setEditing } from "../state/ui";
import { vlive, setVlive, vbase, setVbase, merged, setMergedSig } from "../state/variants";

const code = (id: string) => { const c = cardById(id)?.card; return isCode(c) ? c : undefined; };

/**
 * 段 id → views[段 id] 里现在放的是哪个 Variant 的展示数据。卡上显示的 Variant 变了（切换、撤销 / 重做、别的白板改了共享卡）
 * 就按它把展示数据换过来：现在的存到 viewKey(段, 原来的) 下，目标的从 viewKey(段, 目标) 拿出来
 */
const shownView = new Map<string, string>();
/** 白板刚读进来：views[段] 就是各卡显示着的那个 Variant 的 */
export function resetShownViews() {
  shownView.clear();
  for (const c of state.board.cards) if (c.kind === "code" && c.variants?.length) for (const s of c.segments) shownView.set(s.id, activeOf(c));
}
/** 别的白板改了共享卡：宿主按那张卡显示的 Variant 算好了展示数据 */
export function sharedShown(cards: Card[]) {
  for (const c of cards) if (c.kind === "code") for (const s of c.segments) { if (c.variants?.length) shownView.set(s.id, activeOf(c)); else shownView.delete(s.id); }
}
/** 让 views[段] 对上卡上显示的 Variant（同一帧里换，不等宿主）；没有存着的就先显示纯文本，再问宿主 */
function ensureViews(c: CodeCard) {
  const act = activeOf(c);
  const put: Record<string, SegView | undefined> = {};
  const missing: Segment[] = [];
  for (const s of c.segments) {
    const had = shownView.get(s.id);
    if (had === undefined) { shownView.set(s.id, act); continue; }
    if (had === act) continue;
    // 整个对象换掉（setState 给路径赋对象是合并：两个键指着同一个对象时会把另一个也改了）
    const now = state.views[s.id], next = state.views[viewKey(s.id, act)];
    if (now) put[viewKey(s.id, had)] = unwrap(now);
    if (next) { put[s.id] = unwrap(next); put[viewKey(s.id, act)] = undefined; }
    else { put[s.id] = undefined; missing.push({ ...unwrap(s), id: viewKey(s.id, act) }); }
    shownView.set(s.id, act);
  }
  putViews(put as Record<string, SegView>);
  if (missing.length) void ask("views", { segs: structuredClone(missing) }).then(absorbViews).catch(() => {});
}
/** 宿主给的 Variant 展示数据（键 viewKey(段, Variant)）：那个 Variant 正显示着就直接放到 views[段] */
function absorbViews(v: Record<string, SegView>) {
  const put: Record<string, SegView | undefined> = {};
  for (const [k, view] of Object.entries(v)) {
    const { sid, vid } = parseViewKey(k);
    if (vid && shownView.get(sid) === vid) put[sid] = view; else put[k] = view;
  }
  putViews(put as Record<string, SegView>);
}
// 撤销 / 重做、同步都可能换掉显示的 Variant：盯着每张有 Variant 的卡的 active
rooted(() => createEffect(() => {
  for (const c of state.board.cards) if (c.kind === "code" && c.variants?.length) { void c.active; untrack(() => ensureViews(c)); }
}));

/** 切到一个 Variant：换段（Link、Sidenote 行号跟过去），同一批里换展示数据 */
export function switchVariant(id: string, vid: string) {
  const c = code(id);
  if (!c?.variants || activeOf(c) === vid) return;
  batch(() => {
    mutate((b) => { switchV(b, id, vid); });
    const k = code(id);
    if (k) ensureViews(k);
  });
}

/** 卡头的「+」/ 菜单里的 Add Variant…：先问宿主有哪些 worktree、分支，再开菜单 */
export async function addVariantMenu(id: string, x: number, y: number) {
  const c = code(id);
  if (!c) return;
  const up = upstreamSegs(c).find((s) => s.src.kind !== "free" && s.src.kind !== "github");
  if (!up) return void toast("Only code from a repo or a file can have variants");
  const src: VariantSources = await ask("variantSources", { seg: up }).catch(() => ({ worktrees: [], branches: [] }));
  const have = new Set((c.variants ?? []).map((v) => JSON.stringify(v.from)));
  const add = (from: AddVariantFrom) => () => void addVariant(id, from);
  const items: Item[] = [
    { label: "Add Variant", head: true },
    { label: "Branch or Commit…", sub: [
      ...src.branches.slice(0, 12).map((b): Item => ({ label: b, kbd: b === src.current ? "current" : undefined, disabled: have.has(JSON.stringify({ kind: "ref", ref: b })) ? "Already a variant" : false, run: add({ kind: "ref", ref: b }) })),
      ...(src.branches.length ? [null] : []),
      { label: "Type a Branch or Commit…", run: () => void promptText("Add Variant from Branch or Commit", "", "fix-spec-bug or a1b2c3d", "Add").then((r) => r && addVariant(id, { kind: "ref", ref: r })) },
    ] },
    { label: "Working Tree (uncommitted)", disabled: have.has(JSON.stringify({ kind: "worktree" })) ? "Already a variant" : false, run: add({ kind: "worktree" }) },
    ...(src.worktrees.length
      ? src.worktrees.map((w): Item => ({ label: "Other Worktree", kbd: w.label, hint: w.dir, disabled: c.variants?.some((v) => v.from.kind === "wt" && v.from.dir === w.dir) ? "Already a variant" : false, run: add({ kind: "wt", dir: w.dir, branch: w.branch }) }))
      : [{ label: "Other Worktree", disabled: "No other worktree of this repo (git worktree add)" } as Item]),
    { label: "Another File…", hint: "A copy of this file you changed, inside or outside the repo", run: add({ kind: "file" }) },
    { label: "GitHub Pull Request…", disabled: src.pr ? false : "origin is not on GitHub", run: () => void promptText(`Add Variant from a Pull Request on ${src.pr}`, "", "Number, e.g. 1234", "Add").then((r) => { const n = Number(r?.replace(/^#/, "")); if (r && n > 0) void addVariant(id, { kind: "pr", num: n }); else if (r) toast("Type the pull request number"); }) },
  ];
  openMenu(items, x, y);
}

async function addVariant(id: string, from: AddVariantFrom) {
  const c = code(id);
  if (!c) return;
  const segs = structuredClone(unwrap(upstreamSegs(c)));
  let nv;
  try { nv = await ask("addVariant", { segs, from }); }
  catch (e) { return void toast((e as Error).message); }
  if (!nv || !code(id)) return;
  const vid = `v${Date.now().toString(36)}`;
  const cur = code(id)!;
  for (const s of cur.segments) shownView.set(s.id, activeOf(cur));
  batch(() => {
    putViews(Object.fromEntries(nv.segs.flatMap((s) => (nv.views[s.id] ? [[viewKey(s.id, vid), nv.views[s.id]]] : []))));
    mutate((b) => addV(b, id, { id: vid, name: nv.name, from: nv.from, segs: nv.segs }));
  });
  switchVariant(id, vid);
  toast(isMine(code(id)!) ? `Added variant ${nv.name}` : `Added variant ${nv.name}: same code as upstream`);
}

export function variantMenu(id: string, vid: string, x: number, y: number) {
  const c = code(id);
  const v = c?.variants?.find((k) => k.id === vid);
  if (!c || !v) return;
  const up = vid === UPSTREAM;
  openMenu([
    { label: "Show", disabled: activeOf(c) === vid, run: () => switchVariant(id, vid) },
    { label: "Rename…", run: () => void promptText("Rename Variant", v.name, "", "Rename").then((n) => n && mutate((b) => { const k = findCard(b, id)?.card as CodeCard | undefined; const x = k?.variants?.find((q) => q.id === vid); if (x) x.name = n; })) },
    { label: v.note ? "Edit Note" : "Add Note", run: () => { switchVariant(id, vid); setEditing({ kind: "vnote", id }); } },
    { label: "Compare To This", disabled: activeOf(c) === vid, run: () => setVbase(id, vid) },
    null,
    ...(up ? [{ label: "Remove All Variants", danger: true, run: () => void removeAll(id) } as Item] : [{ label: "Remove Variant", danger: true, run: () => removeVariant(id, vid) } as Item]),
  ], x, y);
}

function removeVariant(id: string, vid: string) {
  const c = code(id);
  if (!c) return;
  if (activeOf(c) === vid) switchVariant(id, UPSTREAM);
  if ((c.variants?.length ?? 0) <= 2) for (const s of c.segments) shownView.delete(s.id); // 只剩上游：变回普通卡
  mutate((b) => removeV(b, id, vid));
  if (vbase[id] === vid) setVbase(id, undefined);
}
async function removeAll(id: string) {
  const i = await choose("Remove all variants?", ["Remove", "Cancel"], { text: "The card goes back to the upstream code. Variant notes are removed too." });
  if (i !== 0) return;
  if (code(id) && activeOf(code(id)!) !== UPSTREAM) switchVariant(id, UPSTREAM);
  for (const s of code(id)?.segments ?? []) shownView.delete(s.id);
  mutate((b) => dropVariants(b, id));
}

export function setVariantNote(id: string, text: string) {
  mutate((b) => {
    const c = findCard(b, id)?.card as CodeCard | undefined;
    const v = c?.variants?.find((k) => k.id === activeOf(c));
    if (v) { if (text.trim()) v.note = text.trim(); else delete v.note; }
  });
}

export function baseOf(c: CodeCard): { key: string; label: string; segs?: Segment[] } {
  const k = vbase[c.id] ?? UPSTREAM;
  if (k === "latest") { const l = vlive[c.id]?.latest; return { key: k, label: l ? `Upstream latest ${l.label}` : "Upstream latest", segs: l?.segs }; }
  const v = c.variants?.find((x) => x.id === k) ?? c.variants?.find((x) => x.id === UPSTREAM);
  if (!v) return { key: UPSTREAM, label: "Upstream", segs: upstreamSegs(c) };
  return { key: v.id, label: v.id === UPSTREAM ? `Upstream ${variantTitle(c, v).split(" · ").pop()}` : v.name, segs: segsOf(c, v.id) };
}
/** 卡上每一行和对比基准比：新加 / 改过（显示的是上游、或基准就是自己时没有） */
export function marksOf(c: CodeCard): VariantMarks | null {
  if (!c.variants?.length) return null;
  const b = baseOf(c);
  if (b.key === activeOf(c)) return null;
  if (activeOf(c) === UPSTREAM && b.key === UPSTREAM) return null;
  return variantMarks(b.segs, c.segments);
}

export function baseMenu(id: string, el: Element) {
  const c = code(id);
  if (!c) return;
  const r = el.getBoundingClientRect();
  const cur = vbase[id] ?? UPSTREAM;
  const l = vlive[id]?.latest;
  openMenu([
    { label: "Compare To", head: true },
    { label: `Upstream (pinned) · ${variantTitle(c, c.variants![0]).split(" · ").pop()}`, checked: cur === UPSTREAM, disabled: activeOf(c) === UPSTREAM ? "Showing upstream" : false, run: () => setVbase(id, UPSTREAM) },
    { label: l ? `Upstream Latest · ${l.label}` : "Upstream Latest", checked: cur === "latest", disabled: l ? false : "Upstream branch not found", run: () => setVbase(id, "latest") },
    ...(c.variants ?? []).filter((v) => v.id !== UPSTREAM).map((v): Item => ({ label: v.name, checked: cur === v.id, disabled: activeOf(c) === v.id ? "This is the one shown" : false, run: () => setVbase(id, v.id) })),
  ], r.left, r.bottom + 4);
}

/** 三方对照：原版（上游钉住的）/ 我的（显示的）/ 上游最新 */
export function openThreeWay(id: string, el?: Element) {
  const c = code(id);
  if (!c) return;
  if (!vlive[id]?.latest) return void toast("Upstream latest is not available (no upstream branch found)");
  openPop({ kind: "three", card: id }, el ? { el, prefer: "below" } : { x: innerWidth / 2 - 300, y: 120 });
}

/** 每个合入只提示一次（这次打开白板里） */
const asked = new Set<string>();

export function applyVariantSync(cards: Record<string, VariantSync>) {
  batch(() => {
    for (const [id, r] of Object.entries(cards)) {
      const c = code(id);
      if (!c?.variants) continue;
      if (r.latest || r.behind) setVlive(id, { latest: r.latest, behind: r.behind });
      if (r.views) absorbViews(r.views);
      const segs = r.segs;
      if (segs && Object.keys(segs).length) sync((b) => { for (const [vid, ss] of Object.entries(segs)) setVariantSegs(b, id, vid, ss); });
    }
  });
  for (const [id, r] of Object.entries(cards)) {
    const c = code(id);
    if (!c?.variants) continue;
    for (const vid of r.rebased ?? []) { const v = c.variants.find((x) => x.id === vid); if (v) toast(`${v.name} was rebased. Variant re-anchored by function name.`); }
    for (const [vid, m] of Object.entries(r.merged ?? {})) {
      const v = c.variants.find((x) => x.id === vid);
      const k = `${id}:${vid}:${m.tip}`;
      if (!v || asked.has(k)) continue;
      asked.add(k);
      setMerged(id, vid, m.into, m.tip);
      mergedPrompt(id);
    }
  }
}

const setMerged = (id: string, vid: string, into: string, tip: string) => setMergedSig((m) => ({ ...m, [id]: { vid, into, tip } }));

/** Convert：变回普通卡，钉在上游最新（合进去的改动就在里面） */
function convertMerged(id: string) {
  const latest = vlive[id]?.latest;
  const c = code(id);
  if (!c) return;
  batch(() => {
    if (activeOf(c) !== UPSTREAM) switchVariant(id, UPSTREAM);
    if (latest) putViews(Object.fromEntries(latest.segs.flatMap((s) => (latest.views[s.id] ? [[s.id, structuredClone(unwrap(latest.views[s.id]))]] : []))));
    for (const s of c.segments) shownView.delete(s.id);
    mutate((b) => dropVariants(b, id, latest ? structuredClone(unwrap(latest.segs)) : undefined));
    setMergedSig((m) => { const n = { ...m }; delete n[id]; return n; });
  });
  staleOk((latest?.segs ?? []).map((s) => s.id));
  toast(latest ? `Now a regular card pinned to ${latest.label}` : "Now a regular card");
}
function keepMerged(id: string, vid: string, tip: string) {
  mutate((b) => { const c = findCard(b, id)?.card as CodeCard | undefined; const v = c?.variants?.find((x) => x.id === vid); if (v) v.merged = tip; });
  setMergedSig((m) => { const n = { ...m }; delete n[id]; return n; });
}
export function mergedPrompt(id: string) {
  const m = merged()[id];
  const v = m && code(id)?.variants?.find((x) => x.id === m.vid);
  if (!m || !v) return;
  toast(`${v.name} was merged into ${m.into.split(" ")[0]}. Turn this card back into a regular upstream card?`, [
    { label: "Convert", run: () => convertMerged(id) },
    { label: "Keep Variants", run: () => keepMerged(id, m.vid, m.tip) },
  ], 12000);
}

/** 「只在这个 Variant」：挂在有 Variant 的卡上的 Sidenote 才有 */
export function toggleVariantOnly(noteId: string) {
  mutate((b) => {
    const n = b.sidenotes.find((k) => k.id === noteId);
    const c = n && (findCard(b, n.at.card)?.card as CodeCard | undefined);
    if (!n || !c?.variants?.length) return;
    if (n.variant) delete n.variant; else n.variant = activeOf(c);
  });
}
export const variantName = (id: string, vid: string) => code(id)?.variants?.find((v) => v.id === vid)?.name;
