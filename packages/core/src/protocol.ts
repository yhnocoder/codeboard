// 宿主 ↔ 白板的消息。白板持有白板状态，改动后把变了的项发回来保存（patch）；宿主负责读代码、高亮、版本、跳转，
// 以及把共享卡的改动转给开着同一张卡的别的白板（shared）。
// 需要回答的请求带 req，宿主用 { type: "reply", req, … } 回。
import type { Board, BoardMeta, Camera, CodeCard, Segment, Card, Var, Version, HideFlags, WebMeta, CallMark, BoundVal, CallAlt } from "./model";
import type { SegView } from "./lines";
import type { BoardPatch, SharedUpdate } from "./patch";
import type { CardCopy } from "./edit";
import type { SharedInfo } from "./shared";
import type { Skeleton } from "./subboard";

/** 子白板的面包屑：从最外层到当前白板的上一级（进入子白板时宿主记着；frame = 在那块白板上是哪个框） */
export type Crumb = { id: string; name: string; frame: string };
/**
 * 跨白板的讲解。进入子白板：into = 父白板的讲解走到了第几步（root 出发），start = 从子白板的这张卡讲起（没有 = 从第一张图的根）；
 * 回到父白板：resume = 从 root 出发的讲解接着讲第 i 步。宿主只是转一下
 */
export type WalkHop = { into?: { root: string; i: number }; start?: string; resume?: { root: string; i: number } };

/** 一段代码和当前代码的关系（「新版本」） */
export type Stale =
  | { state: "ok" }
  | { state: "moved"; start: number; end: number; version?: Version } // 只是挪了位置：白板静默跟上
  | { state: "changed"; hiddenOnly: boolean; head: string } // 黄点；hiddenOnly = 只有隐藏的行变了（空心点）
  | { state: "lost" } // 符号找不到（删了或改名）
  | { state: "many" } // 片段按内容找到多处
  | { state: "uncommitted" } // 钉在 HEAD，但工作区有未提交改动
  | { state: "missing" }; // 仓库 / 文件不在：只读快照

/** 12 种材质主题；明暗跟随 VS Code */
export const THEMES = [
  ["warm-ink", "Warm Ink"], ["graphite", "Graphite"], ["soft-light", "Soft Light"], ["drafting", "Drafting"],
  ["colorful", "Colorful"], ["newspaper", "Newspaper"], ["poster", "Poster"], ["classic", "Classic"],
  ["ink-wash", "Ink Wash"], ["city", "City"],
] as const;
export type ThemeId = (typeof THEMES)[number][0];
/** 实验性的主题：主题选择里和 VS Code 设置说明里标 Experimental；性能测试和 CI 的性能门槛不管它们（City 太复杂，容易超时） */
export const EXPERIMENTAL_THEMES: readonly ThemeId[] = ["city"];

/** 全局设置：同步成 VS Code 的 codeboard.* 设置，所有白板共用 */
export type Settings = {
  theme: ThemeId;
  hideOnNew: HideFlags; // 新卡默认隐藏什么（替代卡片上的 Hide 浮条）
  studyScope: string[]; // 除了工作区以外也算 project code 的包（torch、vllm…）
  stickerDir: string; // Sticker Packs 目录；"" = ~/.codeboard/stickers
  zoomOverview: number; // 低于这个比例：概览（代码变灰条）
  zoomMap: number; // 低于这个比例：地图（只剩图标记和名字）
  dblClick: "text" | "note" | "code" | "none"; // 双击画布空白处新建什么
  hideNumbers?: boolean; // 卡片上不显示调用图标记（A / B 或图标）；设置里叫 Hide Call Graph Marks
  themeReflow?: "push" | "overlap"; // 换主题后卡变高压住下面的卡：往下推（默认）/ 允许重叠
  debug?: boolean; // 打开后设置页多一节 Debug（调常量）
  tune?: Record<string, number>; // Debug 里调过的常量，没有 = 默认值
  pasteOther?: "linked" | "copy"; // 卡贴到另一块白板上：共享卡（默认）/ 独立副本；⌥ 粘贴是另一种
  sharedUpdate?: "ask" | "all" | "this"; // 共享卡 Update 新版本：每次问（默认）/ 所有白板 / 只这块白板（拆成副本）
};
export const DEFAULT_SETTINGS: Settings = {
  theme: "warm-ink", hideOnNew: { blank: false }, studyScope: [], stickerDir: "", zoomOverview: 0.6, zoomMap: 0.25, dblClick: "text",
};

