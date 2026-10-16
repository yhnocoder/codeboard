// 白板的持久化数据模型（第 3 版）。宿主（VS Code，将来的 macOS app）和白板界面共用。
// 卡片内容（Card）和它在这块白板上的摆放（Place）分开存：v0.2 的共享卡片、子白板会让同一张卡出现在几块白板上，
// 内容只有一份，摆放每块白板各一份。Compare 只引用两张卡的 id，那两张卡在 cards 里但没有 Place（不单独出现在画布上）。
// 基本元素：Card、Place、Link、Section、Sidenote、Sticker。流程、讲解、Compare 都由它们派生。

export const BOARD_VERSION = 3;

// ---------- 版本 ----------

/** 一段代码钉在哪个版本上 */
export type Version =
  | { kind: "git"; commit: string; uncommitted?: boolean } // git 仓库里的文件
  | { kind: "pkg"; name: string; version: string } // pip / conda 装的包，读 dist-info
  | { kind: "hash"; hash: string } // 都不是：内容指纹
  | { kind: "none" }; // Free code、Paste：没有版本

/** 代码从哪来 */
export type Source =
  | { kind: "repo"; repo: string } // 工作区里的 git 仓库（多根工作区的每个根、每个子模块各算一个），repo = 相对工作区的仓库根路径，"" 表示第一个根
  | { kind: "external"; root: string } // 工作区外的文件（另一个 clone、site-packages）；root 是绝对路径的「根」，path 相对它
  | { kind: "github"; owner: string; name: string; ref: string } // GitHub Code：文件缓存在本地，钉 commit 不更新
  | { kind: "free"; url?: string }; // 手写或粘贴，只有文本

export type SymRef = { qual: string; kind: "function" | "class" | "module" };

/** 一段连续的代码：同一个文件里的若干行。行号永远是源码真实行号 */
export type Segment = {
  id: string;
  src: Source;
  path: string; // 相对 repo 根（github 同理）；free 为 ""
  lang: string; // VS Code languageId：python / cpp / cuda-cpp / c …；Triton、TileLang 也是 python
  start: number; // 1-based，含
  end: number; // 1-based，含
  text: string[]; // version 对应的这几行代码（仓库不在也能显示）
  version: Version;
  symbol?: SymRef; // 函数卡 / 类卡按符号追踪；片段卡没有
  scope?: string; // 片段所在的函数（标题、函数边界线用），如 Scheduler.schedule
  hidden?: [number, number][]; // 手动隐藏的行范围
  hl?: number[]; // 显式高亮的行
  keep?: string; // 用户对这个 HEAD 选了 Keep：同一个新版本不再提醒，HEAD 再变才提醒
};

// ---------- 卡片（内容） ----------

type CardBase = {
  id: string;
  title?: string; // 用户改过的名字；没有就用默认名
  desc?: string; // 卡片说明（标题下一段话，Walkthrough 时显示）
};

export type HideFlags = { comments?: boolean; docstrings?: boolean; blank?: boolean };

/** 代码卡：函数 / 类 / 片段 / 多段 / GitHub Code / Free code 都是它，区别在段的来源和符号 */
export type CodeCard = CardBase & {
  kind: "code";
  segments: Segment[];
  hide?: HideFlags;
  wrap?: boolean;
  /** 无背景：代码直接写在画布上，头部和边框只在悬停 / 选中时浮出 */
  nobg?: boolean;
  /** 类卡：只列成员签名；shown = 卡上显示的成员（qual），其余收在「+ N more methods」 */
  members?: { shown: string[] };
  /** 合并来的卡：合并前的原卡和它们的摆放（Unmerge 时拆回） */
  mergedFrom?: { card: CodeCard; place: Place }[];
  keepOld?: true; // 符号找不到时选了 Keep Old Version：不再提示
};

export type NoteCard = CardBase & {
  kind: "note";
  md: string;
  bg: boolean; // false = Text（没有背景、边框、标题栏，直接写在画布上）
  size?: "title" | "heading" | "body"; // Text 的字号
  bold?: boolean;
};
/** 图片：默认无背景（只显示图片本身），bg = 有卡片外框 */
export type ImageCard = CardBase & { kind: "image"; src: string; alt?: string; bg?: boolean }; // src = assets/ 下的文件名，或 data: URL

