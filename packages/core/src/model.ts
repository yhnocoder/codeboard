// 卡片内容（Card）和它在这块白板上的摆放（Place）分开存：共享卡、子白板让同一张卡出现在几块白板上，
// 内容只有一份，摆放每块白板各一份。Compare 只引用两张卡的 id，那两张卡在 cards 里但没有 Place（不单独出现在画布上）。
// 基本元素：Card、Place、Link、Section、Sidenote、Sticker。流程、讲解、Compare 都由它们派生。
// 共享卡：内容存在卡库 <存储目录>/cards/<id>.json（卡 + 跟着它走的 Sidenote），白板文件里只留引用（SharedRef）；
// 宿主读白板时把引用换成内容（inflate），界面拿到的永远是完整的 Board。
// Markdown 里转义的 \$ 总是字面的 $（旧编辑器写下的 \$…\$ 公式由 migrate.ts 改成 $…$）。

import type { BoundVal, CallAlt, Var } from "@codeboard/analysis/basics";

export const BOARD_VERSION = 9;

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
  | { kind: "free"; url?: string; langPicked?: true }; // 手写或粘贴，只有文本；langPicked = 语言是从下拉里手选的，不再按内容自动识别

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
  annots?: CodeAnnot[]; // 贴在字上的手写标注（代码本身不改）
};

/** 手写的东西（Mark 卡、贴在字上的标注）的四种颜色 */
export const HAND_COLORS = ["blue", "purple", "orange", "green"] as const;
export type HandColor = (typeof HAND_COLORS)[number];

/**
 * 代码里一段字上的手写标注：第 line 行的第 from 到 to 个字（0-based，to 不含，按原文算，Tab 算一个字），
 * 标签写在那一行上面（below = 下面）新开的一条窄轨道里。color 没有 = blue
 */
export type CodeAnnot = { line: number; from: number; to: number; text: string; color?: HandColor; below?: true };

type CardBase = {
  id: string;
  title?: string; // 用户改过的名字；没有就用默认名
  desc?: string; // 卡片说明（标题下一段话，Walkthrough 时显示）
  /** 进程标签：自由文字（rank 0、rank 1…N、Scheduler × TP）；light = 线程 / CUDA stream，浅一点的样式 */
  procs?: ProcTag[];
  /** 像贴纸一样斜贴在白板上（转 TILT_DEG，编辑时回正） */
  tilt?: true;
  /**
   * 同一张卡摆在这块白板上的几处（粘贴后选了 Reference）：same 一样的几张卡内容永远一样（twinContent），改一张，store 把别的跟着改；
   * 各自的 id、摆放、斜贴、连着的箭头和 Sidenote 不同。段 id 也一样（展示数据按段 id 存，同一份）
   */
  same?: string;
};

export type ProcTag = { text: string; light?: boolean };

export type HideFlags = { comments?: boolean; docstrings?: boolean; blank?: boolean };

/** 代码卡：函数 / 类 / 片段 / 多段 / GitHub Code / Free code 都是它，区别在段的来源和符号 */
export type CodeCard = CardBase & {
  kind: "code";
  segments: Segment[];
  hide?: HideFlags;
  wrap?: boolean;
  /** false = 没有卡框：代码直接写在画布上，头部和边框只在悬停 / 选中时浮出（和图片卡的 bg 同一个意思，只是代码卡默认有） */
  bg?: false;
  /** 类卡：只列成员签名；shown = 卡上显示的成员（qual），其余收在「+ N more methods」 */
  members?: { shown: string[] };
  /** 合并来的卡：合并前的原卡和它们的摆放（Unmerge 时拆回） */
  mergedFrom?: { card: CodeCard; place: Place }[];
  keepOld?: true; // 符号找不到时选了 Keep Old Version：不再提示
  /** Generated 卡：生成出来的代码 / 编译产物（what = CUDA source、Inductor output），钉在一次运行和那组参数上（run），不钉 commit */
  gen?: { what: string; run?: string };
  /**
   * 我的改动：同一段代码的几个版本，卡上一排标签页。第一个永远是上游（钉住的版本，from.kind = upstream）。
   * 当前显示的那个（active）的段就是 segments；其余 Variant 的段存在各自的 segs 里，段 id 和 segments 一一对应（Link、Sidenote 的 seg 不用换）。
   */
  variants?: Variant[];
  active?: string; // 当前显示的 Variant 的 id；没有 = 上游
};

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

