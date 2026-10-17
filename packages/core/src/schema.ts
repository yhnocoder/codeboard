// 读白板文件时的校验（valibot）。loadBoard = 先看是不是对象、版本是不是认得 → migrateBoard 迁到当前版本 → 按当前版本的结构校验。
// 校验的是迁移之后的结果，所以加新版本只要改迁移和这里的当前结构；旧文件的样子由迁移负责。
// 只拦会让白板读坏的东西（类型不对、缺必填字段、kind 不认得），可选字段允许缺或 null，不认得的字段原样保留。
import * as v from "valibot";
import { BOARD_VERSION, migrateBoard, type Board, type BoardFile, type SharedCardFile } from "./model";

const str = v.string(), num = v.number(), bool = v.boolean();
const opt = <T extends v.GenericSchema>(s: T) => v.nullish(s);
const obj = v.looseObject;

const Version = v.variant("kind", [
  obj({ kind: v.literal("git"), commit: str, uncommitted: opt(bool) }),
  obj({ kind: v.literal("pkg"), name: str, version: str }),
  obj({ kind: v.literal("hash"), hash: str }),
  obj({ kind: v.literal("none") }),
]);
const Source = v.variant("kind", [
  obj({ kind: v.literal("repo"), repo: str }),
  obj({ kind: v.literal("external"), root: str }),
  obj({ kind: v.literal("github"), owner: str, name: str, ref: str }),
  obj({ kind: v.literal("free"), url: opt(str) }),
]);
const Segment = obj({
  id: str, src: Source, path: str, lang: opt(str), start: num, end: num, text: v.array(str), version: Version,
  symbol: opt(obj({ qual: str, kind: v.picklist(["function", "class", "module"]) })), scope: opt(str),
  hidden: opt(v.array(v.tuple([num, num]))), hl: opt(v.array(num)), keep: opt(str),
});

const Place = obj({ x: num, y: num, w: num, h: opt(num), section: opt(str), locked: opt(bool), collapsed: opt(bool) });

const base = { id: str, title: opt(str), desc: opt(str) };
const WebMeta = obj({ title: opt(str), desc: opt(str), site: opt(str), image: opt(str), icon: opt(str), at: opt(num), failed: opt(bool) });
const codeEntries = {
  ...base, kind: v.literal("code"), segments: v.array(Segment),
  hide: opt(obj({ comments: opt(bool), docstrings: opt(bool), blank: opt(bool) })), wrap: opt(bool), nobg: opt(bool),
  members: opt(obj({ shown: v.array(str) })),
  mergedFrom: opt(v.array(obj({ card: v.lazy(() => CodeCard), place: Place }))), keepOld: opt(bool),
};
const CodeCard: v.GenericSchema = obj(codeEntries);
/** 代码卡是递归的（mergedFrom），上面只能标成 GenericSchema；它的字段名单独导出给 test/schema-types.ts 和 model.ts 的 CodeCard 对照 */
export type CodeCardSchemaKeys = keyof typeof codeEntries;
const Card = v.variant("kind", [
  CodeCard as v.LooseObjectSchema<{ kind: v.LiteralSchema<"code", undefined> }, undefined>,
  obj({ ...base, kind: v.literal("note"), md: str, bg: opt(bool), size: opt(v.picklist(["title", "heading", "body"])), bold: opt(bool) }),
  obj({ ...base, kind: v.literal("image"), src: str, alt: opt(str), bg: opt(bool) }),
  obj({ ...base, kind: v.literal("web"), url: str, meta: opt(WebMeta), style: opt(v.picklist(["banner", "side", "text", "compact"])) }),
  obj({ ...base, kind: v.literal("links"), items: v.array(obj({ id: str, url: str, title: opt(str), meta: opt(WebMeta), rich: opt(bool) })), rich: opt(bool) }),
  obj({ ...base, kind: v.literal("compare"), cols: v.tuple([str, str]), swap: opt(bool), unified: opt(bool), hideSame: opt(bool) }),
  obj({ ...base, kind: v.literal("board"), board: str }),
]);

const End = obj({ card: str, seg: opt(str), line: opt(num), sub: opt(str) });
const Var = obj({ a: str, b: opt(str), ret: opt(bool), custom: opt(bool) });
const Side = v.picklist(["left", "right", "top", "bottom"]);
const Link = obj({
  id: str, from: End, to: End, label: opt(str), at: opt(num),
  call: opt(obj({ name: str, col: num, vars: opt(v.array(Var)), cands: opt(v.array(Var)), loop: opt(bool) })),
  style: opt(obj({ dash: opt(bool), width: opt(v.picklist([1, 2, 3])), head: opt(obj({ start: opt(bool), end: opt(bool) })), color: opt(str) })),
  sides: opt(obj({ from: opt(Side), to: opt(Side) })),
  lost: opt(obj({ from: opt(bool), to: opt(bool) })),
});
const GraphMark = v.union([obj({ letter: str }), obj({ icon: str })]);