/** 网页的元信息：插件端贴链接时抓一次，图片存进 assets/，离线也能显示 */
export type WebMeta = {
  title?: string; // og:title / <title>
  desc?: string; // og:description / meta description
  site?: string; // og:site_name
  image?: string; // og:image：assets/ 下的文件名（或抓不到时的原始 URL）
  icon?: string; // favicon：assets/ 下的文件名
  at?: number; // 抓取时间
  failed?: boolean; // 什么都没抓到（需要登录 / 离线）
};
/** Web 卡：书签样式（标题 + 两行描述 + 域名 + 右侧预览图） */
export type WebCard = CardBase & { kind: "web"; url: string; meta?: WebMeta };
/** Link List 里的一行 */
export type LinkItem = { id: string; url: string; title?: string; meta?: WebMeta; rich?: boolean };
/** Web List：几个链接合成一张卡；rich = 整张卡默认的显示方式（每行可以单独设） */
export type LinksCard = CardBase & { kind: "links"; items: LinkItem[]; rich?: boolean };
/** Compare：两张代码卡原地并成两栏。cols 引用两张卡（保留 id、编号和 Link），Separate 拆回原位 */
export type CompareCard = CardBase & {
  kind: "compare";
  cols: [string, string];
  swap?: boolean;
  unified?: boolean;
  hideSame?: boolean;
};

export type Card = CodeCard | NoteCard | ImageCard | WebCard | LinksCard | CompareCard;
export type CardKind = Card["kind"];

// ---------- 摆放 ----------

/** 一张卡在这块白板上的位置和状态 */
export type Place = {
  x: number;
  y: number;
  w: number;
  h?: number; // 用户拖过高度才有；否则按内容自动高，上限后卡内滚动
  section?: string; // 所在 Section（按卡片中心点判断，拖动结束时更新）
  locked?: boolean;
  collapsed?: boolean; // 折叠了它下面的 Call 子树
};

// ---------- Link（界面上叫 Arrow） ----------

/** Link 的一端：整张卡，或卡里某一段的某一行 */
export type End = { card: string; seg?: string; line?: number };

/** Call 上的变量：a = 调用处，b = 被调函数里的名字（名字不同才有）；ret = 返回值被谁接住 */
export type Var = { a: string; b?: string; ret?: boolean; custom?: boolean };

type LinkBase = {
  id: string;
  from: End;
  to: End;
  label?: string; // 用户写的话，浮在线中间
  at?: number; // 标签框沿线的位置 0..1（用户拖过才有；默认在中间）
};
/** 调用：从代码行到被调函数的卡。参与编号、Walkthrough、Tidy、变量 */
export type CallLink = LinkBase & {
  kind: "call";
  vars?: Var[]; // 勾选了的变量；默认一个都不加
  cands?: Var[]; // 语法推出来的候选变量（点 + 时列出来）
  loop?: boolean; // 出发行在 for / while 里（↺）
  call?: { name: string; col: number }; // 点的是这一行的哪个调用
  side?: "left" | "right"; // 用户拖过起点：从这一行的哪一端出（没有 = 自动）
};
/** 普通箭头：不编号；可设箭头、虚实、颜色、文字 */
export type PlainLink = LinkBase & {
  kind: "plain";
  arrow?: "none" | "end" | "both"; // 默认 end
  solid?: boolean; // 默认虚线
  color?: string; // 默认灰
};
export type Link = CallLink | PlainLink;

// ---------- Section ----------

export type Section = {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parent?: string; // 嵌套：父 Section，不限层数
  color?: string; // 几种浅色之一；默认无色
  collapsed?: boolean;
  locked?: boolean;
  desc?: string;
};

// ---------- Sidenote ----------

/** 挂在哪：整张卡、一行或几行 */
export type Anchor = { card: string; seg?: string; lines?: [number, number] };