/** 贴纸图标包：Iconify JSON 一个文件一套，或一个装 .svg 的文件夹（文件夹名 = 包名） */
export type StickerPack = { id: string; name: string; icons: { name: string; svg: string }[] };

export type HostInfo = {
  fontFamily?: string; // 跟随 VS Code 编辑器字体
  isMac: boolean;
  assetBase: string; // assets/ 目录的 webview URI，图片卡用
  readonly?: string; // 仓库找不到时的提示
  target: boolean; // 编辑器里 Add to 的目标白板是不是这块
  settings: Settings;
  /** 这些快捷键（⌘ + 键）被宿主拦下后以 {type:"key"} 转回来，白板自己不再处理（免得做两次） */
  forwardedKeys?: string[];
  /** 宿主能做 AI 续写（VS Code 的语言模型）：Note 编辑时的灰字补全 */
  complete?: boolean;
  /** ⌘C 复制的卡在哪块白板上、几张（画布菜单的 Paste as Linked Card / Paste as Copy 用） */
  clip?: { board: string; n: number };
};

/** 宿主替白板拦下的快捷键对应的动作（VS Code 会先吃掉 ⌘K ⌘D ⌘0 ⌘1 ⌘± ⌘⇧L ⌘⇧B ⌘,）；settings = ⌘, 开关设置页，openSettings = 命令 Open Settings（只开） */
export type KeyAction = "search" | "duplicate" | "fitAll" | "zoom100" | "zoomIn" | "zoomOut" | "lock" | "settings" | "openSettings" | "turnIntoBoard";

export type PeekDef = {
  path: string; // 显示用的路径
  line: number; // 定义 / 赋值所在行
  start: number; // 上下文第一行
  html: string[]; // 上下文几行（高亮）
  text: string[];
  seg: Segment; // Pin as Sidenote / Place on Board 用
  follow?: { label: string; line: number; col: number; path: string }; // 下一跳：config.max_num_batched_tokens · config.py:9
  // 以下 v0.1.5 起；旧的宿主没有，白板按 start 连续行显示
  kind?: "field" | "function" | "class" | "module" | "other"; // 源码部分按定义类型取（module 不放源码）
  rows?: number[]; // html / text 每一行的行号（不连续时）；缺省 = start 起连续
  head?: string; // 行上面的小标题：class Config
  more?: number; // 「⋯ N more lines」
  sig?: string; // hover 的签名：(variable) kvcache_block_size: int
  sigHtml?: string; // 签名高亮后的 HTML
  doc?: string; // hover 的文档（Markdown）
  lib?: string; // 定义在 library code 里：包名（在 Study Scope 里时白板不标 library）
  title?: string; // 标题里代替 文件:行（模块：torch/multiprocessing）
  /** 动态分发：定义处是基类的方法，有 n 个实现（悬停显示「Dynamic dispatch · n implementations」） */
  dispatch?: { n: number; base: string; abstract?: boolean };
};

export type SearchItem =
  | { kind: "symbol"; label: string; detail: string; path: string; line: number; sym: string; glyph: string }
  | { kind: "file"; label: string; detail: string; path: string }
  | { kind: "card"; label: string; detail: string; board: string; card: string; num?: string }
  | { kind: "sidenote"; label: string; detail: string; board: string; card: string; sidenote: string }
  | { kind: "entry"; label: string; detail: string; path: string; line: number; sym?: string; end?: number };

export type Commit = { commit: string; msg: string; date: string; head?: boolean };

export type DiffData = {
  title: string; // New Version · Scheduler.schedule
  left: { label: string; path: string; start: number; text: string[]; html: string[] };
  right: { label: string; path: string; start: number; text: string[]; html: string[] };
  lastChange?: string; // Last changed in f64d821 · fix … · 2026-04-26
  canUpdate: boolean;
  newSeg?: Segment; // Update / Duplicate 用的新段（HEAD 版本）
  newView?: SegView;
};

/** 宿主建好的卡（位置由白板定；w 缺省按内容估） */
export type NewCard = { card: Card; views: Record<string, SegView>; w?: number };