/** 上游 Variant 的 id（卡上第一个标签：钉住的版本） */
export const UPSTREAM = "up";
/** 当前显示的 Variant（没有 Variant 的卡 = 上游） */
export const activeOf = (c: Pick<CodeCard, "active">) => c.active ?? UPSTREAM;
export const onVariant = (c: Pick<CodeCard, "variants" | "active">) => !!c.variants?.length && activeOf(c) !== UPSTREAM;
/** 不是当前显示的 Variant 的段，展示数据存在 views[viewKey(段, Variant)] */
export const viewKey = (sid: string, vid: string) => `${sid}@${vid}`;
/** viewKey 拆回段 id 和 Variant id（普通的段 id 没有 vid） */
export function parseViewKey(k: string): { sid: string; vid?: string } {
  const at = k.lastIndexOf("@");
  return at > 0 ? { sid: k.slice(0, at), vid: k.slice(at + 1) } : { sid: k };
}
/** 这张卡某个 Variant 的段的展示数据存在哪：正显示着 = 段 id，否则 viewKey */
export const viewKeyOf = (c: Pick<CodeCard, "active">, sid: string, vid: string) => (activeOf(c) === vid ? sid : viewKey(sid, vid));

/**
 * 写在白板上的字的四种样子：Note = 卡片（卡框、「¶ 标题」栏）；Text、Box、Mark 没有卡框。
 * 只有 Note ↔ Text 能互转（turnNoteInto），Box、Mark 不和别的互转
 */
export const NOTE_LOOKS = ["note", "text", "box", "mark"] as const;
export type NoteLook = (typeof NOTE_LOOKS)[number];
/** Box 的底色：新 Box 是第一个（黄色） */
export const BOX_FILLS = ["yellow", "paper", "blue", "green", "pink"] as const;
export type BoxFill = (typeof BOX_FILLS)[number];

export type NoteCard = CardBase & {
  kind: "note";
  md: string;
  look: NoteLook;
  size?: "title" | "heading" | "body"; // Text 的字号
  bold?: boolean;
  /** Box 的底色（只有 Box 有） */
  fill?: BoxFill;
  /** Mark 的颜色（只有 Mark 有）：手写字、统一字号；从它出发的箭头画成这个颜色的手绘线 */
  hand?: HandColor;
  /** 消息卡：跨进程时夹在发送点和接收处之间的消息类型（md = 类型名，where = 定义在哪，如 io_struct.py） */
  msg?: { where?: string };
};
/** 没有卡框、字直接写在画布上的（Text、Box、Mark） */
export const frameless = (c: Card | undefined): c is NoteCard => c?.kind === "note" && c.look !== "note";
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
 * 子白板：另一块白板嵌在这块白板上，框里按 Section 分栏画成能读的小卡片（种类图标、标题、一行摘要，不画代码和箭头）。
 * 只存是哪块白板；骨架由宿主按那块白板算好发来（白板界面里没有子白板的完整内容）。Place 总有 h（框的大小由用户定）。
 */
/** pcols = 框右边点开的预览排几栏：2 栏时写 2，缺省 1 栏（看的时候的选择，不进撤销） */
export type BoardCard = CardBase & { kind: "board"; board: string; pcols?: 2 };

export type Card = CodeCard | NoteCard | ImageCard | WebCard | LinksCard | CompareCard | BoardCard;
export type CardKind = Card["kind"];

export type Place = {
  x: number;
  y: number;
  w: number;
  h?: number; // 用户拖过高度才有；否则按内容自动高，上限后卡内滚动。代码卡存的是内容区的高度，不含卡头 / 底栏（那部分随主题变）
  section?: string; // 所在 Section（按卡片中心点判断，拖动结束时更新）
  locked?: boolean;
  collapsed?: boolean; // 折叠了它下面的 Call 子树
  start?: boolean; // 起点卡：不选卡直接 Walkthrough、调用树从这里开始
  // 白板上量到的整张卡的高（视图 sync 写，不进撤销）：宿主量不到实测尺寸，estSize 先用它（子白板的缩略地图、宿主排新卡）。
  // 没定 h 的卡才写，和估计的差不到几像素就不写
  mh?: number;
};