export type Sidenote = {
  id: string;
  at: Anchor;
  why?: string; // 「为什么相关」，可选
  lineRemoved?: boolean; // 更新版本时原来的行被删了，改挂整卡
} & (
  | { kind: "code"; code: Segment } // 仓库里或仓库外的代码，钉版本
  | { kind: "paste"; text: string; lang: string; url?: string }
  | { kind: "text"; md: string; alwaysShow?: boolean }
  | { kind: "link"; url: string; title?: string }
  | { kind: "card"; card: string }
);
export type SidenoteKind = Sidenote["kind"];

// ---------- Sticker ----------

/** 图标：包名 + 图标名。builtin = 内置的十几个；emoji = 系统 emoji（name 就是那个字符）；其余是 Sticker Packs 目录里的包 */
export type IconRef = { pack: string; name: string };

/**
 * 贴在哪：代码行（进行号栏，随 Update 跟行走）、卡片角上（旧）、画布任意位置，
 * 或绑在卡 / 箭头上（跟着走，同一图层）：on.card 时 x、y 是相对卡左上角的偏移；on.link 时 t 是沿线的位置 0..1，x、y 是相对那一点的偏移
 */
export type StickerOn = { card: string } | { link: string; t: number };
export type StickerAt =
  | { kind: "line"; card: string; seg: string; line: number }
  | { kind: "card"; card: string }
  | { kind: "canvas"; x: number; y: number; size?: number; on?: StickerOn };

export type Sticker = { id: string; icon: IconRef; color?: string; at: StickerAt };

// ---------- 白板 ----------

export type Camera = { x: number; y: number; z: number };

export type Board = {
  version: 3;
  id: string;
  name: string;
  cam: Camera;
  /** 卡片内容（顺序 = 叠放顺序）；Compare 的两栏也在这里 */
  cards: Card[];
  /** 卡片 id → 在这块白板上的摆放；没有 Place 的卡不单独出现在画布上（Compare 的栏） */
  place: Record<string, Place>;
  links: Link[];
  sections: Section[];
  sidenotes: Sidenote[];
  stickers: Sticker[];
  hideAllComments?: boolean;
  hideNumbers?: boolean;
};

export type BoardMeta = { id: string; name: string; group?: string; cards: number; stale?: number };

export function emptyBoard(id: string, name: string): Board {
  return { version: BOARD_VERSION, id, name, cam: { x: 80, y: 80, z: 1 }, cards: [], place: {}, links: [], sections: [], sidenotes: [], stickers: [] };
}

// ---------- 小工具 ----------

let seq = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const isCode = (c: Card | undefined): c is CodeCard => c?.kind === "code";

/** 卡片的显示名 */
export function cardTitle(c: Card, b?: Pick<Board, "cards">): string {
  if (c.title) return c.title;
  switch (c.kind) {
    case "code": return codeTitle(c);
    case "note": return firstLine(c.md) || (c.bg ? "Note" : "Text");
    case "image": return c.alt || "Image";
    case "web": return c.meta?.title || domainOf(c.url);
    case "links": return "Links";
    case "compare": return `Compare · ${b ? compareName(c, b) : ""}`;
  }
}

function compareName(c: CompareCard, b: Pick<Board, "cards">) {
  const cols = colsOf(b, c);
  if (!cols) return "";
  const [a, k] = cols.map((x) => shortName(cardTitle(x)));
  if (a === k) {
    const va = versionLabel(cols[0].segments[0]?.version), vb = versionLabel(cols[1].segments[0]?.version);
    return `${a} · ${va} ↔ ${vb}`;
  }
  return `${a} ↔ ${k}`;
}
const shortName = (s: string) => s.split(".").pop() ?? s;

export function codeTitle(c: CodeCard): string {
  const s = c.segments[0];
  if (!s) return "Empty";
  if (s.src.kind === "free") return "Code";
  if (s.symbol) return s.symbol.kind === "module" ? `${baseName(s.path)} (top)` : s.symbol.qual;
  if (s.scope) return `${s.scope} ${s.start}–${s.end}`;
  return `${baseName(s.path)} ${s.start}–${s.end}`;
}