/** From GitHub… 面板向宿主要的数据（走 GitHub REST API，需要时用 VS Code 的 GitHub 登录） */
export type GhQuery =
  | { op: "repo"; owner: string; name: string } // 回 GhRepo
  | { op: "commit"; owner: string; name: string; ref: string } // 回 Commit（ref 解析成完整 sha）
  | { op: "tree"; owner: string; name: string; commit: string } // 回 GhTree
  | { op: "file"; owner: string; name: string; commit: string; ref?: string; path: string } // 回 GhFile（文件同时缓存到本地，出现在 GITHUB FILES 侧栏）
  | { op: "card"; owner: string; name: string; commit: string; ref: string; path: string; start: number; end: number }; // 回 NewCard
export type GhRepo = { owner: string; name: string; branch: string; branches: string[]; tags: string[]; private?: boolean; desc?: string };
export type GhTree = { commit: string; paths: { path: string; dir?: boolean }[]; truncated?: boolean };
export type GhFile = { path: string; lang: string; text: string[]; html: string[] };

export type HostToBoard =
  /** crumbs：这块白板是从哪几块父白板一路进来的（没有 = 顶层）；walk：进来 / 回来时接着讲解 */
  | { type: "init"; board: Board; boards: BoardMeta[]; views: Record<string, SegView>; stale: Record<string, Stale>; host: HostInfo; crumbs?: Crumb[]; walk?: WalkHop }
  | { type: "views"; views: Record<string, SegView> }
  | { type: "stale"; stale: Record<string, Stale> }
  | { type: "boards"; boards: BoardMeta[] }
  | { type: "host"; host: Partial<HostInfo> }
  /** 从编辑器加进来的卡：放在选中卡旁边，没选中放视口中央 */
  | { type: "add"; cards: NewCard[]; ask?: "split"; sel?: { card: string } }
  /** 给选中的卡追加一段 */
  | { type: "appendSegment"; card: string; seg: Segment; view: SegView }
  /** 编辑器 ⌥S：作为 Sidenote 挂到白板上选中的行 */
  | { type: "addSidenote"; seg: Segment; view?: SegView }
  | { type: "reveal"; card: string; seg?: string; lines?: [number, number] }
  /** 宿主拦下的快捷键转给白板 */
  | { type: "key"; action: KeyAction }
  /** 侧栏 / 命令面板改了白板名 */
  | { type: "rename"; name: string }
  /** Relocate：符号在编辑器里找到了新位置，换掉这一段（段 id 不变） */
  | { type: "replaceSegment"; card: string; seg: Segment; view: SegView }
  | { type: "toast"; text: string }
  /** 侧栏 GITHUB FILES 的 Add Repo…：打开 From GitHub… 面板 */
  | { type: "githubPicker"; repo?: string }
  /** 共享卡在别的白板上改了（或这块白板撤销时被跳过的项）：卡和跟着它走的 Sidenote 的新内容。白板用 sync 换上（不进撤销栈），不再发回来 */
  | { type: "shared"; cards: SharedUpdate[]; views?: Record<string, SegView> }
  /** 这块白板上的共享卡在几块白板上、别的白板上谁连到它（宿主在存盘后算，整个换掉） */
  | { type: "sharedInfo"; cards: Record<string, SharedInfo> }
  /** 别的白板 Delete Everywhere 删掉了这些共享卡：白板用 sync 删掉（不进撤销栈） */
  | { type: "sharedGone"; cards: string[] }
  /** 这块白板上的子白板的骨架（变了的那几块；null = 那块白板没了）。子白板存盘后宿主重算，防抖 */
  | { type: "skeletons"; boards: Record<string, Skeleton | null> }
  | { type: "reply"; req: number; data?: ReplyOf<AskType>; error?: string };

