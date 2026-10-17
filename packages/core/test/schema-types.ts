// 编译期检查（npm run typecheck 会查 test/）：model.ts 的类型和 schema.ts 的 valibot 校验是手工并行维护的，这里对一下。
// 1. 程序写出来的任何 Board 都能通过校验（Board 可以赋给 schema 的输入类型）；
// 2. 每种对象（每种 kind 分开）两边的字段名一样，少了或多了都报错。
// 不比可选 / 必填和 null：schema 故意更宽（可选字段允许 null；Board.id、Section.title、Segment.lang 在文件里可以缺；true 写成 boolean）
import type * as v from "valibot";
import type { BoardFileSchema, BoardSchema, CodeCardSchemaKeys, SharedCardSchema } from "../src/schema";
import type { Board, BoardFile, Card, CodeCard, Link, Place, Section, Segment, SharedCardFile, SharedRef, Sidenote, Sticker } from "../src/model";

type In = v.InferInput<typeof BoardSchema>;
type Out = v.InferOutput<typeof BoardSchema>;

/** 去掉 looseObject 的 [key: string]: unknown，只留写明的字段 */
type Keys<T> = T extends unknown ? keyof { [K in keyof T as string extends K ? never : K]: T[K] } : never;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** 两边字段名一样；不一样时报错信息里能看到多出来的名字 */
type SameKeys<T, S> = Same<Keys<T>, Keys<S>> extends true ? true : { model: Exclude<Keys<T>, Keys<S>>; schema: Exclude<Keys<S>, Keys<T>> };
type ByKind<T, K> = Extract<T, { kind: K }>;
type EachKind<T extends { kind: string }, S> = { [K in T["kind"]]: SameKeys<ByKind<T, K>, ByKind<S, K>> };
type AllTrue<T> = { [K in keyof T]: T[K] extends true ? true : T[K] };

const ok = <T extends true>(x: T) => x;
type SNote = Out["sidenotes"][number];

export const writes: In = {} as Board;
// 第 6 版：白板文件（cards 里可以有共享卡的引用）、卡库里的共享卡
type FileOut = v.InferOutput<typeof BoardFileSchema>;
type SharedOut = v.InferOutput<typeof SharedCardSchema>;
export const fileWrites: v.InferInput<typeof BoardFileSchema> = {} as BoardFile;
export const sharedWrites: v.InferInput<typeof SharedCardSchema> = {} as SharedCardFile;
export const keys = {
  board: ok({} as SameKeys<Board, Out>),
  place: ok({} as SameKeys<Place, Out["place"][string]>),
  link: ok({} as SameKeys<Link, Out["links"][number]>),
  section: ok({} as SameKeys<Section, Out["sections"][number]>),
  sticker: ok({} as SameKeys<Sticker, Out["stickers"][number]>),
  segment: ok({} as SameKeys<Segment, ByKind<SNote, "code">["code"]>),
  file: ok({} as SameKeys<BoardFile, FileOut>),
  ref: ok({} as SameKeys<SharedRef, ByKind<FileOut["cards"][number], "shared">>),
  shared: ok({} as SameKeys<SharedCardFile, SharedOut>),
  code: ok({} as Same<keyof CodeCard, CodeCardSchemaKeys> extends true ? true : { model: Exclude<keyof CodeCard, CodeCardSchemaKeys>; schema: Exclude<CodeCardSchemaKeys, keyof CodeCard> }),
};
export const cards: AllTrue<EachKind<Exclude<Card, CodeCard>, Out["cards"][number]>> = { note: true, image: true, web: true, links: true, compare: true, board: true };
export const sidenotes: AllTrue<EachKind<Sidenote, SNote>> = { code: true, paste: true, text: true, link: true, card: true };