/** 卡片种类符号：ƒ 函数、C 类、⋮ 片段 / 多段、GH、</> */
export function codeGlyph(c: CodeCard): string {
  const s = c.segments[0];
  if (!s) return "⋮";
  if (s.src.kind === "free") return "</>";
  if (s.src.kind === "github") return "GH";
  if (c.segments.length > 1) return "⋮";
  if (c.members || s.symbol?.kind === "class") return "C";
  if (s.symbol?.kind === "function") return "ƒ";
  return "⋮";
}

export const baseName = (p: string) => p.split("/").pop() ?? p;
const firstLine = (md: string) => md.split("\n").map((l) => l.replace(/^[#>\-*\s]+/, "").trim()).find(Boolean) ?? "";
export function domainOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

export function versionLabel(v: Version | undefined): string {
  if (!v) return "";
  switch (v.kind) {
    case "git": return v.commit.slice(0, 7);
    case "pkg": return `${v.name} ${v.version}`;
    case "hash": return `Unknown version · ${v.hash.slice(0, 4)}`;
    case "none": return "No commit";
  }
}

export function sameVersion(a: Version, b: Version) {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "git": return a.commit === (b as typeof a).commit;
    case "pkg": return a.name === (b as typeof a).name && a.version === (b as typeof a).version;
    case "hash": return a.hash === (b as typeof a).hash;
    case "none": return true;
  }
}

/** 白板上所有代码卡（含 Compare 的两栏） */
export function allCodeCards(b: Pick<Board, "cards">): CodeCard[] {
  return b.cards.filter(isCode);
}

/** Compare 的两栏（按 cols 的顺序）；有一栏找不到时返回 undefined */
export function colsOf(b: Pick<Board, "cards">, c: CompareCard): [CodeCard, CodeCard] | undefined {
  const a = b.cards.find((k) => k.id === c.cols[0]), k = b.cards.find((x) => x.id === c.cols[1]);
  return isCode(a) && isCode(k) ? [a, k] : undefined;
}

/** 按 id 找卡；host = 画布上真正摆着的那张卡（Compare 的栏 → 那张 Compare） */
export function findCard(b: Pick<Board, "cards">, id: string): { card: Card; host: Card } | undefined {
  const card = b.cards.find((c) => c.id === id);
  if (!card) return undefined;
  const host = b.cards.find((c) => c.kind === "compare" && c.cols.includes(id)) ?? card;
  return { card, host };
}

/** Compare 的栏 id → 那张 Compare 的 id */
export function colHosts(b: Pick<Board, "cards">): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of b.cards) if (c.kind === "compare") for (const k of c.cols) m.set(k, c.id);
  return m;
}

/** 画布上摆着的卡（有 Place 的），按叠放顺序 */
export const placedCards = (b: Pick<Board, "cards" | "place">): Card[] => b.cards.filter((c) => b.place[c.id]);

export const segOf = (c: CodeCard, seg?: string) => (seg ? c.segments.find((s) => s.id === seg) : c.segments[0]);

/** 段按「文件 → 行号」排序，first 指定的文件排在最前 */
export function sortSegments(segs: Segment[], firstPath?: string): Segment[] {
  const key = (s: Segment) => `${s.src.kind === "free" ? "2" : s.path === firstPath ? "0" : "1"}${s.path}`;
  return [...segs].sort((a, b) => key(a).localeCompare(key(b)) || a.start - b.start);
}

/** 合并同一文件同一版本里重叠或相邻的段 */
export function mergeOverlapping(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (p && p.src.kind !== "free" && s.src.kind !== "free" && p.path === s.path && JSON.stringify(p.src) === JSON.stringify(s.src) && sameVersion(p.version, s.version) && s.start <= p.end + 1) {
      if (s.end > p.end) {
        p.text = [...p.text, ...s.text.slice(p.end - s.start + 1)];
        p.end = s.end;
      }
      p.hidden = [...(p.hidden ?? []), ...(s.hidden ?? [])];
      p.hl = [...new Set([...(p.hl ?? []), ...(s.hl ?? [])])];
      if (p.symbol && s.symbol?.qual !== p.symbol.qual) p.symbol = undefined;
      continue;
    }
    out.push({ ...s, text: [...s.text], hidden: s.hidden ? [...s.hidden] : undefined, hl: s.hl ? [...s.hl] : undefined });
  }
  return out;
}