export type BoardToHost =
  | { type: "ready" }
  /** 自动保存：变了的项（undo = 这批改动里有撤销 / 重做）。回跳过的共享项数；写盘失败回 error，白板过一会儿整块重发 */
  | { type: "patch"; req: number; patch: BoardPatch; undo?: true }
  | { type: "selection"; cards: string[]; lines?: { card: string; seg: string; start: number; end: number } }
  /** Open in Editor：钉的 commit 不是当前代码时开只读版本 */
  | { type: "open"; card: string; seg?: string; line?: number }
  | { type: "openPath"; path: string; line?: number }
  | { type: "openLink"; url: string }
  /** 点调用展开：回 ExpandResult */
  | { type: "expand"; req: number; seg: Segment; line: number; col: number; name: string; recv?: string; pick?: ExpandPick }
  /** 鼠标停在调用上：宿主先在后台问定义、读好目标文件（不回答；点下去的 expand 复用） */
  | { type: "prefetch"; seg: Segment; line: number; col: number; name: string }
  /** 调用接到已有的卡上：算变量候选（回 Var[]） */
  | { type: "callVars"; req: number; seg: Segment; line: number; col: number; name: string; target: Segment }
  | { type: "peek"; req: number; seg: Segment; line: number; col: number; word: string; at?: { path: string; line: number; col: number } } // 回 PeekResult
  | { type: "search"; req: number; q: string; scope?: "all" | "code" | "symbols" }
  | { type: "searchPick"; req: number; item: SearchItem; alt?: boolean }
  | { type: "entryPoints"; req: number }
  | { type: "diff"; req: number; seg: Segment; against?: string } // against 缺省 = HEAD
  | { type: "commits"; req: number; seg: Segment }
  | { type: "switchCommit"; req: number; seg: Segment; commit: string } // 回 { seg, view }
  | { type: "resolveRef"; req: number; text: string } // 手输 commit / branch / tag
  | { type: "paste"; req: number; text: string } // 回 NewCard | null（工作区代码、GitHub 链接）
  | { type: "github"; req: number; url: string }
  | { type: "gh"; req: number; q: GhQuery }
  | { type: "saveAsset"; req: number; name: string; dataUrl: string }
  | { type: "exportPng"; dataUrl: string; name: string }
  | { type: "views"; req: number; segs: Segment[] } // 白板生成的新段（合并、拆开）要展示数据
  | { type: "checkVersions" }
  | { type: "relocate"; card: string } // 符号找不到：在编辑器里选新位置
  | { type: "locateRepo" }
  /** 改一项全局设置（宿主写进 codeboard.*，再广播给所有白板） */
  | { type: "setSetting"; key: keyof Settings; value: unknown }
  /** 网页元信息：抓一次，图片存进 assets/ */
  | { type: "webMeta"; req: number; url: string } // 回 WebMeta
  | { type: "stickerPacks"; req: number } // 回 StickerPack[]
  | { type: "openStickerDir" }
  | { type: "copyDiagnostics"; board?: boolean }
  /** 白板里的错误 / 日志：写进 Output 面板的 CodeBoard 频道，Copy Diagnostics 会带上 */
  | { type: "log"; level: "info" | "warn" | "error"; text: string }
  | { type: "openBoard"; id: string; card?: string; line?: number }
  /** ⌘C 复制了这些卡（text = 写进剪贴板的文字）：宿主记下来，贴到别的白板时用 */
  | { type: "copyCards"; cards: string[]; text: string }
  /** 粘贴：剪贴板里是别的白板上复制的卡就回 PastedCards（text 对不上、同一块白板回 null）；copy = 独立副本 */
  | { type: "pasteCards"; req: number; text?: string; copy?: boolean }
  /** 共享卡 Delete Everywhere：从所有白板上删掉（回删了它的白板数） */
  | { type: "deleteEverywhere"; req: number; card: string }
  | { type: "confirm"; req: number; text: string; detail?: string; ok: string }
  /** 子白板的骨架（白板上出现了还没有骨架的框时要；null = 那块白板没了） */
  | { type: "skeletons"; req: number; ids: string[] }
  /** Turn into Board：选中的卡拆出来的新白板（id 白板定），存到父白板所在的组；共享卡还是共享卡。回 ok */
  | { type: "newBoard"; req: number; board: Board }
  /** 双击子白板框：在这个面板里打开子白板（frame = 框的卡 id，cam = 父白板回来时的镜头）；walk.start = 接着讲解 */
  | { type: "enterBoard"; id: string; frame: string; cam: Camera; walk?: WalkHop }
  /** 面包屑 / Esc：回到第 depth 层父白板（0 = 最外层；缺省 = 上一级）；walk.back = 父白板接着讲解 */
  | { type: "leaveBoard"; depth?: number; walk?: WalkHop }
  /** 子白板框的 Delete Board…：删掉那块白板（放进 .trash；先问）。回删没删 */
  | { type: "deleteBoard"; req: number; id: string }
  | { type: "pickFile"; req: number; kind: "image" }
  /** 解析不到的调用：按名字在所有语言里找（定义 + 字符串注册），回 NameHit[] */
  | { type: "searchName"; req: number; name: string }
  /** Generated 卡的内容：剪贴板或选一个文件（回 GenSource；取消回 null） */
  | { type: "genSource"; req: number; from: "clipboard" | "file" }
  /** Note 编辑时的灰字补全：光标前后的文字，回接在光标处的一段（没有可用模型时回 null） */
  | { type: "complete"; req: number; before: string; after: string };

