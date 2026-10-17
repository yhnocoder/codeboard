// 我的改动（线框 07）：卡上的 Variant 标签页、Add Variant 菜单、对比基准、三方对照、合进上游后转回普通卡、「只在这个 Variant」的 Sidenote。
// 切换只在白板里换段和展示数据（宿主事先把每个 Variant 的代码和高亮都给了），一帧之内完成。
import { batch, createSignal } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import {
  activeOf, addVariant as addV, dropVariants, findCard, isCode, isMine, removeVariant as removeV, segsOf, setVariantSegs, switchVariant as switchV,
  upstreamSegs, variantMarks, variantTitle, viewKey, UPSTREAM,
  type AddVariantFrom, type VariantSources, type CodeCard, type Segment, type SegView, type VariantMarks, type VariantSync,
} from "@codeboard/core";
import { state, setState, mutate, sync, cardById, toast } from "../state/store";
import { ask } from "../host";
import { openMenu, promptText, choose, type Item } from "../ui/Menu";
import { openPop } from "../state/pop";
import { setEditing } from "../state/ui";

/** 宿主给的、不存盘的：上游最新的代码、落后几个 commit、提示过的合入（卡 id →） */
export type VLive = { latest?: { label: string; segs: Segment[]; views: Record<string, SegView> }; behind?: Record<string, number> };
export const [vlive, setVlive] = createStore<Record<string, VLive>>({});
/** 对比基准（卡 id → "up" | "latest" | Variant id）；默认上游。只是看的方式，不存盘 */
export const [vbase, setVbase] = createStore<Record<string, string>>({});

const code = (id: string) => { const c = cardById(id)?.card; return isCode(c) ? c : undefined; };

// ---------- 切换 ----------

/** 切到一个 Variant：展示数据先换（当前的存到 viewKey 下，目标的拿出来），再换段（Link、Sidenote 行号跟过去） */
export function switchVariant(id: string, vid: string) {
  const c = code(id);
  if (!c?.variants || activeOf(c) === vid) return;
  const cur = activeOf(c);
  const target = segsOf(c, vid) ?? [];
  const missing: Segment[] = [];
  // 整个对象换掉（setState 给路径赋对象是合并：两个键指着同一个对象时会把另一个也改了）
  const put: Record<string, SegView | undefined> = {};
  for (const s of c.segments) {
    const now = state.views[s.id], next = state.views[viewKey(s.id, vid)];
    if (now) put[viewKey(s.id, cur)] = unwrap(now);
    if (next) { put[s.id] = unwrap(next); put[viewKey(s.id, vid)] = undefined; }
    else { const t = target.find((x) => x.id === s.id); if (t) missing.push(t); }
  }
  batch(() => {
    setState("views", put as Record<string, SegView>);
    mutate((b) => { switchV(b, id, vid); });
  });
  // 宿主还没给过（复制来的卡、刚同步来的）：先显示纯文本，展示数据到了再换
  if (missing.length) void ask("views", { segs: structuredClone(unwrap(missing)) }).then((v) => setState("views", v)).catch(() => {});
}

// ---------- 添加 ----------

