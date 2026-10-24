// 调用链：变量、调用图标记、动态分发选实现、跨边界取值、按名字搜、RPC 箭头的属性。
import { keepKey } from "@codeboard/markdown/ui";
import { For, Show, createSignal, createMemo, createEffect } from "solid-js";
import { varKey, varText, langLabel, RPC_MECHS, type GraphMark, type Var } from "@codeboard/core";
import { state, flows } from "../../state/store";
import { closePop } from "../../state/pop";
import { Glyph } from "../../stickers/glyphs";
import * as A from "../../actions";
import { PopHead, type PopProps } from "./common";
import { useListNav } from "../hooks";

export function VarsPop(p: PopProps<"vars">) {
  const L = () => state.board.links.find((l) => l.id === p.pop.link)?.call;
  const [custom, setCustom] = createSignal("");
  const has = (v: Var) => (L()?.vars ?? []).some((x) => varKey(x) === varKey(v));
  const all = () => { const l = L(); if (!l) return []; const c = l.cands ?? []; return [...c, ...(l.vars ?? []).filter((v) => !c.some((x) => varKey(x) === varKey(v)))]; };
  return (
    <>
      <div class="picker-h">Arguments</div>
      <div class="sres">
        <For each={all()}>{(v) => <label class="chk"><input type="checkbox" checked={has(v)} onChange={() => A.toggleVar(p.pop.link, v)} />{varText(v)}</label>}</For>
        <Show when={!all().length}><div class="empty">No arguments or return value found.</div></Show>
      </div>
      <div class="an-body"><input class="fld" placeholder="Add your own (e.g. seqs[0].block_table)" value={custom()} onInput={(e) => setCustom(e.currentTarget.value)}
        onKeyDown={(e) => { keepKey(e); if (e.key === "Enter" && custom().trim()) { A.toggleVar(p.pop.link, { a: custom().trim(), custom: true }); setCustom(""); } if (e.key === "Escape") closePop(p.inst.id); }} /></div>
    </>
  );
}

// ---------- 调用图标记 ----------

/** 图标用内置贴纸（名字引用，画法跟着贴纸走） */
const MARK_ICONS = ["star", "flag", "zap", "bug", "heart", "question", "check", "hourglass"];
const MARK_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function MarkPop(p: PopProps<"mark">) {
  const g = () => flows().byId.get(p.pop.card);
  // 别的图正在用的字母（自动的或用户选的）：灰一点，但还能选
  const used = createMemo(() => new Set(flows().graphs.filter((x) => x !== g() && x.label).map((x) => x.label)));
  const pick = (m: GraphMark | null) => { closePop(p.inst.id); A.setGraphMark(p.pop.card, m); };
  const isLetter = (l: string) => { const m = g()?.mark; return !!m && "letter" in m && m.letter === l; };
  const isIcon = (n: string) => { const m = g()?.mark; return !!m && "icon" in m && m.icon === n; };
  return (
    <Show when={g()}>
      <div class="picker-h">Call Graph Mark</div>
      <div class="markgrid">
        <For each={MARK_LETTERS}>{(l) => <button class="mk-l" classList={{ on: isLetter(l), used: used().has(l) }} onClick={() => pick({ letter: l })}>{l}</button>}</For>
      </div>
      <div class="markgrid icons">
        <For each={MARK_ICONS}>{(n) => <button class="mk-i" classList={{ on: isIcon(n) }} aria-label={n} onClick={() => pick({ icon: n })}><Glyph icon={{ pack: "builtin", name: n }} size={16} /></button>}</For>
      </div>
      <button class="cand" disabled={!g()!.custom} onClick={() => pick(null)}><span class="lb">Auto</span><small>Letter by creation order</small></button>
    </Show>
  );
}

// ---------- 接上断掉的调用链（线框 01、02） ----------

/** 动态分发：N 个实现选一个。library 的要 ⌥；Why this one? 写进箭头的标签框。键盘在输入框里：↑ / ↓ 选、↵ 定、Esc 关 */
export function ImplsPop(p: PopProps<"impls">) {
  const d = () => p.pop.data;
  const [why, setWhy] = createSignal("");
  const { i, setI, key } = useListNav(() => d().impls.length);
  const go = (k: number, alt: boolean) => { if (A.pickImpl(d(), k, why(), alt)) closePop(p.inst.id); };
  const short = (q: string) => q.split(".").slice(-2).join(".");
  return (
    <>
      <PopHead title={<>{d().impls.length} implementations of <code>{short(d().base)}</code></>} inst={p.inst} right={<span class="disp-tag">Dynamic dispatch</span>} />
      <div class="sres impls">
        <For each={d().impls}>{(it, k) => {
          const lib = () => !!it.lib && !state.host.settings.studyScope.includes(it.lib);
          return (
            <button class="cand impl" classList={{ on: k() === i(), lib: lib() }} onPointerMove={() => setI(k())}
              onClick={(e) => go(k(), e.altKey)} data-tip={lib() ? `Library code (${it.lib}) · ${A.K.alt}-click to expand` : undefined}>
              <span class="kind">ƒ</span><span class="lb">{it.label}</span>
              <Show when={it.base}><span class="src-tag">base</span></Show>
              <Show when={lib()}><span class="lib-tag">library</span></Show>
              <small>{it.detail}</small>
            </button>
          );
        }}</For>
      </div>
      <div class="an-body"><input class="fld" placeholder="Why this one? (optional)" value={why()} onInput={(e) => setWhy(e.currentTarget.value)}
        ref={(el) => queueMicrotask(() => el.focus())}
        onKeyDown={(e) => {
          keepKey(e);
          if (e.key === "Escape") { e.preventDefault(); closePop(p.inst.id); }
          else if (key(e)) return;
          else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(i(), e.altKey); }
        }} /></div>
      <div class="pk-more">The others stay as grey branches next to the card you pick.</div>
    </>
  );
}