// ---------- 迁移 ----------

/** 读进来的白板文件（第 1、2、3 版）→ 第 3 版 */
export function migrateBoard(raw: any): Board {
  if (raw?.version === 3) {
    const b = raw as Board;
    b.place ??= {};
    b.links ??= [];
    b.sections ??= [];
    b.sidenotes ??= [];
    b.stickers ??= [];
    return b;
  }
  return v2to3(raw?.version === 2 ? raw : v1to2(raw));
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
    card.cols = cols.map((k) => { const col = contentV2(k, out, null); return col.id; });
  }
  out.push(card as Card);
  if (place) place[card.id] = p;
  return card as Card;
}

function v2to3(o: any): Board {
  const b = emptyBoard(o.id, o.name ?? "Board");
  b.cam = o.cam ?? b.cam;
  b.hideAllComments = o.hideAllComments;
  b.hideNumbers = o.hideNumbers;
  const cards: Card[] = [];
  // Compare 的栏排在 Compare 前面（contentV2 先放栏再放自己）；栏没有 Place，叠放顺序不受影响
  for (const c of o.cards ?? []) contentV2(c, cards, b.place);
  b.cards = cards;
  b.links = (o.links ?? []).map((l: any) => (l.kind === "plain" ? { ...l, arrow: l.arrow ?? "none" } : l)); // 旧的 Plain link 默认没有箭头
  b.sections = o.sections ?? [];
  b.sidenotes = o.sidenotes ?? [];
  b.stickers = [];
  return b;
}

/** 第 1 版白板（v1 插件）迁移到第 2 版的结构 */
function v1to2(raw: any): any {
  const b: any = { version: 2, id: raw.id, name: raw.name ?? "Board", cam: raw.cam ?? { x: 80, y: 80, z: 1 }, cards: [], links: [], sections: [], sidenotes: [] };
  for (const c of raw.cards ?? []) {
    const base = { id: c.id, x: c.x, y: c.y, w: c.w };
    if (c.type === "code") {
      b.cards.push({
        ...base, kind: "code", title: c.title,
        segments: [{
          id: uid("s"), src: { kind: "repo", repo: "" }, path: c.path, lang: c.lang, start: c.start, end: c.end, text: c.snapshot,
          version: c.commit ? { kind: "git", commit: c.commit, uncommitted: c.dirty } : { kind: "none" },
          symbol: c.symbol ? { qual: c.symbol, kind: "function" } : undefined, hl: c.hl,
        }],
      });
    } else if (c.type === "note") b.cards.push({ ...base, kind: "note", md: c.text, bg: true });
    else if (c.type === "image") b.cards.push({ ...base, kind: "image", src: c.src, alt: c.caption });
    else if (c.type === "link") b.cards.push({ ...base, kind: "web", url: c.url, pageTitle: c.title });
    else if (c.type === "group") b.sections.push({ id: c.id, title: c.label, x: c.x, y: c.y, w: c.w, h: c.h });
  }
  for (const e of raw.edges ?? []) {
    const call = e.kind === "call";
    b.links.push({ id: e.id, kind: call ? "call" : "plain", from: { card: e.from.card, line: e.from.line, seg: undefined }, to: { card: e.to.card }, label: e.label, arrow: call ? undefined : "end" });
  }
  // 行级 Link 要挂到段上
  for (const l of b.links) {
    const c = b.cards.find((k: any) => k.id === l.from.card);
    if (c?.kind === "code" && l.from.line) l.from.seg = c.segments[0].id;
    else delete l.from.line;
  }
  return b;
}

export const varKey = (v: Var) => `${v.ret ? "→" : ""}${v.a}|${v.b ?? ""}`;
/** 线上显示的文字：名字相同只显示一个；不同显示 a → b；返回值 → logits */
export const varText = (v: Var) => (v.ret ? `→ ${v.a}` : v.b ? `${v.a} → ${v.b}` : v.a);