// Link 在界面上叫 Arrow
/** Link 的一端：整张卡，或卡里某一段的某一行（子白板框只能整张连：框里的小卡片只是预览） */
export type End = { card: string; seg?: string; line?: number };

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
 * 证据分三档：没有 ev = static（静态解析出来的）；manual = 手动补的；observed = 一次运行里真的从这一行进了那个函数。
 * 线上画最强的那档（observed > static > manual），悬停列出全部：observed 时 base 记下它原来是哪档（manual；没有 = static）。
 * via = 怎么补上的（registry、search）；cmd / log / at / commit = observed 的证据：运行命令、日志行、时间、当时的 commit；
 * count = 那次运行里调了几次，run = 运行记录的 id（<存储目录>/runs/<id>.json）
 */
export type CallEvidence = { kind: "manual" | "observed"; via?: string; cmd?: string; log?: string[]; at?: number; commit?: string; count?: number; run?: string; base?: "manual" };
/** 运行时的一次调用：n = 第几次（从 1 数），args = [形参名, 值的简写]（tensor 只记 shape / dtype / device） */
export type CallSample = { n: number; args: [string, string][] };

/** 箭头的样子：dash = 虚线；width 默认 2；head 默认只有终点有箭头；color 默认灰 */
export type LinkStyle = { dash?: true; width?: 1 | 2 | 3; head?: { start?: boolean; end?: boolean }; color?: string };

/**
 * 箭头：只有这一种。两端各是整张卡或某一行，一行 / 一张卡可以连出、连进任意多条。
 * 调用是箭头上的 Call 标记（call），不是另一种线。标记怎么组合见 LinkMarks
 */
export type Link = LinkBase & LinkMarks;

/**
 * 箭头上的标记能怎么组合（其余字段都是样式，随便配）：
 * - gen（Generated from）独占：只连 Generated 卡和生成它的那一行，不带 call / rpc / back。它不是调用，也不是讲解的返回线
 * - call、rpc、back 各自可有可无，能同时有：call = 这一行调用了目标（参数、备选、↺）；rpc = 跨进程发过去（图例按 RPC 画）；
 *   back = 回到起点的线（Walkthrough 走到这里停；带 call / rpc 时也不进调用图，见 flow.isCall）
 * 每次修改后 danglingRefs 也查一遍（旧文件由 migrate 规整）
 */
export type LinkMarks =
  | { gen?: undefined; call?: CallMark; rpc?: RpcMark; back?: true }
  | { gen: true; call?: undefined; rpc?: undefined; back?: undefined };

type LinkBase = {
  id: string;
  from: End;
  to: End;
  label?: string; // 用户写的话，浮在线上
  at?: number; // 标签框沿线的位置 0..1（用户拖过才有；默认在中间）
  style?: LinkStyle;
  sides?: { from?: LinkSide; to?: LinkSide }; // 用户选过的进出边
  lost?: { from?: true; to?: true }; // 这一端连着的行在代码更新后没了：端点退到卡头，画成红色，等用户重连或删掉
};
/** 这条箭头能不能加 call / rpc / back（Generated from 不能，见 LinkMarks） */
export const canMark = (l: Link): l is LinkBase & Extract<LinkMarks, { gen?: undefined }> => !l.gen;

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

/** 挂在哪：整张卡、一行或几行 */
export type Anchor = { card: string; seg?: string; lines?: [number, number] };

export type Sidenote = {
  id: string;
  at: Anchor;
  why?: string; // 「为什么相关」，可选
  lineRemoved?: boolean; // 更新版本时原来的行被删了，改挂整卡
  boardOnly?: true; // 挂在共享卡上、但只属于这块白板（不跟着卡去别的白板）
  review?: string; // Update 时挂着的行变了：新版本的标签（如 9f3e2a1），琥珀色提醒复查；用户看过就去掉
  variant?: string; // 只在卡的这个 Variant 上显示；行号按那个 Variant 的代码算。没有 = 跟着卡，所有 Variant 都显示
} & (
  | { kind: "code"; code: Segment } // 仓库里或仓库外的代码，钉版本
  | { kind: "paste"; text: string; lang: string; url?: string }
  | { kind: "text"; md: string; alwaysShow?: boolean }
  | { kind: "link"; url: string; title?: string }
  | { kind: "card"; card: string }
);
export type SidenoteKind = Sidenote["kind"];

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
 * 疑问：「?」贴纸上写的问题。md = 问题（Markdown）；done = 已解决（贴纸画成 ✓）；answer = 解答它的卡（Note 或别的卡）；at = 提问时间。
 */
