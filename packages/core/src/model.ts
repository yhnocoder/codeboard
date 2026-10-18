// 白板的持久化数据模型（第 6 版）。宿主（VS Code，将来的 macOS app）和白板界面共用。
// 卡片内容（Card）和它在这块白板上的摆放（Place）分开存：v0.2 的共享卡片、子白板会让同一张卡出现在几块白板上，
// 内容只有一份，摆放每块白板各一份。Compare 只引用两张卡的 id，那两张卡在 cards 里但没有 Place（不单独出现在画布上）。
// 基本元素：Card、Place、Link、Section、Sidenote、Sticker。流程、讲解、Compare 都由它们派生。
// 第 6 版起有共享卡：内容存在卡库 <存储目录>/cards/<id>.json（卡 + 跟着它走的 Sidenote），白板文件里只留引用（SharedRef）；
// 宿主读白板时把引用换成内容（inflate），界面拿到的永远是完整的 Board。

export const BOARD_VERSION = 6;

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
  /** 进程标签（线框 03）：自由文字（rank 0、rank 1…N、Scheduler × TP）；light = 线程 / CUDA stream，浅一点的样式 */
  procs?: ProcTag[];
};

export type ProcTag = { text: string; light?: boolean };

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
  /** Generated 卡：生成出来的代码 / 编译产物（what = CUDA source、Inductor output），钉在一次运行和那组参数上（run），不钉 commit */
  gen?: { what: string; run?: string };
  /**
   * 我的改动（线框 07）：同一段代码的几个版本，卡上一排标签页。第一个永远是上游（钉住的版本，from.kind = upstream）。
   * 当前显示的那个（active）的段就是 segments；其余 Variant 的段存在各自的 segs 里，段 id 和 segments 一一对应（Link、Sidenote 的 seg 不用换）。
   */
  variants?: Variant[];
  active?: string; // 当前显示的 Variant 的 id；没有 = 上游
};

/** Variant 从哪来 */
export type VariantFrom =
  | { kind: "upstream" } // 钉住的上游版本（卡原来的段）
  | { kind: "ref"; ref: string } // 分支 / tag / commit（分支会跟着走：rebase 后按函数名重新定位）
  | { kind: "worktree" } // 当前工作区（含未提交改动），保存时刷新
  | { kind: "wt"; dir: string; branch?: string } // 同一仓库的另一个 worktree（绝对路径；含它的未提交改动）
  | { kind: "file"; abs: string } // 复制出来改的文件（仓库外也行），按函数名在里面找
  | { kind: "pr"; owner: string; name: string; num: number; branch?: string }; // GitHub Pull Request（跟着 PR 的 head）
/**
 * 一个 Variant：name = 标签上的名字；note = 一行说明（参数、性能数字）；segs = 不是当前显示的时候它的段；
 * merged = 已经提示过「合进上游」、用户选了 Keep Variants：合进去的 commit（分支 / PR 的 head），同一次合入不再提示
 */
export type Variant = { id: string; name: string; from: VariantFrom; note?: string; segs?: Segment[]; merged?: string };

