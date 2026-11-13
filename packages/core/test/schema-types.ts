// 编译期检查（npm run typecheck 会查 test/）：model.ts 的类型和 schema.ts 的 valibot 校验是手工并行维护的，这里对一下。
// 1. 程序写出来的任何 Board 都能通过校验（Board 可以赋给 schema 的输入类型）；
// 2. 每种对象（每种 kind 分开）两边的字段名一样，少了或多了都报错。
// 不比可选 / 必填和 null：schema 故意更宽（可选字段允许 null；Board.id、Section.title、Segment.lang 在文件里可以缺；true 写成 boolean）
import type * as v from "valibot";
import type { BoardFileSchema, BoardSchema, CodeCardSchemaOut, SharedCardSchema, VariantSchema } from "../src/schema";
import type {
  Anchor,
  BlockRef,
  Board,
  BoardFile,
  Variant,
  VariantFrom,
  CallEvidence,
  CallSample,
  RpcMark,
  Card,
  CodeAnnot,
  CodeCard,
  End,
  GraphMark,
  HideFlags,
  Link,
  LinkItem,
  LinkStyle,
  NoteLayout,
  Place,
  ProcTag,
  Question,
  Section,
  Segment,
  SharedCardFile,
  SharedRef,
  ShelfEntry,
  Sidenote,
  Source,
  Sticker,
  StickerAt,
  StickerOn,
  Summary,
  SummaryPair,
  SymRef,
  Version,
  WebMeta,
} from "../src/model";
import type { BoundVal, CallAlt } from "@codeboard/analysis/basics";

type In = v.InferInput<typeof BoardSchema>;
type Out = v.InferOutput<typeof BoardSchema>;

/** 去掉 looseObject 的 [key: string]: unknown，只留写明的字段 */
type Keys<T> = T extends unknown ? keyof { [K in keyof T as string extends K ? never : K]: T[K] } : never;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** 两边字段名一样；不一样时报错信息里能看到多出来的名字 */
type SameKeys<T, S> =
  Same<Keys<T>, Keys<S>> extends true ? true : { model: Exclude<Keys<T>, Keys<S>>; schema: Exclude<Keys<S>, Keys<T>> };
type ByKind<T, K> = Extract<T, { kind: K }>;
type EachKind<T extends { kind: string }, S> = { [K in T["kind"]]: SameKeys<ByKind<T, K>, ByKind<S, K>> };
type AllTrue<T> = { [K in keyof T]: T[K] extends true ? true : T[K] };

const ok = <T extends true>(x: T) => x;
type SNote = Out["sidenotes"][number];
type VOut = v.InferOutput<typeof VariantSchema>;
type OutCard = Out["cards"][number];
type OutLink = Out["links"][number];
type OutSegment = ByKind<SNote, "code">["code"];
type OutSummary = NonNullable<Out["place"][string]["summary"]>;
type OutLayout = NonNullable<ByKind<OutCard, "note">["mdLayout"]>;
type OutAt = Out["stickers"][number]["at"];
export const variantWrites: v.InferInput<typeof VariantSchema> = {} as Variant;

