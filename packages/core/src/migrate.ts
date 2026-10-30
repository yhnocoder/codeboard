// 旧白板文件 → 当前版本（第 9 版）。项目里唯一的兼容代码：旧版本的结构、缺省的字段、手改出来的 null 都在这里补成
// 和 model.ts 的类型一模一样，读进来之后的代码只认当前结构。schema.ts 校验的是这里的结果。
import { BOARD_VERSION, cornerAt, type Camera, emptyBoard, isCode, uid, type BoardFile, type Card, type Link, type LinkStyle, type Place, type Segment, type SharedCardFile, type Sidenote, type Sticker } from "./model";

/** 读进来的白板文件（第 1–9 版）→ 第 9 版白板文件（共享卡还是引用，由宿主的存储换成内容） */
export function migrateBoard(raw: any): BoardFile {
  // 更新的版本写的文件：读不懂就别碰（当第 1 版迁移会丢掉所有卡，下次自动保存把空白板写回去）
  if (typeof raw?.version === "number" && raw.version > BOARD_VERSION) throw new Error(`Board file version ${raw.version} is newer than this CodeBoard (${BOARD_VERSION}). Update CodeBoard to open it.`);
  const from = typeof raw?.version === "number" ? raw.version : 1;
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
  // 第 6 版 → 第 7 版：所见即所得编辑器（v0.1.8 起，写第 5、6 版）写下的 \$…\$ 公式，见 v6to7
  if (from === 5 || from === 6) v6to7(b);
  if (from < 8) for (const c of b.cards) if (c.kind !== "shared") v7to8Card(c);
  // 第 8 版 → 第 9 版：镜头不再存在文件里（每台机器各记各的，见 model.ts Board.cam；旧文件里的由 fileCamera 交给宿主）
  delete b.cam;
  b.version = BOARD_VERSION;
  normalize(b);
  return b;
}

/** 第 9 版以前的白板文件里存着的镜头：这台机器上还没记过这块白板的镜头时，宿主拿它当起点 */
export function fileCamera(raw: any): Camera | undefined {
  const c = raw?.version < 9 ? raw.cam : undefined;
  return c && [c.x, c.y, c.z].every((n) => typeof n === "number" && Number.isFinite(n)) && c.z > 0 ? { x: c.x, y: c.y, z: c.z } : undefined;
}

/** 卡库里的文件 cards/<id>.json：和白板文件一样补齐 */
export function migrateSharedCard(raw: any): SharedCardFile {
  if (typeof raw?.version === "number" && raw.version > BOARD_VERSION) throw new Error(`Shared card file version ${raw.version} is newer than this CodeBoard (${BOARD_VERSION}). Update CodeBoard to open it.`);
  const sc = dropNulls(raw);
  // 卡库从第 6 版才有
  if (sc?.version === 6) {
    if (sc.card) v6to7Card(sc.card);
    (sc.sidenotes ?? []).forEach(v6to7Note);
  }
  if (sc?.version === 6 || sc?.version === 7) if (sc.card) v7to8Card(sc.card);
  // 第 9 版的卡文件和第 8 版一样（变的只是白板文件的镜头）
  if (sc?.version >= 6 && sc.version < BOARD_VERSION) sc.version = BOARD_VERSION;
  if (sc?.card) normCard(sc.card);
  for (const n of sc?.sidenotes ?? []) normNote(n);
  return sc;
}

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
  dropFalse(c, ["tilt"]);
  if (c.kind !== "code") return;
  dropFalse(c, ["keepOld"]);
  if ((c.bg as boolean | undefined) === true) delete c.bg; // 代码卡默认有卡框：只存 false
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
  // 旧的 End.sub（连到子白板框里的某张小卡片）：框只是预览，箭头改连整个框；那张小卡片没了时标的 lost 跟着去掉（框还在）
  delete (l.from as { sub?: string }).sub;
  if ("sub" in l.to) {
    delete (l.to as { sub?: string }).sub;
    if (l.lost) { delete l.lost.to; if (!l.lost.from) delete l.lost; }
  }
}

