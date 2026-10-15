// 白板的持久化数据模型（第 2 版）。宿主（VS Code，将来的 macOS app）和白板界面共用。
// 四个基本元素：Card、Link、Section、Sidenote。流程、讲解、Compare 都由它们派生。

export const BOARD_VERSION = 2;

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
};

// ---------- 卡片 ----------

type CardBase = {
  id: string;
  x: number;
  y: number;
  w: number;
  h?: number; // 用户拖过高度才有；否则按内容自动高，上限后卡内滚动
  title?: string; // 用户改过的名字；没有就用默认名
  desc?: string; // 卡片说明（标题下一段话，Walkthrough 时显示）
  locked?: boolean;
  section?: string; // 所在 Section（按卡片中心点判断，拖动结束时更新）
  collapsed?: boolean; // 折叠了它下面的 Call 子树
};

export type HideFlags = { comments?: boolean; docstrings?: boolean; blank?: boolean };

/** 代码卡：函数 / 类 / 片段 / 多段 / GitHub Code / Free code 都是它，区别在段的来源和符号 */
export type CodeCard = CardBase & {
  kind: "code";
  segments: Segment[];
  hide?: HideFlags;
  wrap?: boolean;
  /** 类卡：只列成员签名；shown = 卡上显示的成员（qual），其余收在「+ N more methods」 */
  members?: { shown: string[] };
  /** 合并来的卡：合并前的原卡（含位置、说明），Unmerge 时拆回 */
  mergedFrom?: CodeCard[];
};

export type NoteCard = CardBase & {
  kind: "note";
  md: string;
  bg: boolean; // false = Text（没有背景、边框、标题栏，直接写在画布上）
  size?: "title" | "heading" | "body"; // Text 的字号
  bold?: boolean;
};
export type ImageCard = CardBase & { kind: "image"; src: string; alt?: string }; // src = assets/ 下的文件名，或 data: URL
export type WebCard = CardBase & { kind: "web"; url: string; pageTitle?: string };
/** Compare：两张代码卡原地并成两栏。不是拷贝，cols 就是原卡（保留 id、编号和 Link），Separate 拆回原位 */
export type CompareCard = CardBase & {
  kind: "compare";
  cols: [CodeCard, CodeCard];
  swap?: boolean;
  unified?: boolean;
  hideSame?: boolean;
};

export type Card = CodeCard | NoteCard | ImageCard | WebCard | CompareCard;
export type CardKind = Card["kind"];

// ---------- Link ----------

/** Link 的一端：整张卡，或卡里某一段的某一行 */
export type End = { card: string; seg?: string; line?: number };

/** Call link 上的变量：a = 调用处，b = 被调函数里的名字（名字不同才有）；ret = 返回值被谁接住 */
export type Var = { a: string; b?: string; ret?: boolean; custom?: boolean };

export type Link = {
  id: string;
  kind: "call" | "plain";
  from: End;
  to: End;
  label?: string; // 用户写的话，浮在线中间
  // Call
  vars?: Var[]; // 勾选了的变量；默认一个都不加
  loop?: boolean; // 出发行在 for / while 里（↺）
  call?: { name: string; col: number }; // 点的是这一行的哪个调用
  // Plain
  arrow?: "none" | "end" | "both"; // 默认 none
  solid?: boolean; // 默认虚线
  color?: string; // 默认灰
};

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

// ---------- 白板 ----------

export type Camera = { x: number; y: number; z: number };

export type Board = {
  version: 2;
  id: string;
  name: string;
  cam: Camera;
  cards: Card[];
  links: Link[];
  sections: Section[];
  sidenotes: Sidenote[];
  hideAllComments?: boolean;
  hideNumbers?: boolean;
};

export type BoardMeta = { id: string; name: string; group?: string; cards: number; stale?: number };

export function emptyBoard(id: string, name: string): Board {
  return { version: 2, id, name, cam: { x: 80, y: 80, z: 1 }, cards: [], links: [], sections: [], sidenotes: [] };
}

// ---------- 小工具 ----------

let seq = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const isCode = (c: Card | undefined): c is CodeCard => c?.kind === "code";

/** 卡片的显示名 */
export function cardTitle(c: Card): string {
  if (c.title) return c.title;
  switch (c.kind) {
    case "code": return codeTitle(c);
    case "note": return firstLine(c.md) || (c.bg ? "Note" : "Text");
    case "image": return c.alt || "Image";
    case "web": return c.pageTitle || domainOf(c.url);
    case "compare": return `Compare · ${compareName(c)}`;
  }
}

function compareName(c: CompareCard) {
  const [a, b] = c.cols.map((k) => shortName(cardTitle(k)));
  if (a === b) {
    const va = versionLabel(c.cols[0].segments[0]?.version), vb = versionLabel(c.cols[1].segments[0]?.version);
    return `${a} · ${va} ↔ ${vb}`;
  }
  return `${a} ↔ ${b}`;
}
const shortName = (s: string) => s.split(".").pop() ?? s;

export function codeTitle(c: CodeCard): string {
  const s = c.segments[0];
  if (!s) return "Empty";
  if (s.src.kind === "free") return "Free code";
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

/** 一张代码卡在画布上「代表」的所有卡 id：Compare 卡的两栏也算 */
export function allCodeCards(b: Pick<Board, "cards">): CodeCard[] {
  const out: CodeCard[] = [];
  for (const c of b.cards) {
    if (c.kind === "code") out.push(c);
    else if (c.kind === "compare") out.push(...c.cols);
  }
  return out;
}

/** 按 id 找卡，Compare 的栏也能找到；host = 画布上真正的那张卡 */
export function findCard(b: Pick<Board, "cards">, id: string): { card: Card; host: Card } | undefined {
  for (const c of b.cards) {
    if (c.id === id) return { card: c, host: c };
    if (c.kind === "compare") for (const k of c.cols) if (k.id === id) return { card: k, host: c };
  }
  return undefined;
}

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

/** 第 1 版白板（v1 插件）迁移到第 2 版 */
export function migrateBoard(raw: any): Board {
  if (raw?.version === 2) return raw as Board;
  const b = emptyBoard(raw.id, raw.name ?? "Board");
  b.cam = raw.cam ?? b.cam;
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
    const c = b.cards.find((k) => k.id === l.from.card);
    if (c?.kind === "code" && l.from.line) l.from.seg = c.segments[0].id;
    else delete l.from.line;
  }
  return b;
}