export type NoteCard = CardBase & {
  kind: "note";
  md: string;
  bg: boolean; // false = Text（没有背景、边框、标题栏，直接写在画布上）
  size?: "title" | "heading" | "body"; // Text 的字号
  bold?: boolean;
  /** 消息卡（线框 03）：跨进程时夹在发送点和接收处之间的消息类型（md = 类型名，where = 定义在哪，如 io_struct.py） */
  msg?: { where?: string };
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
/** Web 卡样式：不填 = Auto（横图放上面，方图放右边） */
export type WebStyle = "banner" | "side" | "text" | "compact";
export type WebCard = CardBase & { kind: "web"; url: string; meta?: WebMeta; style?: WebStyle };
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

/**
 * 子白板：另一块白板嵌在这块白板上，画成带名字的骨架（卡片标题、调用图标记、连线、Section 色，不画代码）。
 * 只存是哪块白板；骨架由宿主按那块白板算好发来（白板界面里没有子白板的完整内容）。Place 总有 h（框的大小由用户定）。
 */
export type BoardCard = CardBase & { kind: "board"; board: string };

export type Card = CodeCard | NoteCard | ImageCard | WebCard | LinksCard | CompareCard | BoardCard;
export type CardKind = Card["kind"];

// ---------- 摆放 ----------

/** 一张卡在这块白板上的位置和状态 */
export type Place = {
  x: number;
  y: number;
  w: number;
  h?: number; // 用户拖过高度才有；否则按内容自动高，上限后卡内滚动。代码卡（第 4 版起）存的是内容区的高度，不含卡头 / 底栏（那部分随主题变）
  section?: string; // 所在 Section（按卡片中心点判断，拖动结束时更新）
  locked?: boolean;
  collapsed?: boolean; // 折叠了它下面的 Call 子树
  start?: boolean; // 起点卡（线框 12）：不选卡直接 Walkthrough、调用树从这里开始
};

// ---------- Link（界面上叫 Arrow） ----------

/**
 * Link 的一端：整张卡，或卡里某一段的某一行。
 * sub：card 是子白板（BoardCard）时，连到子白板里的哪张卡（线穿过框上的入口点落到骨架里那张卡上）；那张卡没了时 lost
 */
export type End = { card: string; seg?: string; line?: number; sub?: string };

/** Call 上的变量：a = 调用处，b = 被调函数里的名字（名字不同才有）；ret = 返回值被谁接住 */
export type Var = { a: string; b?: string; ret?: boolean; custom?: boolean };

/** 箭头的一端从卡的哪一边进出（没有 = 自动） */
export type LinkSide = "left" | "right" | "top" | "bottom";

/**
 * Call 标记：这条箭头是「这一行调用了那个函数」。有 Call 标记的箭头连成调用图（Walkthrough、折叠、调用图标记、变量都看它）。
 * name / col：点的是出发行的哪个调用；vars = 勾选了的变量（默认一个都不加）；cands = 语法推出来的候选；loop = 出发行在 for / while 里（↺）
 */
export type CallMark = {
  name: string; col: number; vars?: Var[]; cands?: Var[]; loop?: boolean;
  /** 证据：没有 = static（静态解析出来的）；manual = 手动补的（虚线）；observed = 跑出来确认过（绿色，OBSERVED） */
  ev?: CallEvidence;
  /** 跨了什么边界：pybind · deep_ep.cpp m.def、kernel[grid]、launch macro…（标签框的第一行） */
  bound?: string;
  /** 跨边界时定下来的取值（模板参数、constexpr、config、工厂参数）：标签框的第二行 kNumRanks → 8 · kNumThreads → 768 */
  vals?: BoundVal[];
  /** 同一个调用点的其他可能（别的实现、别的一组 config）：目标卡旁边的灰色虚框，点一下换成它 */
  alts?: CallAlt[];
  /** 动态分发：一共有几个实现（目标卡头的「1 of 4」） */
  impls?: number;
  /** 运行时看到的几次调用的实参（observed 时才有；前几次 + 最后一次，标签框里 ◀ ▶ 切换） */
  seen?: CallSample[];
};

/**
 * 证据分三档（线框 13）：没有 ev = static（静态解析出来的）；manual = 手动补的；observed = 一次运行里真的从这一行进了那个函数。
 * 线上画最强的那档（observed > static > manual），悬停列出全部：observed 时 base 记下它原来是哪档（manual；没有 = static）。
 * via = 怎么补上的（registry、search）；cmd / log / at / commit = observed 的证据：运行命令、日志行、时间、当时的 commit；
 * count = 那次运行里调了几次，run = 运行记录的 id（<存储目录>/runs/<id>.json）
 */
export type CallEvidence = { kind: "manual" | "observed"; via?: string; cmd?: string; log?: string[]; at?: number; commit?: string; count?: number; run?: string; base?: "manual" };
/** 运行时的一次调用：n = 第几次（从 1 数），args = [形参名, 值的简写]（tensor 只记 shape / dtype / device） */
export type CallSample = { n: number; args: [string, string][] };
/** 一个取值：name → value；opts = 可能的几个值（让人选一个，其余是灰色分支），from = 取值从哪来（SWITCH_RANKS(num_ranks)） */
export type BoundVal = { name: string; value: string; opts?: string[]; from?: string };
/** 一个备选：别的实现（path + line + qual，path 是宿主给的显示路径）或别的一组取值（vals）。lib = 在 library 里（不在 Study Scope，⌥ 才展开） */
export type CallAlt = { label: string; detail?: string; path?: string; line?: number; qual?: string; lib?: string; vals?: BoundVal[] };

/** 箭头的样子：dash = 虚线；width 默认 2；head 默认只有终点有箭头；color 默认灰 */
export type LinkStyle = { dash?: true; width?: 1 | 2 | 3; head?: { start?: boolean; end?: boolean }; color?: string };

/**
 * 箭头：只有这一种（第 5 版起）。两端各是整张卡或某一行，一行 / 一张卡可以连出、连进任意多条。
 * 调用是箭头上的 Call 标记（call），不是另一种线。
 */
export type Link = {
  id: string;
  from: End;
  to: End;
  label?: string; // 用户写的话，浮在线上
  at?: number; // 标签框沿线的位置 0..1（用户拖过才有；默认在中间）
  call?: CallMark;
  style?: LinkStyle;
  sides?: { from?: LinkSide; to?: LinkSide }; // 用户选过的进出边
  lost?: { from?: true; to?: true }; // 这一端连着的行在代码更新后没了：端点退到卡头，画成红色，等用户重连或删掉
  gen?: true; // Generated from：从 Generated 卡连回生成它的那一行（点线）
  /** RPC 标记（线框 03）：不是直接调用，而是发消息让另一个进程去做（点划线）。和 Call 一样连进调用图，标记字母跨过去 */
  rpc?: RpcMark;
  /** 「↩ back to」：回到起点的线（结果送回去），Walkthrough 走到这里停，不沿它走 */
  back?: true;
};

/** 跨进程的机制 */
export const RPC_MECHS = ["shm", "zmq", "HTTP", "gRPC", "torch.distributed", "queue", "ray", "custom"] as const;
/** mech = 机制（custom 时 custom 是用户写的名字）；msg = 消息或方法名；fan = 一对一 / 一对所有 rank */
export type RpcMark = { mech: string; custom?: string; msg?: string; fan?: "one" | "all" };
/** 线上的文字：RPC · shm · "run" · one → all */
export function rpcText(r: RpcMark): string {
  const m = r.mech === "custom" ? r.custom || "custom" : r.mech;
  return ["RPC", m, r.msg ? (/^["']/.test(r.msg) ? r.msg : `"${r.msg}"`) : "", r.fan === "all" ? "one → all ranks" : ""].filter(Boolean).join(" · ");
}

/** 默认只有终点有箭头 */
export const headOf = (l: Pick<Link, "style">) => ({ start: !!l.style?.head?.start, end: l.style?.head?.end !== false });

/** 调用图的标记：字母，或一个内置贴纸图标的名字 */
export type GraphMark = { letter: string } | { icon: string };

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
  boardOnly?: true; // 挂在共享卡上、但只属于这块白板（不跟着卡去别的白板）
  review?: string; // Update 时挂着的行变了：新版本的标签（如 9f3e2a1），琥珀色提醒复查；用户看过就去掉
  variant?: string; // 只在卡的这个 Variant 上显示（线框 07）；行号按那个 Variant 的代码算。没有 = 跟着卡，所有 Variant 都显示
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
 * 贴在哪：代码行（进行号栏，随 Update 跟行走）、画布任意位置，
 * 或绑在卡 / 箭头上（跟着走，同一图层）：on.card 时 x、y 是相对卡左上角的偏移；on.link 时 t 是沿线的位置 0..1，x、y 是相对那一点的偏移
 */
export type StickerOn = { card: string } | { link: string; t: number };
export type StickerAt =
  | { kind: "line"; card: string; seg: string; line: number }
  | { kind: "canvas"; x: number; y: number; size?: number; on?: StickerOn };

/**
 * 疑问（线框 06）：「?」贴纸上写的问题。md = 问题（Markdown）；done = 已解决（贴纸画成 ✓）；answer = 解答它的卡（Note 或别的卡）；at = 提问时间。
 */
export type Question = { md: string; done?: true; answer?: string; at?: number };
export type Sticker = { id: string; icon: IconRef; color?: string; at: StickerAt; q?: Question };
/** 卡右上角的贴纸位置（相对卡左上角，i = 那一排里的第几个）：Update 后行没了的贴纸挪到这里 */
export const cornerAt = (w: number, i = 0) => ({ x: w - 56 - i * 25, y: -11, size: 22 });
/** 内置的「?」贴纸，或写了问题的贴纸 */
export const isQuestion = (s: Pick<Sticker, "icon" | "q">) => !!s.q || (s.icon.pack === "builtin" && s.icon.name === "question");

// ---------- 白板 ----------

export type Camera = { x: number; y: number; z: number };

export type Board = {
  version: 6;
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
  /**
   * 卡片 id → 在这块白板上的创建顺序（调用图标记的字母按它分配；不跟 cards 的叠放顺序走，Arrange 不会改字母）。
   * 新卡在下一次修改时由 stampBorn 编号；seq = 下一个号
   */
  born?: Record<string, number>;
  seq?: number;
  /** 用户改过的调用图标记：键是那张调用图里最早建的卡 */
  marks?: Record<string, GraphMark>;
  /** Arrow 图例（线框 12）：内置几种样式的名字，用户改过的才存 */
  legend?: Partial<Record<LegendKey, string>>;
};

/** 图例：只给样式起名字，不加规则 */
export const LEGEND = [["call", "Call"], ["rpc", "RPC"], ["observed", "Observed"], ["gen", "Generated from"], ["see", "See also"]] as const;
export type LegendKey = (typeof LEGEND)[number][0];
export const legendName = (b: Pick<Board, "legend">, k: LegendKey) => b.legend?.[k] || LEGEND.find((x) => x[0] === k)![1];

// ---------- 共享卡（第 6 版） ----------

/** 白板文件里共享卡的位置：只有 id，内容在卡库里。在 cards 里占着叠放顺序 */
export type SharedRef = { id: string; kind: "shared" };
/** 白板文件：cards 里可以有共享卡的引用。读进来后由宿主换成内容 */
export type BoardFile = Omit<Board, "cards"> & { cards: (Card | SharedRef)[] };
/** 一张共享卡的内容：卡本身 + 跟着它走的 Sidenote（挂在它上面、不是 boardOnly、不是 kind card） */
export type SharedCard = { card: Card; sidenotes: Sidenote[] };
/** 卡库里的文件 cards/<id>.json。写盘时按项（卡、每条 Sidenote）和磁盘上的合并（storage/boards.ts merged） */
export type SharedCardFile = SharedCard & { version: 6 };

/** subs = 这块白板上嵌着的子白板（去重，按出现的先后；侧栏按它缩进成树） */
export type BoardMeta = { id: string; name: string; group?: string; cards: number; stale?: number; subs?: string[] };

export function emptyBoard(id: string, name: string): Board {
  return { version: BOARD_VERSION, id, name, cam: { x: 80, y: 80, z: 1 }, cards: [], place: {}, links: [], sections: [], sidenotes: [], stickers: [], born: {}, seq: 0 };
}

// ---------- 小工具 ----------

let seq = 0;
/** 新 id：前缀 + 时间 + 序号 + 随机（卡、段、Link、白板都用它） */
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
    case "board": return "Board";
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

/** 路径的最后一段（/ 和 \ 都认） */
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
/** Markdown 的第一句（去掉标题、引用、列表标记和 ** `；__init__ 这种名字不动）：Note 的默认名、问题列表、骨架里的名字 */
export const firstLine = (md: string) => md.split("\n").map((l) => l.replace(/^[#>\-*\s]+/, "").replace(/\*\*|`/g, "").trim()).find(Boolean) ?? "";
/** 当正则里的字面文字 */
export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 深拷贝。白板在 mutate 里传进来的是 store 的代理，structuredClone 拷不了，所以走 JSON（白板数据本来就是 JSON） */
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
export function domainOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** short：卡头里用，尽量短（不在 git 里的文件只显示内容哈希的前 4 位） */
export function versionLabel(v: Version | undefined, short = false): string {
  if (!v) return "";
  if (short && v.kind === "hash") return v.hash.slice(0, 4);
  switch (v.kind) {
    case "git": return v.commit.slice(0, 7);
    case "pkg": return `${v.name} ${v.version}`;
    case "hash": return `Unknown version · ${v.hash.slice(0, 4)}`;
    case "none": return "No commit";
  }
}

export function sameSource(a: Source, b: Source) {
  switch (a.kind) {
    case "repo": return b.kind === "repo" && a.repo === b.repo;
    case "external": return b.kind === "external" && a.root === b.root;
    case "github": return b.kind === "github" && a.owner === b.owner && a.name === b.name && a.ref === b.ref;
    case "free": return b.kind === "free" && a.url === b.url;
  }
}

/** 第 l 行落在哪个区间里（隐藏的行范围） */
export const inRanges = (rs: [number, number][] | undefined, l: number) => rs?.find(([a, b]) => a <= l && l <= b);

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

/** 卡 id → 画布上摆着它的卡的 id（Compare 的栏 → 那张 Compare，其余是自己）。一次建好，按 id 查 */
export function hostOf(b: Pick<Board, "cards">): (id: string) => string {
  const m = new Map<string, string>();
  for (const c of b.cards) if (c.kind === "compare") for (const k of c.cols) m.set(k, c.id);
  return (id) => m.get(id) ?? id;
}

/** 这张卡连同它的两栏（Compare），其余就是自己 */
export const cardAndCols = (c: Card): string[] => (c.kind === "compare" ? [c.id, ...c.cols] : [c.id]);

/** 这些卡连同 Compare 的两栏（按 cards 里的先后；白板上没有的 id 不要） */
export function withCols(b: Pick<Board, "cards">, ids: Iterable<string>): string[] {
  const want = new Set(ids);
  for (const c of b.cards) if (want.has(c.id)) cardAndCols(c).forEach((k) => want.add(k));
  return b.cards.filter((c) => want.has(c.id)).map((c) => c.id);
}

/** 贴纸贴在哪张卡、哪一行（绑在箭头上的算箭头出发的那一处；画布上没绑东西的没有） */
export function stickerWhere(b: Pick<Board, "links">, s: Sticker): { card?: string; seg?: string; line?: number } {
  const at = s.at;
  if (at.kind === "line") return { card: at.card, seg: at.seg, line: at.line };
  if (!at.on) return {};
  if ("card" in at.on) return { card: at.on.card };
  const id = at.on.link;
  const l = b.links.find((k) => k.id === id);
  return l ? { card: l.from.card, seg: l.from.seg, line: l.from.line } : {};
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
    if (p && p.src.kind !== "free" && s.src.kind !== "free" && p.path === s.path && sameSource(p.src, s.src) && sameVersion(p.version, s.version) && s.start <= p.end + 1) {
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

/** 调用的显示名：Scheduler.schedule → schedule；__init__ → 类名 */
export function callName(qual: string): string {
  const q = qual.split(".");
  const last = q[q.length - 1];
  return last === "__init__" && q.length > 1 ? q[q.length - 2] : last;
}

/** Call 箭头是不是从这个调用点出发（同一张卡、同一段、同一行，调用的是同一个名字） */
export const sameCallSite = (l: Pick<Link, "from" | "call">, at: { card: string; seg?: string; line?: number; name: string }) =>
  !!l.call && l.from.card === at.card && l.from.seg === at.seg && l.from.line === at.line && l.call.name === at.name;

export const varKey = (v: Var) => `${v.ret ? "→" : ""}${v.a}|${v.b ?? ""}`;
/** 线上显示的文字：名字相同只显示一个；不同显示 a → b；返回值 → logits */
export const varText = (v: Var) => (v.ret ? `return → ${v.a}` : v.b ? `${v.a} → ${v.b}` : v.a);