/** 跨边界的取值：kNumRanks 取几，其余的留成灰色分支 */
export function ValsPop(p: PopProps<"vals">) {
  const v = () => state.board.links.find((l) => l.id === p.pop.link)?.call?.vals?.[p.pop.val];
  createEffect(() => { if (!v()) closePop(p.inst.id); });
  return (
    <Show when={v()}>
      <div class="picker-h"><code>{v()!.name}</code>: pick a value</div>
      <Show when={v()!.from}><div class="pk-more">Comes from <code>{v()!.from}</code></div></Show>
      <For each={v()!.opts ?? [v()!.value]}>{(o) => (
        <button class="cand" classList={{ on: o === v()!.value }} onClick={() => { closePop(p.inst.id); A.setVal(p.pop.link, p.pop.val, o); }}>
          <span class="lb"><code>{v()!.name} → {o}</code></span><small>{o === v()!.value ? "✓ Current" : ""}</small>
        </button>
      )}</For>
      <div class="pk-more">Other values stay as grey branches.</div>
    </Show>
  );
}

/** 解析不到的调用：按名字在所有语言里搜，按语言分组；点一处建卡 + 虚线 Call 箭头（via registry · manual） */
export function NamesPop(p: PopProps<"names">) {
  const d = () => p.pop.data;
  const groups = createMemo(() => {
    const hs = d().hits ?? [];
    const keys = [...new Set(["python", "cpp", ...hs.map((h) => h.lang)])];
    return keys.map((k) => ({ lang: k, hits: hs.filter((h) => h.lang === k) }));
  });
  return (
    <>
      <PopHead title={<>Search <code>{A.searchedName(d().call)}</code> in all languages</>} inst={p.inst} />
      <Show when={d().hits} fallback={<div class="empty">Searching…</div>}>
        <div class="sres names">
          <For each={groups()}>{(g) => (
            <>
              <div class="grp-h">{langLabel(g.lang)}</div>
              <For each={g.hits} fallback={<div class="empty sm">no matches</div>}>{(h) => (
                <button class="cand" onClick={() => { closePop(p.inst.id); void A.placeNameHit(d(), h); }}>
                  <span class="kind">{h.def ? "ƒ" : "“”"}</span><span class="lb">{h.label}</span><small>{h.detail}</small>
                </button>
              )}</For>
            </>
          )}</For>
        </div>
      </Show>
      <div class="sn-acts"><button class="tbtn" onClick={() => { closePop(p.inst.id); A.drawManual(d().card, d().seg, d().call); }}>Draw Call Arrow Manually…</button></div>
    </>
  );
}

/** RPC 箭头的属性（线框 03 三）：机制、消息 / 方法名、一对多、插一张消息卡、↩ back to。改了马上生效，都能以后再改 */
export function RpcPop(p: PopProps<"rpc">) {
  const L = () => state.board.links.find((l) => l.id === p.pop.link);
  const r = () => L()?.rpc;
  createEffect(() => { if (!r()) closePop(p.inst.id); });
  const msg = () => A.msgOf(p.pop.link);
  const commit = (f: (x: NonNullable<ReturnType<typeof r>>) => void) => A.setRpc(p.pop.link, f);
  return (
    <Show when={r()}>
      <PopHead title={<b>RPC Arrow</b>} inst={p.inst} />
      <div class="rpcf">
        <label>Mechanism
          <select class="fld sel" value={r()!.mech} onChange={(e) => commit((x) => { x.mech = e.currentTarget.value; })}>
            <For each={RPC_MECHS}>{(m) => <option value={m}>{m}</option>}</For>
          </select>
        </label>
        <Show when={r()!.mech === "custom"}>
          <label>Name<input class="fld" value={r()!.custom ?? ""} placeholder="e.g. NCCL p2p" onKeyDown={keepKey} onChange={(e) => commit((x) => { x.custom = e.currentTarget.value.trim() || undefined; })} /></label>
        </Show>
        <label>Message / method<input class="fld mono" value={r()!.msg ?? ""} placeholder={`"run"  ·  TokenizedGenerateReqInput`} onKeyDown={(e) => { keepKey(e); if (e.key === "Enter") e.currentTarget.blur(); }} onChange={(e) => commit((x) => { x.msg = e.currentTarget.value.trim() || undefined; })} /></label>
        <label>Fan-out
          <select class="fld sel" value={r()!.fan ?? "one"} onChange={(e) => commit((x) => { x.fan = e.currentTarget.value === "all" ? "all" : undefined; })}>
            <option value="one">One to one</option>
            <option value="all">One to all ranks</option>
          </select>
        </label>
        <label class="chk"><input type="checkbox" checked={!!msg()} onChange={() => A.toggleMsgCard(p.pop.link)} />Insert message card<small>sender → message → receiver</small></label>
        <label class="chk"><input type="checkbox" checked={!!L()?.back} onChange={() => A.toggleBack(p.pop.link)} />↩ Back to start<small>Walkthrough stops here</small></label>
      </div>
      <div class="sn-acts"><span class="grow" /><button class="tbtn" onClick={() => { closePop(p.inst.id); A.clearRpc(p.pop.link); }}>Remove RPC Mark</button></div>
    </Show>
  );
}
