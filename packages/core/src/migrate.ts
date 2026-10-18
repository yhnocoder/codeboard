// 旧白板文件 → 当前版本（第 6 版）。项目里唯一的兼容代码：旧版本的结构、缺省的字段、手改出来的 null 都在这里补成
// 和 model.ts 的类型一模一样，读进来之后的代码只认当前结构。schema.ts 校验的是这里的结果。
import { BOARD_VERSION, cornerAt, emptyBoard, isCode, uid, type BoardFile, type Card, type Link, type LinkStyle, type Place, type Segment, type SharedCardFile, type Sidenote, type Sticker } from "./model";

/** 读进来的白板文件（第 1–6 版）→ 第 6 版白板文件（共享卡还是引用，由宿主的存储换成内容） */
export function migrateBoard(raw: any): BoardFile {
  // 更新的版本写的文件：读不懂就别碰（当第 1 版迁移会丢掉所有卡，下次自动保存把空白板写回去）
  if (typeof raw?.version === "number" && raw.version > BOARD_VERSION) throw new Error(`Board file version ${raw.version} is newer than this CodeBoard (${BOARD_VERSION}). Update CodeBoard to open it.`);
  let b = dropNulls(raw);
  if (!(b?.version >= 3)) b = v2to3(b?.version === 2 ? b : v1to2(b));
  b.place ??= {};
  b.links ??= [];
  b.sections ??= [];
  b.sidenotes ??= [];
  b.stickers ??= [];
  if (b.version === 3) v3to4(b);
  if (b.version === 4) v4to5(b);
  // 第 5 版 → 第 6 版：多了共享卡的引用和 Sidenote 的 boardOnly，旧文件里都没有
  b.version = BOARD_VERSION;
  normalize(b);
  return b as BoardFile;
}

/** 卡库里的文件 cards/<id>.json：和白板文件一样补齐 */
export function migrateSharedCard(raw: any): SharedCardFile {
  const sc = dropNulls(raw);
  if (sc?.card) normCard(sc.card);
  for (const n of sc?.sidenotes ?? []) normNote(n);
  return sc;
}

// ---------- 补成当前类型 ----------

/** 可选字段写成 null 的（手改、旧版本）：当没有 */
function dropNulls(x: any): any {
  if (Array.isArray(x)) return x.map(dropNulls);
  if (!x || typeof x !== "object") return x;
  const o: any = {};
  for (const [k, v] of Object.entries(x)) if (v !== null) o[k] = dropNulls(v);
  return o;
}

/** 类型里只能是 true 的开关：false 当没有 */
function dropFalse(o: any, keys: string[]) {
  if (o) for (const k of keys) if (o[k] === false) delete o[k];
}

function normSeg(s: Segment) {
  s.lang ??= "plaintext";
}

function normCard(c: Card) {
  if (c.kind === "note") c.bg ??= false;
  if (c.kind !== "code") return;
  dropFalse(c, ["keepOld"]);
  c.segments.forEach(normSeg);
  for (const v of c.variants ?? []) v.segs?.forEach(normSeg);
  for (const m of c.mergedFrom ?? []) normCard(m.card);
}

function normNote(n: Sidenote) {
  dropFalse(n, ["boardOnly"]);
  if (n.kind === "code") normSeg(n.code);
}

function normLink(l: Link) {
  dropFalse(l, ["gen", "back"]);
  // Generated from 独占（LinkMarks）：旧版能给它再加 Call / RPC / back，用户后加的标记留下，gen 去掉
  if (l.gen && (l.call || l.rpc || l.back)) delete (l as { gen?: true }).gen;
  dropFalse(l.style, ["dash"]);
  dropFalse(l.lost, ["from", "to"]);
}

function normalize(b: any) {
  for (const c of b.cards as (Card | { kind: "shared" })[]) if (c.kind !== "shared") normCard(c);
  for (const s of b.sections) s.title ??= "";
  b.links.forEach(normLink);
  b.sidenotes.forEach(normNote);
  cornerStickers(b);
  for (const k of b.stickers as Sticker[]) dropFalse(k.q, ["done"]);
}

/** 旧的「贴在卡片角上」（at.kind card，右上角一排）→ 绑在卡上的贴纸，摆在原来那一排的位置 */
function cornerStickers(b: any) {
  const host = new Map<string, string>();
  for (const c of b.cards) if (c.kind === "compare") for (const k of c.cols) host.set(k, c.id);
  const row = new Map<string, number>();
  for (const k of b.stickers) {
    if (k.at.kind !== "card") continue;
    const card = host.get(k.at.card) ?? k.at.card;
    const i = row.get(card) ?? 0;
    row.set(card, i + 1);
    k.at = { kind: "canvas", ...cornerAt(b.place[card]?.w ?? 320, i), on: { card } };
  }
}

