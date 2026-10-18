// 浮层的 kind → 组件。加一种浮层：state/pop.ts 的 Pop 加一项，这里加一行（漏了类型检查会报）
import type { Component } from "solid-js";
import type { Pop } from "../../state/pop";
import type { PopProps } from "./common";
import { NotesPop, AddNotePop } from "./notes";
import { PeekPop } from "./peek";
import { DiffPop, ThreePop, CommitsPop } from "./versions";
import { VarsPop, MarkPop, ImplsPop, ValsPop, NamesPop, RpcPop } from "./chains";
import { QuestionPop, BoardsPop, PickPop } from "./misc";

export const POPS: { [K in Pop["kind"]]: Component<PopProps<K>> } = {
  notes: NotesPop, peek: PeekPop, addNote: AddNotePop, diff: DiffPop, pick: PickPop, commits: CommitsPop, vars: VarsPop, mark: MarkPop,
  boards: BoardsPop, impls: ImplsPop, vals: ValsPop, names: NamesPop, rpc: RpcPop, three: ThreePop, question: QuestionPop,
};