export type Question = { md: string; done?: true; answer?: string; at?: number };
export type Sticker = { id: string; icon: IconRef; color?: string; at: StickerAt; q?: Question };
/** 卡右上角的贴纸位置（相对卡左上角，i = 那一排里的第几个）：Update 后行没了的贴纸挪到这里 */
export const cornerAt = (w: number, i = 0) => ({ x: w - 56 - i * 25, y: -11, size: 22 });
/** 内置的「?」贴纸，或写了问题的贴纸 */
export const isQuestion = (s: Pick<Sticker, "icon" | "q">) => !!s.q || (s.icon.pack === "builtin" && s.icon.name === "question");

export type Camera = { x: number; y: number; z: number };
/** 新白板、这台机器上还没看过的白板的镜头 */
export const homeCam = (): Camera => ({ x: 80, y: 80, z: 1 });

export type Board = {
  version: 9;
  id: string;
  name: string;
  /** 镜头：不写进白板文件（光是平移、缩放就改了文件，项目里用 git 管白板时全是噪音），每台机器各记各的（宿主的工作区状态，按白板 id） */
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
  /** Arrow 图例：内置几种样式的名字，用户改过的才存 */
  legend?: Partial<Record<LegendKey, string>>;
};

/** 图例：只给样式起名字，不加规则 */
export const LEGEND = [["call", "Call"], ["rpc", "RPC"], ["observed", "Observed"], ["gen", "Generated from"], ["see", "See also"]] as const;
export type LegendKey = (typeof LEGEND)[number][0];
export const legendName = (b: Pick<Board, "legend">, k: LegendKey) => b.legend?.[k] || LEGEND.find((x) => x[0] === k)![1];

/** 白板文件里共享卡的位置：只有 id，内容在卡库里。在 cards 里占着叠放顺序 */
export type SharedRef = { id: string; kind: "shared" };
/** 白板文件：cards 里可以有共享卡的引用，读进来后由宿主换成内容；没有镜头（见 Board.cam） */
export type BoardFile = Omit<Board, "cards" | "cam"> & { cards: (Card | SharedRef)[] };
/** 一张共享卡的内容：卡本身 + 跟着它走的 Sidenote（挂在它上面、不是 boardOnly、不是 kind card） */
export type SharedCard = { card: Card; sidenotes: Sidenote[] };
/** 卡库里的文件 cards/<id>.json。写盘时按项（卡、每条 Sidenote）和磁盘上的合并（storage/boards.ts merged） */
export type SharedCardFile = SharedCard & { version: 9 };

/** subs = 这块白板上嵌着的子白板（去重，按出现的先后；侧栏按它缩进成树） */
export type BoardMeta = { id: string; name: string; group?: string; cards: number; stale?: number; subs?: string[] };
/** 读不了的白板文件（JSON 坏了、过不了 schema）：侧栏照样列出来，免得看起来像白板没了。name = 文件里的 name，没有就用文件名 */
export type BrokenBoard = { file: string; name: string; group?: string; reason: string };

export function emptyBoard(id: string, name: string): Board {
  return { version: BOARD_VERSION, id, name, cam: homeCam(), cards: [], place: {}, links: [], sections: [], sidenotes: [], stickers: [], born: {}, seq: 0 };
}

let seq = 0;
/** 新 id：前缀 + 时间 + 序号 + 随机（卡、段、Link、白板都用它） */
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const isCode = (c: Card | undefined): c is CodeCard => c?.kind === "code";

const LOOK_NAME: Record<NoteLook, string> = { note: "Note", text: "Text", box: "Box", mark: "Mark" };