// ---------- 版本链 ----------

/**
 * 第 4 版 → 第 5 版：Call link / Plain link 合成一种箭头。
 * Call link → 箭头 + Call 标记（调用行、变量、↺ 都留着）；Plain link → 箭头（arrow none/end/both → 两端箭头开关，solid:false → 虚线，颜色留着，粗细按默认 2px）；
 * 旧的 side（起点从行的哪一端出）→ sides.from。
 * 创建顺序（born）按旧的叠放顺序编号，但每棵旧 Call 树的卡都排到它的根那里：每张调用图里最早的卡就是旧树的根，
 * 图之间的先后跟旧字母（按根在 cards 里的先后）一样，迁移后字母不变。
 */
function v4to5(b: any) {
  const old = b.links as any[];
  const byId = new Map<string, Card>(b.cards.map((c: Card) => [c.id, c]));
  b.links = old.map((l): Link => {
    const o: Link = { id: l.id, from: l.from, to: l.to };
    if (l.label !== undefined) o.label = l.label;
    if (l.at !== undefined) o.at = l.at;
    if (l.side) o.sides = { from: l.side };
    if (l.kind === "call") {
      const t = byId.get(l.to?.card);
      const name = l.call?.name ?? (isCode(t) ? t.segments.find((s) => s.symbol)?.symbol?.qual.split(".").pop() ?? "" : "");
      o.call = { name, col: l.call?.col ?? 0 };
      if (l.vars?.length) o.call.vars = l.vars;
      if (l.cands?.length) o.call.cands = l.cands;
      if (l.loop) o.call.loop = true;
    } else {
      const style: LinkStyle = {};
      if (l.solid === false) style.dash = true;
      if (l.arrow === "none") style.head = { end: false };
      else if (l.arrow === "both") style.head = { start: true };
      if (l.color) style.color = l.color;
      if (Object.keys(style).length) o.style = style;
    }
    return o;
  });
  // 旧树：每张卡只认第一条进来的 Call link；根 = 有出去、没有进来的卡
  const index = new Map<string, number>(b.cards.map((c: Card, i: number) => [c.id, i]));
  const calls = old.filter((l) => l.kind === "call" && index.has(l.from?.card) && index.has(l.to?.card));
  const parent = new Map<string, string>();
  const kids = new Map<string, string[]>();
  for (const l of calls) {
    if (parent.has(l.to.card) || l.to.card === l.from.card) continue;
    parent.set(l.to.card, l.from.card);
    kids.set(l.from.card, [...(kids.get(l.from.card) ?? []), l.to.card]);
  }
  const key = new Map<string, [number, number]>(); // 卡 → [排在谁的位置, 树里的先后]
  for (const r of kids.keys()) {
    if (parent.has(r)) continue;
    const at = index.get(r)!;
    let k = 0;
    const go = (id: string) => { if (key.has(id)) return; key.set(id, [at, k++]); (kids.get(id) ?? []).forEach(go); };
    go(r);
  }
  const order = (b.cards as Card[]).map((c, i) => ({ id: c.id, k: key.get(c.id) ?? [i, -1] }));
  order.sort((x, y) => x.k[0] - y.k[0] || x.k[1] - y.k[1]);
  b.born = {};
  order.forEach((x, i) => { b.born[x.id] = i; });
  b.seq = order.length;
  b.version = 5;
}

/**
 * 第 3 版代码卡的 Place.h 是整张卡的高度（按 Warm Ink 量；别的主题显示时再加 CSS 的 --hx）。
 * 第 4 版只存内容区（.carea）的高度，卡头 / 底栏由各主题的布局撑开。Warm Ink 的代码卡卡头是 36px（35 + 1px 下边线，没有色带和底栏；
 * harness 里实测：定高 300 的卡 .cbody 264，自动高的卡 = 36 + 内容）。冻结在这里，跟现在的卡头怎么画无关
 */
const V3_CODE_CHROME = 36;
function v3to4(b: any) {
  const fix = (c: Card | undefined, p: Place | undefined) => { if (c?.kind === "code" && p?.h) p.h = Math.max(1, p.h - V3_CODE_CHROME); };
  for (const c of b.cards as Card[]) {
    fix(c, b.place[c.id]);
    if (c.kind === "code") for (const m of c.mergedFrom ?? []) fix(m.card, m.place);
  }
  b.version = 4;
}