function normalize(b: any) {
  for (const c of b.cards as (Card | { kind: "shared" })[]) if (c.kind !== "shared") normCard(c);
  // 图片卡的高度跟着图片的宽高比（宽度定了，高度由图片算出来），不存：旧文件、旧的拖角存下的高度去掉
  for (const c of b.cards as Card[]) if (c.kind === "image" && b.place[c.id]) delete b.place[c.id].h;
  for (const s of b.sections) s.title ??= "";
  // 子白板卡的预览栏数：曾经缺省 2 栏、选 1 栏时存 pcols: 1；现在缺省 1 栏，只存 2
  for (const c of b.cards) if (c.kind === "board" && c.pcols !== 2) delete c.pcols;
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

/**
 * 第 7 版 → 第 8 版：Note 和 Text 不再是同一张卡的有 / 没有背景（bg），而是四种样子之一（look）：
 * 有背景 = Note，没背景 = Text，没背景又是手写的（hand）= Mark（有背景时 hand 当时不显示，去掉）。
 * 代码卡的 nobg（没有卡框）换成和图片卡一样的 bg，只是代码卡默认有卡框，所以只存 bg: false
 */
function v7to8Card(c: any) {
  if (c.kind === "note") {
    c.look = c.bg ? "note" : c.hand ? "mark" : "text";
    delete c.bg;
    if (c.look !== "mark") delete c.hand;
  } else if (c.kind === "code") {
    if (c.nobg) c.bg = false;
    delete c.nobg;
    for (const m of c.mergedFrom ?? []) if (m?.card) v7to8Card(m.card);
  }
}

/**
 * 第 6 版 → 第 7 版：Markdown 里转义的 \$ 从此总是字面的 $（Typora 一样）。之前每次解析都把两头都转义了的 \$…\$ 当成公式
 * （所见即所得编辑器 v0.1.8 起把打了没转成公式的 $…$ 写成过这样）；这样的字在这里改成 $…$，公式源码就是当时读出来的那段字（\X 转义去掉）。
 * 只有第 5、6 版的文件可能有（v0.1.8、v0.2 写的）：第 1–4 版的文件只有之前的手写渲染器写过，它不把 \$ 当公式的开头，那时写的 \$ 本来就是字面的。
 * 存 Markdown 的地方：Note 的 md、每张卡的 desc（合并进来的卡也是）、文字 Sidenote 的 md、问题贴纸的 md。
 * 照当时的解析冻结在这里，跟现在的解析器怎么写无关；拿不准的（中间有会断开文字的写法：代码、强调、链接、HTML、表格的 | 等）不动，留成字面的 $
 */
function v6to7(b: any) {
  for (const c of b.cards) if (c.kind !== "shared") v6to7Card(c);
  b.sidenotes.forEach(v6to7Note);
  for (const k of b.stickers) if (typeof k.q?.md === "string") k.q.md = oldMath(k.q.md);
}
function v6to7Card(c: any) {
  if (typeof c.desc === "string") c.desc = oldMath(c.desc);
  if (c.kind === "note" && typeof c.md === "string") c.md = oldMath(c.md);
  for (const m of c.mergedFrom ?? []) if (m?.card) v6to7Card(m.card);
}
function v6to7Note(n: any) {
  if (n.kind === "text" && typeof n.md === "string") n.md = oldMath(n.md);
}

const SHIELD7 = 0xe300; // \X 转义先换成一个私用区的字（一个字对应文字里的一个字），写回时换回 \X
const ESC7 = String.fromCharCode(SHIELD7 + 36); // \$
/** 文字层面的字：\X → X */
const plain7 = (s: string) => s.replace(/[\uE300-\uE37F]/g, (c) => String.fromCharCode(c.charCodeAt(0) - SHIELD7));
const raw7 = (s: string) => s.replace(/[\uE300-\uE37F]/g, (c) => `\\${String.fromCharCode(c.charCodeAt(0) - SHIELD7)}`);
/** 公式里有这些：没转义的当时会断开那段字（公式就没转出来）；转义过的写进 $…$ 里会被当成记号，也不改 */
const BREAKS7 = /[`*[\]~\n]|==|<[^>\s]*>|<[A-Za-z/!?][^>\n]*>|&(?:#\d+|#x[\da-f]+|\w+);|\^[^^\s]+\^|:[a-z0-9_+-]+:|https?:\/\/|www\./i;

/** 一段 Markdown 里旧编辑器写下的 \$…\$ → $…$ */
function oldMath(md: string): string {
  if (!md.includes("\\$") || /[\uE300-\uE37F]/.test(md)) return md;
  // 不动的行：围栏代码块、缩进的代码块、HTML 块（到空行为止）。其余的行连成一段段交给 oldMathText
  const out: string[] = [];
  let run: string[] = [], fence = "", html = false;
  const flush = () => { if (run.length) out.push(oldMathText(run.join("\n"))); run = []; };
  const fixed = (l: string) => { flush(); out.push(l); };
  for (const l of md.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) { fixed(l); if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(l)) fence = ""; }
    else if (f) { fence = f[1]; fixed(l); }
    else if (html) { fixed(l); html = !!l.trim(); }
    else if (/^ {0,3}<[A-Za-z/!?]/.test(l)) { html = true; fixed(l); }
    else if (/^( {4}|\t)/.test(l)) fixed(l);
    else run.push(l);
  }
  flush();
  return out.join("\n");
}

/** 一段（不含代码块、HTML 块的）行：跳过行内代码、公式、链接地址、HTML 标签，两头都转义了的 \$…\$ 改成 $…$ */
function oldMathText(src: string): string {
  const p = src.replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => String.fromCharCode(SHIELD7 + c.charCodeAt(0)));
  // 成对的写法（上标、高亮、下标、表情、网址、标注 {a|b}、HTML 标签和 <自动链接>）：和一对 \$ 交叉时当时就分成了几段字
  const spans = [...p.matchAll(/\^[^^\s]+\^|==(?=[^\s=])[^\n]*?[^\s]==|~(?!~)[^~\s]+~(?!~)|:[a-z0-9_+-]+:|(?:https?:\/\/|www\.)\S+|\{[^{}\n]*\|[^{}\n]*\}|<[^>\s]*>|<[A-Za-z/!?][^>\n]*>/g)].map((x) => [x.index, x.index + x[0].length]);
  // 表格里 | 分开格子
  const table = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/m.test(p) && p.includes("|");
  let out = "", i = 0, lone = false; // lone：这一段前面有个没配成公式的 $（改出来的 $ 会和它配成对）
  const keep = (n: number) => { out += raw7(p.slice(i, i + n)); i += n; };
  while (i < p.length) {
    const c = p[i], rest = p.slice(i);
    if (/^\n[ \t]*\n/.test(rest)) lone = false;
    if (c === "`") {
      const n = /^`+/.exec(rest)![0].length;
      const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`).exec(p.slice(i + n));
      keep(close && !/\n[ \t]*\n/.test(p.slice(i + n, i + n + close.index)) ? n + close.index + n : n);
      continue;
    }
    const skip = c === "]" ? /^\]\([^)\n]*\)/.exec(rest) : c === "<" ? /^<[^>\s]*>|^<[A-Za-z/!?][^>\n]*>/.exec(rest)
      : c === "$" ? /^\$\$[^$]+?\$\$|^\$[^$\s](?:[^$]*[^$\s\\])?\$(?!\d)/.exec(rest) : null;
    if (skip) { keep(skip[0].length); continue; }
    if (c === ESC7) {
      const m = /^\uE324([^$\uE324]*)\uE324/.exec(rest);
      const t = m ? plain7(m[1]) : "", prev = i ? plain7(p[i - 1]) : "";
      // 当时的规则认不认这一对；认的话拿得准才改，拿不准的整对留着（右边那个 \$ 也不再当开头，和当时一样）
      if (m && prev !== "$" && prev !== "\\" && /^\S(?:[^]*[^\s\\])?$/.test(t) && !/^[\d$\uE324]/.test(p.slice(i + m[0].length))) {
        const end = i + m[0].length;
        const sure = !lone && !t.endsWith("\\") && !BREAKS7.test(t) && !(table && t.includes("|")) && !spans.some(([a, b]) => a < end && b > i);
        out += sure ? `$${t}$` : raw7(m[0]);
        i = end;
        continue;
      }
    }
    if (c === "$") lone = true;
    keep(1);
  }
  return out;
}

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
  const b: any = { version: 2, id: raw?.id, name: raw?.name ?? "Board", cards: [], links: [], sections: [], sidenotes: [] };
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