const Section = obj({ id: str, title: opt(str), x: num, y: num, w: num, h: num, parent: opt(str), color: opt(str), collapsed: opt(bool), locked: opt(bool), desc: opt(str) });

const noteBase = { id: str, at: obj({ card: str, seg: opt(str), lines: opt(v.tuple([num, num])) }), why: opt(str), lineRemoved: opt(bool), boardOnly: opt(bool), review: opt(str) };
const Sidenote = v.variant("kind", [
  obj({ ...noteBase, kind: v.literal("code"), code: Segment }),
  obj({ ...noteBase, kind: v.literal("paste"), text: str, lang: str, url: opt(str) }),
  obj({ ...noteBase, kind: v.literal("text"), md: str, alwaysShow: opt(bool) }),
  obj({ ...noteBase, kind: v.literal("link"), url: str, title: opt(str) }),
  obj({ ...noteBase, kind: v.literal("card"), card: str }),
]);

const Sticker = obj({
  id: str, icon: obj({ pack: str, name: str }), color: opt(str),
  at: v.variant("kind", [
    obj({ kind: v.literal("line"), card: str, seg: str, line: num }),
    obj({ kind: v.literal("card"), card: str }),
    obj({ kind: v.literal("canvas"), x: num, y: num, size: opt(num), on: opt(v.union([obj({ card: str }), obj({ link: str, t: num })])) }),
  ]),
});

const boardEntries = {
  version: v.literal(BOARD_VERSION), id: opt(str), name: str, cam: obj({ x: num, y: num, z: num }),
  cards: v.array(Card), place: v.record(str, Place), links: v.array(Link), sections: v.array(Section), sidenotes: v.array(Sidenote), stickers: v.array(Sticker),
  hideAllComments: opt(bool), hideNumbers: opt(bool),
  born: opt(v.record(str, num)), seq: opt(num), marks: opt(v.record(str, GraphMark)),
};
/** 当前版本（迁移之后）、共享卡已经换成内容的白板（界面拿到的）。id 可以缺：宿主扫描时按文件名补 */
export const BoardSchema = obj(boardEntries);
/** 白板文件：cards 里还可以有共享卡的引用 */
const SharedRef = obj({ id: str, kind: v.literal("shared") });
export const BoardFileSchema = obj({ ...boardEntries, cards: v.array(v.union([Card, SharedRef])) });
/** 卡库里的一张共享卡 */
export const SharedCardSchema = obj({ version: v.literal(BOARD_VERSION), card: Card, sidenotes: v.array(Sidenote), rev: v.record(str, num) });

/** 迁移前只要求是个对象、版本号（有的话）是数字；认不认得这个版本由 migrateBoard 判断 */
const RawBoard = v.pipe(v.custom((x) => !!x && typeof x === "object" && !Array.isArray(x), "Expected a board object"), obj({ version: opt(num) }));

/** 校验失败：message 里带出错的路径（如 cards.3.segments.0.text） */
export class BoardError extends Error {}

function check(schema: v.GenericSchema, x: unknown, what: string) {
  const r = v.safeParse(schema, x);
  if (r.success) return;
  const lines = r.issues.slice(0, 3).map((i) => `${v.getDotPath(i) ?? "(root)"}: ${i.message}`);
  throw new BoardError(`${what}: ${lines.join("; ")}${r.issues.length > 3 ? ` (+${r.issues.length - 3} more)` : ""}`);
}

/** 读进来的白板 JSON（任何版本）→ 校验过的当前版本白板（不能有共享卡的引用：宿主发给界面的、测试里的白板） */
export function loadBoard(raw: unknown): Board {
  check(RawBoard, raw, "Not a board file");
  const b = migrateBoard(raw);
  check(BoardSchema, b, "Invalid board");
  return b;
}

/** 白板文件（任何版本）→ 校验过的第 6 版白板文件（共享卡还是引用，由宿主的存储换成内容） */
export function loadBoardFile(raw: unknown): BoardFile {
  check(RawBoard, raw, "Not a board file");
  const b = migrateBoard(raw) as BoardFile;
  check(BoardFileSchema, b, "Invalid board");
  return b;
}

/** 卡库里的文件 cards/<id>.json → 校验过的共享卡 */
export function loadSharedCard(raw: unknown): SharedCardFile {
  check(SharedCardSchema, raw, "Invalid shared card");
  return raw as SharedCardFile;
}
