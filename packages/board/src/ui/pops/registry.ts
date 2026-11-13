// 浮层的 kind → 组件。加一种浮层：state/pop.ts 的 Pop 加一项，这里加一行（漏了类型检查会报）
import type { Component } from "solid-js";
import type { Pop } from "../../state/pop";
import type { PopProps } from "./common";
import { NotesPop, HighlightPop } from "./notes";
import { PeekPop } from "./peek";
import { DiffPop, ThreePop, CommitsPop } from "./versions";
import { VarsPop, MarkPop, ImplsPop, ValsPop, NamesPop, RpcPop } from "./chains";
import { BoardsPop, PickPop, ModifySvgPop } from "./misc";
import { SealPop } from "./seal";

export const POPS: { [K in Pop["kind"]]: Component<PopProps<K>> } = {
  notes: NotesPop,
  highlight: HighlightPop,
  peek: PeekPop,
  diff: DiffPop,
  pick: PickPop,
  commits: CommitsPop,
  vars: VarsPop,
  mark: MarkPop,
  boards: BoardsPop,
  impls: ImplsPop,
  vals: ValsPop,
  names: NamesPop,
  rpc: RpcPop,
  three: ThreePop,
  modifySvg: ModifySvgPop,
  seal: SealPop,
};