export function cardTitle(c: Card, b?: Pick<Board, "cards">): string {
  if (c.title) return c.title;
  switch (c.kind) {
    case "code": return codeTitle(c);
    case "note": return firstLine(c.md) || LOOK_NAME[c.look];
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
/**
 * Markdown 开头的标题（第一行非空的是 # 标题时）的纯文字，没有就是 ""：Note 卡头显示它（不另存一份标题）。
 * 只看到第一行非空的为止，不解析整篇；去掉行内的 **、*、_、`、~~ 和链接写法
 */
export function mdHeading(md: string): string {
  let i = 0;
  for (;;) {
    const e = md.indexOf("\n", i);
    const line = md.slice(i, e < 0 ? undefined : e).trim();
    if (line) {
      const m = /^#{1,6}\s+(.*?)(?:\s+#+)?$/.exec(line);
      return m ? m[1].replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__|~~|`|\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2").replace(/\$+/g, "").trim() : "";
    }
    if (e < 0) return "";
    i = e + 1;
  }
}
/** Markdown 的第一行字（标题用）：图片换成它的 alt（只有一张没 alt 的图的行跳过：粘贴的截图） */
export const firstLine = (md: string) => md.split("\n").map((l) => l.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1").replace(/^[#>\-*\s]+/, "").replace(/\*\*|`/g, "").trim()).find(Boolean) ?? "";
/** 深拷贝。白板在 mutate 里传进来的是 store 的代理，structuredClone 拷不了，所以走 JSON（白板数据本来就是 JSON） */
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** 摆在几处的同一张卡（same）共用的内容：除了 id、same 和斜贴（tilt 跟着摆放走） */
const OWN = new Set(["id", "same", "tilt"]);
export function twinContent(c: Card): string {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (!OWN.has(k)) o[k] = v;
  return JSON.stringify(o);
}
/** to 的内容换成 from 的（from 是普通对象；to 可以是白板 store 里的代理）：只写变了的字段，别的字段不通知 */
export function copyTwinContent(from: Card, to: Card, raw: <T>(x: T) => T = (x) => x): void {
  const f = from as Record<string, unknown>, t = to as Record<string, unknown>, r = raw(to) as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!OWN.has(k) && !(k in f)) delete t[k];
  for (const [k, v] of Object.entries(f)) {
    if (OWN.has(k)) continue;
    if (typeof v !== "object" || v === null) { if (r[k] !== v) t[k] = v; }
    else if (JSON.stringify(r[k]) !== JSON.stringify(v)) t[k] = clone(v);
  }
}
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

/**
 * 白板上所有的段（同一个对象，不拷贝）：代码卡（含 Compare 的两栏）的段、各个 Variant 存着的段、合并前的原卡（一层层往里）、Code sidenote。
 * 换项目时改写段的来源用（漏一个，那段在新项目里就找不到代码）
 */
export function allSegments(b: Pick<Board, "cards" | "sidenotes">): Segment[] {
  const out = new Set<Segment>();
  const walk = (c: CodeCard) => {
    for (const s of c.segments) out.add(s);
    for (const v of c.variants ?? []) for (const s of v.segs ?? []) out.add(s);
    for (const m of c.mergedFrom ?? []) walk(m.card);
  };
  allCodeCards(b).forEach(walk);
  for (const n of b.sidenotes) if (n.kind === "code") out.add(n.code);
  return [...out];
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
      if (s.annots) p.annots = [...(p.annots ?? []), ...s.annots];
      if (p.symbol && s.symbol?.qual !== p.symbol.qual) p.symbol = undefined;
      continue;
    }
    out.push({ ...s, text: [...s.text], hidden: s.hidden ? [...s.hidden] : undefined, hl: s.hl ? [...s.hl] : undefined, annots: s.annots?.map((a) => ({ ...a })) });
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

/**
 * 备选就是这一段的代码：qual 一样、文件也一样（备选的 path 相对工作区，段的相对仓库）。只比 qual 不够：同一个
 * DispatchStub 的 CUDA 和 CPU 注册常是两个文件里同名的 at::native::add_kernel
 */
export const altIsSeg = (a: Pick<CallAlt, "qual" | "path">, s: Pick<Segment, "path"> & { symbol?: Pick<SymRef, "qual"> }) =>
  !!a.qual && a.qual === s.symbol?.qual && (!a.path || a.path === s.path || a.path.endsWith(`/${s.path}`));

/** 线上显示的文字：名字相同只显示一个；不同显示 a → b；返回值 → logits */
export const varText = (v: Var) => (v.ret ? `return → ${v.a}` : v.b ? `${v.a} → ${v.b}` : v.a);