const GEO = ["x", "y", "w", "h", "section", "locked", "collapsed"] as const;
/** 第 2 版的卡（几何、状态混在卡里）拆成内容 + 摆放 */
function splitV2(c: any): { card: any; place: Place } {
  const place: any = {};
  const card: any = {};
  for (const [k, v] of Object.entries(c)) {
    if ((GEO as readonly string[]).includes(k)) { if (v !== undefined) place[k] = v; }
    else card[k] = v;
  }
  place.x ??= 0; place.y ??= 0; place.w ??= 320;
  return { card, place };
}
function contentV2(c: any, out: Card[], place: Record<string, Place> | null): Card {
  const { card, place: p } = splitV2(c);
  if (card.kind === "web") {
    if (card.pageTitle) card.meta = { title: card.pageTitle };
    delete card.pageTitle;
  }
  if (card.kind === "image") card.bg = true; // 旧图片保持原来的样子（有外框）
  if (card.kind === "code" && card.mergedFrom) card.mergedFrom = card.mergedFrom.map((o: any) => { const s = splitV2(o); return { card: s.card, place: s.place }; });
  if (card.kind === "compare") {
    const cols = card.cols as any[];
    card.cols = cols.map((k) => contentV2(k, out, null).id);
  }
  out.push(card as Card);
  if (place) place[card.id] = p;
  return card as Card;
}

function v2to3(o: any): any {
  const b: any = emptyBoard(o.id, o.name ?? "Board");
  b.version = 3;
  b.cam = o.cam ?? b.cam;
  if (o.hideAllComments) b.hideAllComments = true;
  if (o.hideNumbers) b.hideNumbers = true;
  const cards: Card[] = [];
  // Compare 的栏排在 Compare 前面（contentV2 先放栏再放自己）；栏没有 Place，叠放顺序不受影响
  for (const c of o.cards ?? []) contentV2(c, cards, b.place);
  b.cards = cards;
  b.links = (o.links ?? []).map((l: any) => (l.kind === "plain" ? { ...l, arrow: l.arrow ?? "none" } : l)); // 旧的 Plain link 默认没有箭头
  b.sections = o.sections ?? [];
  b.sidenotes = o.sidenotes ?? [];
  return b;
}

/** 第 1 版白板（v1 插件）迁移到第 2 版的结构 */
function v1to2(raw: any): any {
  const b: any = { version: 2, id: raw?.id, name: raw?.name ?? "Board", cam: raw?.cam ?? { x: 80, y: 80, z: 1 }, cards: [], links: [], sections: [], sidenotes: [] };
  for (const c of raw?.cards ?? []) {
    const base = { id: c.id, x: c.x, y: c.y, w: c.w };
    if (c.type === "code") {
      const s: any = {
        id: uid("s"), src: { kind: "repo", repo: "" }, path: c.path, lang: c.lang, start: c.start, end: c.end, text: c.snapshot,
        version: c.commit ? { kind: "git", commit: c.commit, ...(c.dirty ? { uncommitted: true } : {}) } : { kind: "none" },
      };
      if (c.symbol) s.symbol = { qual: c.symbol, kind: "function" };
      if (c.hl) s.hl = c.hl;
      b.cards.push({ ...base, kind: "code", ...(c.title ? { title: c.title } : {}), segments: [s] });
    } else if (c.type === "note") b.cards.push({ ...base, kind: "note", md: c.text, bg: true });
    else if (c.type === "image") b.cards.push({ ...base, kind: "image", src: c.src, ...(c.caption ? { alt: c.caption } : {}) });
    else if (c.type === "link") b.cards.push({ ...base, kind: "web", url: c.url, pageTitle: c.title });
    else if (c.type === "group") b.sections.push({ id: c.id, title: c.label, x: c.x, y: c.y, w: c.w, h: c.h });
  }
  for (const e of raw?.edges ?? []) {
    const call = e.kind === "call";
    const l: any = { id: e.id, kind: call ? "call" : "plain", from: { card: e.from.card }, to: { card: e.to.card } };
    if (e.label) l.label = e.label;
    if (!call) l.arrow = "end";
    // 行级 Link 要挂到段上
    const c = b.cards.find((k: any) => k.id === e.from.card);
    if (c?.kind === "code" && e.from.line) l.from = { card: e.from.card, seg: c.segments[0].id, line: e.from.line };
    b.links.push(l);
  }
  return b;
}
