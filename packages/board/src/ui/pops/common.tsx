// 各种浮层共用：卡头（标题、Pinned、关闭）、一小段只读代码
import { For, Show, type JSX } from "solid-js";
import { closePop, type PopInst, type Pop } from "../../state/pop";
import { Icon } from "../icons";

/** 一种浮层的组件拿到的参数：pop 已经按 kind 收窄 */
export type PopProps<K extends Pop["kind"]> = { inst: PopInst; pop: Extract<Pop, { kind: K }> };

export function PopHead(p: { title: JSX.Element; inst: PopInst; right?: JSX.Element }) {
  return (
    <div class="ph">
      <span class="pt">{p.title}</span><span class="grow" />{p.right}
      <Show when={p.inst.pinned}><span class="pinned">Pinned</span></Show>
      <button class="ib" aria-label="Close" onClick={() => closePop(p.inst.id)}><Icon name="close" size={13} /></button>
    </div>
  );
}

/** 一小段只读代码（带行号）；rows = 每行的行号（不连续时） */
export function Code(p: { start: number; html: string[]; hl?: number; rows?: number[] }) {
  const no = (i: number) => p.rows?.[i] ?? p.start + i;
  return (
    <div class="pcode"><div class="pc-in">
      <For each={p.html}>{(h, i) => <div class="pl" classList={{ hl: p.hl === no(i()), jump: i() > 0 && !!p.rows && no(i()) !== no(i() - 1) + 1 }}><span class="no">{no(i())}</span><span class="t" innerHTML={h || "​"} /></div>}</For>
    </div></div>
  );
}
