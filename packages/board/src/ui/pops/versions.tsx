import { keepKey } from "@yhnocoder/markdown/ui";
import { For, Show, createSignal, createMemo } from "solid-js";
import { alignRows, wordDiff, cardTitle, versionLabel, isCode, segOf, escHtml, threeWay, upstreamSegs, activeOf, viewKeyOf, UPSTREAM, type Segment } from "@codeboard/core";
import { state, cardById, toast } from "../../state/store";
import { closePop } from "../../state/pop";
import { vlive } from "../../state/variants";
import { markHtml } from "../../cards/CompareBody";
import { ask } from "../../host";
import * as A from "../../actions";
import { PopHead, type PopProps } from "./common";

// 版本 diff：和 Compare 同一套对齐

function DiffTable(p: { left: { start: number; text: string[]; html: string[] }; right: { start: number; text: string[]; html: string[] } }) {
  const rows = createMemo(() => {
    const norm = (s: string) => s.trim().replace(/\s+/g, " ");
    return alignRows(p.left.text.map(norm), p.right.text.map(norm)).map((r) => {
      let lh = r.l !== undefined ? p.left.html[r.l] : undefined, rh = r.r !== undefined ? p.right.html[r.r] : undefined;
      if (r.kind === "changed") { const w = wordDiff(p.left.text[r.l!], p.right.text[r.r!]); lh = markHtml(lh!, w.a); rh = markHtml(rh!, w.b); }
      return { ...r, lh, rh };
    });
  });
  // 只显示改动附近的行（上下各 2 行），其余收起
  const items = createMemo(() => {
    const rs = rows(), keep = new Set<number>();
    rs.forEach((r, i) => { if (r.kind !== "same") for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
    const out: ({ t: "row"; i: number } | { t: "gap"; n: number })[] = [];
    for (let i = 0; i < rs.length; i++) {
      if (keep.has(i) || rs.length < 14) { out.push({ t: "row", i }); continue; }
      let j = i; while (j < rs.length && !keep.has(j)) j++;
      out.push({ t: "gap", n: j - i }); i = j - 1;
    }
    return out;
  });
  const cell = (l: number | undefined, start: number, h?: string) => (l === undefined ? <div class="cl void" /> : <div class="cl"><span class="cno">{start + l}</span><span class="l" innerHTML={h || "​"} /></div>);
  return (
    <div class="crows dt">
      <For each={items()}>{(it) => it.t === "gap" ? <div class="cgap">⋯ {it.n} same lines</div> : (() => { const r = rows()[it.i]; return <div class={`crow ${r.kind}`}>{cell(r.l, p.left.start, r.lh)}{cell(r.r, p.right.start, r.rh)}</div>; })()}</For>
    </div>
  );
}

export function DiffPop(p: PopProps<"diff">) {
  const d = () => p.pop.data;
  const seg = () => { const c = cardById(p.pop.card)?.card; return isCode(c) ? segOf(c, p.pop.seg) : undefined; };
  const impact = createMemo(() => {
    const links = state.board.links.filter((l) => l.from.card === p.pop.card && l.from.seg === p.pop.seg && l.from.line).length;
    const notes = state.board.sidenotes.filter((n) => n.at.card === p.pop.card && n.at.seg === p.pop.seg && n.at.lines).length;
    const hl = seg()?.hl?.length ?? 0;
    const parts = [hl && `${hl} highlight${hl > 1 ? "s" : ""}`, links && `${links} link${links > 1 ? "s" : ""}`, notes && `${notes} sidenote${notes > 1 ? "s" : ""}`].filter(Boolean);
    return parts.length ? `On update: ${parts.join(", ")} move with their lines; anything on a removed line attaches to the whole card.` : "";
  });
  return (
    <div class="diffpop">
      <PopHead title={d()?.title ?? "Loading diff…"} inst={p.inst} />
      <Show when={p.pop.error}><div class="empty">{p.pop.error}</div></Show>
      <Show when={d()}>
        <Show when={d()!.lastChange}><div class="lastc">{d()!.lastChange}</div></Show>
        <div class="colh dh"><div class="coll"><b>{d()!.left.label}</b><span>{d()!.left.path}:{d()!.left.start}</span></div><div class="colr"><b>{d()!.right.label}</b><span>{d()!.right.path}:{d()!.right.start}</span></div></div>
        <div class="dbody"><DiffTable left={d()!.left} right={d()!.right} /></div>
        <Show when={impact()}><div class="lastc">{impact()}</div></Show>
        <div class="db">
          <button onClick={() => { A.duplicateNewVersion(p.pop.card, p.pop.seg, d()!); closePop(p.inst.id); }} disabled={!d()!.newSeg}>Duplicate as New Version</button>
          <span class="grow" />
          <button onClick={() => { A.keepVersion(p.pop.card, p.pop.seg); closePop(p.inst.id); }}>Keep {d()!.left.label.replace(/^Pinned /, "")}</button>
          <button class="def" disabled={!d()!.canUpdate} onClick={() => { A.applyNewVersion(p.pop.card, p.pop.seg, d()!); closePop(p.inst.id); }}>Update to {d()!.right.label.replace(/^HEAD /, "")}</button>
        </div>
      </Show>
    </div>
  );
}

// 三方对照：原版 / 我的 / 上游最新，两边都改了的行高亮

export function ThreePop(p: PopProps<"three">) {
  const c = () => { const k = cardById(p.pop.card)?.card; return isCode(k) ? k : undefined; };
  const cols = createMemo(() => {
    const k = c(), l = vlive[p.pop.card]?.latest;
    if (!k || !l) return [];
    const ups = upstreamSegs(k), cur = activeOf(k);
    const html = (s: Segment, key: string) => state.views[key]?.html ?? s.text.map(escHtml);
    return k.segments.map((s) => {
      const b = ups.find((x) => x.id === s.id) ?? s, t = l.segs.find((x) => x.id === s.id) ?? b;
      const tw = threeWay(b.text, s.text, t.text);
      return {
        id: s.id, conflicts: tw.conflicts,
        cols: [
          { label: `Base ${versionLabel(b.version, true)}`, start: b.start, html: html(b, viewKeyOf(k, b.id, UPSTREAM)), kinds: tw.base },
          { label: `Mine ${k.variants?.find((v) => v.id === cur)?.name ?? ""}`, start: s.start, html: html(s, s.id), kinds: tw.mine },
          { label: `Upstream latest ${l.label}`, start: t.start, html: l.views[t.id]?.html ?? t.text.map(escHtml), kinds: tw.latest },
        ],
      };
    });
  });
  const total = () => cols().reduce((n, x) => n + x.conflicts, 0);
  return (
    <div class="threepop">
      <PopHead title={`Three-way view · ${c() ? cardTitle(c()!) : ""}`} inst={p.inst} />
      <div class="lastc">{total() ? `${total()} line${total() > 1 ? "s" : ""} changed on both sides (highlighted)` : "No conflicting lines: your changes and upstream's don't touch the same lines"}</div>
      <For each={cols()}>{(sg) => (
        <div class="three">
          <For each={sg.cols}>{(col) => (
            <div class="tcol">
              <div class="th"><b>{col.label}</b></div>
              <div class="tb">
                <For each={col.html}>{(h, i) => <div class={`tl k-${col.kinds[i()] ?? "same"}`}><span class="cno">{col.start + i()}</span><span class="l" innerHTML={h || "​"} /></div>}</For>
              </div>
            </div>
          )}</For>
        </div>
      )}</For>
    </div>
  );
}

export function CommitsPop(p: PopProps<"commits">) {
  const [ref, setRef] = createSignal("");
  const pinned = () => (p.pop.seg.version.kind === "git" ? p.pop.seg.version.commit : "");
  const go = async () => {
    const r = ref().trim();
    if (!r) return;
    const got = await ask("resolveRef", { text: r }).catch((e) => { toast((e as Error).message); return null; });
    const sha = typeof got === "string" ? got : got?.commit;
    if (!got) toast(`No commit matches “${r}”`);
    if (sha) { closePop(p.inst.id); A.switchCommit(p.pop.card, sha); }
  };
  return (
    <>
      <div class="picker-h">Commits that changed this {p.pop.seg.symbol ? "symbol" : "range"}</div>
      <Show when={p.pop.list} fallback={<div class="empty">Loading…</div>}>
        <div class="sres">
          <For each={p.pop.list}>{(c) => (
            <button class="cand" classList={{ on: c.commit === pinned() }} onClick={() => { closePop(p.inst.id); if (c.commit !== pinned()) A.switchCommit(p.pop.card, c.commit); }}>
              <span class="sha">{c.commit.slice(0, 7)}</span><span class="lb">{c.msg}</span><small classList={{ cur: c.commit === pinned() }}>{c.commit === pinned() ? "✓ Current" : c.head ? "= HEAD" : c.date}</small>
            </button>
          )}</For>
          <Show when={!p.pop.list!.length}><div class="empty">No history (not in git).</div></Show>
        </div>
      </Show>
      <div class="an-body"><input class="fld" placeholder="Enter commit, branch or tag" value={ref()} onInput={(e) => setRef(e.currentTarget.value)} onKeyDown={(e) => { keepKey(e); if (e.key === "Enter") go(); if (e.key === "Escape") closePop(p.inst.id); }} /></div>
      <Show when={A.uncommitted(cardById(p.pop.card)?.card as any) || state.stale[p.pop.seg.id]?.state === "uncommitted"}>
        <button class="cand" onClick={() => { closePop(p.inst.id); A.openWorktreeDiff(p.pop.card); }}><span class="lb">Show Uncommitted Changes</span><small>HEAD vs Working Tree</small></button>
      </Show>
    </>
  );
}