export const writes: In = {} as Board;
// 白板文件（cards 里可以有共享卡的引用）、卡库里的共享卡
type FileOut = v.InferOutput<typeof BoardFileSchema>;
type SharedOut = v.InferOutput<typeof SharedCardSchema>;
export const fileWrites: v.InferInput<typeof BoardFileSchema> = {} as BoardFile;
export const sharedWrites: v.InferInput<typeof SharedCardSchema> = {} as SharedCardFile;
export const keys = {
  board: ok({} as SameKeys<Board, Out>),
  place: ok({} as SameKeys<Place, Out["place"][string]>),
  link: ok({} as SameKeys<Link, Out["links"][number]>),
  call: ok({} as SameKeys<NonNullable<Link["call"]>, NonNullable<Out["links"][number]["call"]>>),
  ev: ok({} as SameKeys<CallEvidence, NonNullable<NonNullable<Out["links"][number]["call"]>["ev"]>>),
  alt: ok({} as SameKeys<CallAlt, NonNullable<NonNullable<Out["links"][number]["call"]>["alts"]>[number]>),
  val: ok({} as SameKeys<BoundVal, NonNullable<NonNullable<Out["links"][number]["call"]>["vals"]>[number]>),
  sample: ok({} as SameKeys<CallSample, NonNullable<NonNullable<Out["links"][number]["call"]>["seen"]>[number]>),
  rpc: ok({} as SameKeys<RpcMark, NonNullable<Out["links"][number]["rpc"]>>),
  section: ok({} as SameKeys<Section, Out["sections"][number]>),
  sticker: ok({} as SameKeys<Sticker, Out["stickers"][number]>),
  shelf: ok({} as SameKeys<ShelfEntry, NonNullable<Out["shelf"]>[number]>),
  segment: ok({} as SameKeys<Segment, OutSegment>),
  symbol: ok({} as SameKeys<SymRef, NonNullable<OutSegment["symbol"]>>),
  annot: ok({} as SameKeys<CodeAnnot, NonNullable<OutSegment["annots"]>[number]>),
  summary: ok({} as SameKeys<Summary, OutSummary>),
  summaryPair: ok({} as SameKeys<SummaryPair, NonNullable<OutSummary["pairs"]>[number]>),
  end: ok({} as SameKeys<End, OutLink["from"]>),
  block: ok({} as SameKeys<BlockRef, NonNullable<OutLink["from"]["block"]>>),
  linkStyle: ok({} as SameKeys<LinkStyle, NonNullable<OutLink["style"]>>),
  linkHead: ok({} as SameKeys<NonNullable<LinkStyle["head"]>, NonNullable<NonNullable<OutLink["style"]>["head"]>>),
  linkSides: ok({} as SameKeys<NonNullable<Link["sides"]>, NonNullable<OutLink["sides"]>>),
  linkLost: ok({} as SameKeys<NonNullable<Link["lost"]>, NonNullable<OutLink["lost"]>>),
  proc: ok({} as SameKeys<ProcTag, NonNullable<ByKind<OutCard, "note">["procs"]>[number]>),
  webMeta: ok({} as SameKeys<WebMeta, NonNullable<ByKind<OutCard, "web">["meta"]>>),
  linkItem: ok({} as SameKeys<LinkItem, ByKind<OutCard, "links">["items"][number]>),
  noteLayout: ok({} as SameKeys<NoteLayout, OutLayout>),
  noteTable: ok(
    {} as SameKeys<
      NonNullable<NonNullable<NoteLayout["tables"]>[number]>,
      NonNullable<NonNullable<OutLayout["tables"]>[number]>
    >,
  ),
  msg: ok({} as SameKeys<NonNullable<ByKind<Card, "note">["msg"]>, NonNullable<ByKind<OutCard, "note">["msg"]>>),
  anchor: ok({} as SameKeys<Anchor, SNote["at"]>),
  stickerOn: ok({} as SameKeys<StickerOn, NonNullable<ByKind<OutAt, "canvas">["on"]>>),
  question: ok({} as SameKeys<Question, NonNullable<Out["stickers"][number]["q"]>>),
  graphMark: ok({} as SameKeys<GraphMark, NonNullable<Out["marks"]>[string]>),
  hide: ok({} as SameKeys<HideFlags, NonNullable<CodeCardSchemaOut["hide"]>>),
  members: ok({} as SameKeys<NonNullable<CodeCard["members"]>, NonNullable<CodeCardSchemaOut["members"]>>),
  gen: ok({} as SameKeys<NonNullable<CodeCard["gen"]>, NonNullable<CodeCardSchemaOut["gen"]>>),
  file: ok({} as SameKeys<BoardFile, FileOut>),
  ref: ok({} as SameKeys<SharedRef, ByKind<FileOut["cards"][number], "shared">>),
  shared: ok({} as SameKeys<SharedCardFile, SharedOut>),
  // Variant：CodeCard 的 schema 是递归的 GenericSchema 推不出类型，Variant 单独导出来对
  variant: ok({} as SameKeys<Variant, VOut>),
  code: ok({} as SameKeys<CodeCard, CodeCardSchemaOut>),
};
export const stickerAts: AllTrue<EachKind<StickerAt, OutAt>> = { line: true, canvas: true };
export const versions: AllTrue<EachKind<Version, OutSegment["version"]>> = {
  git: true,
  pkg: true,
  hash: true,
  none: true,
};
export const sources: AllTrue<EachKind<Source, OutSegment["src"]>> = {
  repo: true,
  external: true,
  github: true,
  free: true,
};
export const cards: AllTrue<EachKind<Exclude<Card, CodeCard>, Out["cards"][number]>> = {
  note: true,
  image: true,
  web: true,
  links: true,
  compare: true,
  board: true,
};
export const sidenotes: AllTrue<EachKind<Sidenote, SNote>> = {
  code: true,
  text: true,
};
export const variantFroms: AllTrue<EachKind<VariantFrom, VOut["from"]>> = {
  upstream: true,
  ref: true,
  worktree: true,
  wt: true,
  file: true,
  pr: true,
};