/** 贴过来的别的白板上的卡（views = 各段的展示数据） */
export type PastedCards = { from: string; shared: boolean; cards: CardCopy[]; views: Record<string, SegView> };

/** 指定展开哪个定义。rel = path 相对 seg 自己的来源根（类卡点成员；工作区外的文件也对），qual = 按符号找（钉的版本行号可能挪了） */
export type ExpandPick = { path: string; line: number; rel?: true; qual?: string };

/** peek 的回答：找不到是 null */
export type PeekResult = PeekDef | null;

/**
 * expand 的回答。card：建卡连线；mark = 跨边界时要并进 Call 标记的（边界、取值、备选），title = 模板实例名（dispatch<8, 768>）。
 * impls：动态分发，列出全部实现让人选（base = 静态类型的方法）。none：解析不到（name = 可以按名字跨语言搜）
 */
export type ExpandResult =
  | { card: CodeCard; views: Record<string, SegView>; vars: Var[]; w?: number; mark?: CrossMark; title?: string }
  | { pick: { label: string; detail: string; path: string; line: number }[] }
  | { impls: ImplPick[]; base: string }
  | { none: true; reason: string; name?: string };

/** 跨边界时宿主给的 Call 标记部分 */
export type CrossMark = Pick<CallMark, "bound" | "vals" | "alts" | "impls" | "ev">;
/** 动态分发的一个实现：qual / 路径 / 行；lib = 在 library 里（包名）；base = 基类自己的实现（不是抽象的） */
export type ImplPick = { label: string; detail: string; path: string; line: number; qual: string; lib?: string; base?: true };
/** 跨语言按名字搜到的一处：lang = py / cpp / cuda / rust；def = 定义，否则是字符串注册（"name"） */
export type NameHit = { lang: string; label: string; detail: string; path: string; line: number; def: boolean; qual?: string };
/** Generated 卡的来源：文本、语言、文件名（剪贴板为空串） */
export type GenSource = { text: string; lang: string; name: string };
export type { BoundVal, CallAlt };

/** 要回答的请求（带 req）：白板用 ask 发，宿主用 { type: "reply", req, data } 回 */
export type AskType = Extract<BoardToHost, { req: number }>["type"];

/** 请求 → 回答的类型表：白板的 ask 和宿主的回答两边都按它检查 */
type Replies = {
  patch: { skipped: number };
  expand: ExpandResult;
  callVars: Var[];
  peek: PeekResult;
  search: SearchItem[];
  searchPick: NewCard | null;
  entryPoints: SearchItem[];
  diff: DiffData;
  commits: Commit[];
  switchCommit: { seg: Segment; view: SegView };
  resolveRef: Commit | null;
  paste: NewCard | null;
  github: NewCard;
  gh: GhReplyOf<GhQuery["op"]>; // 按 q.op
  saveAsset: string; // assets/ 里的文件名
  views: Record<string, SegView>;
  webMeta: WebMeta;
  stickerPacks: StickerPack[];
  confirm: boolean;
  pickFile: string | null; // data URL
  searchName: NameHit[];
  genSource: GenSource | null;
  complete: string | null;
  pasteCards: PastedCards | null;
  deleteEverywhere: number;
  skeletons: Record<string, Skeleton | null>;
  newBoard: boolean;
  deleteBoard: boolean;
};
export type ReplyOf<T extends AskType> = Replies[T];
/** From GitHub… 的回答：按 GhQuery 的 op */
type GhReplies = { repo: GhRepo; commit: Commit; tree: GhTree; file: GhFile; card: NewCard };
export type GhReplyOf<O extends GhQuery["op"]> = GhReplies[O];