/** 卡头的「+」/ 菜单里的 Add Variant…：先问宿主有哪些 worktree、分支，再开菜单 */
export async function addVariantMenu(id: string, x: number, y: number) {
  const c = code(id);
  if (!c) return;
  const up = upstreamSegs(c).find((s) => s.src.kind !== "free" && s.src.kind !== "github");
  if (!up) return void toast("Only code from a repo or a file can have variants");
  const src: VariantSources = await ask("variantSources", { seg: structuredClone(unwrap(up)) }).catch(() => ({ worktrees: [], branches: [] }));
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
      ? src.worktrees.map((w): Item => ({ label: "Other Worktree", kbd: w.label, disabled: c.variants?.some((v) => v.from.kind === "wt" && v.from.dir === w.dir) ? "Already a variant" : false, run: add({ kind: "wt", dir: w.dir, branch: w.branch }) }))
      : [{ label: "Other Worktree", disabled: "No other worktree of this repo (git worktree add)" } as Item]),
    { label: "Another File…", hint: "A copy of this file you changed, inside or outside the repo", run: add({ kind: "file" }) },
    { label: "GitHub Pull Request…", disabled: src.pr ? false : "origin is not on GitHub", run: () => void promptText(`Add Variant from a Pull Request on ${src.pr}`, "", "Number, e.g. 1234", "Add").then((r) => { const n = Number(r?.replace(/^#/, "")); if (r && n > 0) void addVariant(id, { kind: "pr", num: n }); else if (r) toast("Type the pull request number"); }) },
  ];
  openMenu(items, x, y);
}

export async function addVariant(id: string, from: AddVariantFrom) {
  const c = code(id);
  if (!c) return;
  const segs = structuredClone(unwrap(upstreamSegs(c)));
  let nv;
  try { nv = await ask("addVariant", { segs, from }); }
  catch (e) { return void toast((e as Error).message); }
  if (!nv || !code(id)) return;
  const vid = `v${Date.now().toString(36)}`;
  batch(() => {
    setState("views", Object.fromEntries(nv.segs.flatMap((s) => (nv.views[s.id] ? [[viewKey(s.id, vid), nv.views[s.id]]] : []))));
    mutate((b) => addV(b, id, { id: vid, name: nv.name, from: nv.from, segs: nv.segs }));
  });
  switchVariant(id, vid);
  toast(isMine(code(id)!) ? `Added variant ${nv.name}` : `Added variant ${nv.name}: same code as upstream`);
}

// ---------- 改名、删除、说明 ----------

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

export function removeVariant(id: string, vid: string) {
  const c = code(id);
  if (!c) return;
  if (activeOf(c) === vid) switchVariant(id, UPSTREAM);
  mutate((b) => removeV(b, id, vid));
  if (vbase[id] === vid) setVbase(id, undefined as any);
}
async function removeAll(id: string) {
  const i = await choose("Remove all variants?", ["Remove", "Cancel"], { text: "The card goes back to the upstream code. Variant notes are removed too." });
  if (i !== 0) return;
  if (code(id) && activeOf(code(id)!) !== UPSTREAM) switchVariant(id, UPSTREAM);
  mutate((b) => dropVariants(b, id));
}

export function setVariantNote(id: string, text: string) {
  mutate((b) => {
    const c = findCard(b, id)?.card as CodeCard | undefined;
    const v = c?.variants?.find((k) => k.id === activeOf(c));
    if (v) { if (text.trim()) v.note = text.trim(); else delete v.note; }
  });
}

// ---------- 对比 ----------

/** 对比基准的段和名字 */
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

// ---------- 宿主同步来的 ----------

/** 每个合入只提示一次（这次打开白板里） */
const asked = new Set<string>();

export function applyVariantSync(cards: Record<string, VariantSync>) {
  batch(() => {
    for (const [id, r] of Object.entries(cards)) {
      const c = code(id);
      if (!c?.variants) continue;
      if (r.latest || r.behind) setVlive(id, { latest: r.latest, behind: r.behind });
      if (r.views) setState("views", r.views);
      const segs = r.segs;
      if (segs && Object.keys(segs).length) sync((b) => { for (const [vid, ss] of Object.entries(segs)) setVariantSegs(b, id, vid, ss); });
    }
  });
  for (const [id, r] of Object.entries(cards)) {
    const c = code(id);
    if (!c?.variants) continue;
    for (const vid of r.rebased ?? []) { const v = c.variants.find((x) => x.id === vid); if (v) toast(`${v.name} was rebased. Variant re-anchored by function name.`); }
    for (const [vid, at] of Object.entries(r.merged ?? {})) {
      const v = c.variants.find((x) => x.id === vid);
      const k = `${id}:${vid}:${at}`;
      if (!v || asked.has(k)) continue;
      asked.add(k);
      setMerged(id, vid, at);
      toast(`${v.name} was merged into ${at.split(" ")[0]}. Turn this card back into a regular upstream card?`, [
        { label: "Convert", run: () => convertMerged(id) },
        { label: "Keep Variants", run: () => keepMerged(id, vid, at) },
      ], 12000);
    }
  }
}

/** 合进上游的 Variant（卡头的提示点，Convert / Keep Variants） */
export const [merged, setMergedSig] = createSignal<Record<string, { vid: string; at: string }>>({});
const setMerged = (id: string, vid: string, at: string) => setMergedSig((m) => ({ ...m, [id]: { vid, at } }));

/** Convert：变回普通卡，钉在上游最新（合进去的改动就在里面） */
export function convertMerged(id: string) {
  const latest = vlive[id]?.latest;
  const c = code(id);
  if (!c) return;
  batch(() => {
    if (activeOf(c) !== UPSTREAM) switchVariant(id, UPSTREAM);
    if (latest) setState("views", Object.fromEntries(latest.segs.flatMap((s) => (latest.views[s.id] ? [[s.id, structuredClone(unwrap(latest.views[s.id]))]] : []))));
    mutate((b) => dropVariants(b, id, latest ? structuredClone(unwrap(latest.segs)) : undefined));
    setMergedSig((m) => { const n = { ...m }; delete n[id]; return n; });
  });
  for (const s of latest?.segs ?? []) setState("stale", s.id, { state: "ok" });
  toast(latest ? `Now a regular card pinned to ${latest.label}` : "Now a regular card");
}
export function keepMerged(id: string, vid: string, at: string) {
  mutate((b) => { const c = findCard(b, id)?.card as CodeCard | undefined; const v = c?.variants?.find((x) => x.id === vid); if (v) v.merged = at; });
  setMergedSig((m) => { const n = { ...m }; delete n[id]; return n; });
}
export function mergedPrompt(id: string) {
  const m = merged()[id];
  const v = m && code(id)?.variants?.find((x) => x.id === m.vid);
  if (!m || !v) return;
  toast(`${v.name} was merged into ${m.at.split(" ")[0]}. Turn this card back into a regular upstream card?`, [
    { label: "Convert", run: () => convertMerged(id) },
    { label: "Keep Variants", run: () => keepMerged(id, m.vid, m.at) },
  ], 12000);
}

// ---------- Sidenote ----------

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
