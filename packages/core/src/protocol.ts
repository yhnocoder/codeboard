// 宿主 ↔ 白板的消息。白板持有白板状态，改动后整板发回来保存；宿主负责读代码、高亮、版本、跳转。
// 需要回答的请求带 req，宿主用 { type: "reply", req, … } 回。
import type { Board, BoardMeta, CodeCard, Segment, Card, Var, Version, HideFlags } from "./model";
import type { SegView } from "./lines";
import type { TidyDir } from "./layout";

/** 一段代码和当前代码的关系（「新版本」） */
export type Stale =
  | { state: "ok" }
  | { state: "moved"; start: number; end: number; version?: Version } // 只是挪了位置：白板静默跟上
  | { state: "changed"; hiddenOnly: boolean; head: string } // 黄点；hiddenOnly = 只有隐藏的行变了（空心点）
  | { state: "lost" } // 符号找不到（删了或改名）
  | { state: "many" } // 片段按内容找到多处
  | { state: "uncommitted" } // 钉在 HEAD，但工作区有未提交改动
  | { state: "missing" }; // 仓库 / 文件不在：只读快照

/** 8 种材质主题；明暗跟随 VS Code */
export const THEMES = [
  ["warm-ink", "Warm Ink"], ["graphite", "Graphite"], ["soft-light", "Soft Light"], ["drafting", "Drafting"],
  ["colorful", "Colorful"], ["newspaper", "Newspaper"], ["poster", "Poster"], ["classic", "Classic"],
] as const;
export type ThemeId = (typeof THEMES)[number][0];

/** 全局设置：同步成 VS Code 的 codeboard.* 设置，所有白板共用 */
export type Settings = {
  theme: ThemeId;
  hideOnNew: HideFlags; // 新卡默认隐藏什么（替代卡片上的 Hide 浮条）
  studyScope: string[]; // 除了工作区以外也算 project code 的包（torch、vllm…）
  tidy: TidyDir; // Tidy Layout 的默认方向；展开调用时新卡也按它摆
  stickerDir: string; // Sticker Packs 目录；"" = ~/.codeboard/stickers
  zoomOverview: number; // 低于这个比例：概览（代码变灰条）
  zoomMap: number; // 低于这个比例：地图（只剩编号和名字）
};
export const DEFAULT_SETTINGS: Settings = {
  theme: "warm-ink", hideOnNew: { blank: false }, studyScope: [], tidy: "down", stickerDir: "", zoomOverview: 0.6, zoomMap: 0.25,
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
};

/** 宿主替白板拦下的快捷键对应的动作（VS Code 会先吃掉 ⌘K ⌘D ⌘0 ⌘1 ⌘± ⌘⇧L） */
export type KeyAction = "search" | "duplicate" | "fitAll" | "zoom100" | "zoomIn" | "zoomOut" | "lock";

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

export type HostToBoard =
  | { type: "init"; board: Board; boards: BoardMeta[]; views: Record<string, SegView>; stale: Record<string, Stale>; host: HostInfo }
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
  | { type: "reply"; req: number; data?: unknown; error?: string };

export type BoardToHost =
  | { type: "ready" }
  | { type: "save"; board: Board }
  | { type: "selection"; cards: string[]; lines?: { card: string; seg: string; start: number; end: number } }
  /** Open in Editor：钉的 commit 不是当前代码时开只读版本 */
  | { type: "open"; card: string; seg?: string; line?: number }
  | { type: "openPath"; path: string; line?: number }
  | { type: "openLink"; url: string }
  /** 点调用展开：回 ExpandResult */
  | { type: "expand"; req: number; seg: Segment; line: number; col: number; name: string; recv?: string; pick?: ExpandPick }
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
  | { type: "openBoard"; id: string; card?: string }
  | { type: "confirm"; req: number; text: string; detail?: string; ok: string }
  | { type: "pickFile"; req: number; kind: "image" };

/** 指定展开哪个定义。rel = path 相对 seg 自己的来源根（类卡点成员；工作区外的文件也对），qual = 按符号找（钉的版本行号可能挪了） */
export type ExpandPick = { path: string; line: number; rel?: true; qual?: string };

/** peek 的回答：找不到是 null */
export type PeekResult = PeekDef | null;

/** expand 的回答 */
export type ExpandResult =
  | { card: CodeCard; views: Record<string, SegView>; vars: Var[]; w?: number }
  | { pick: { label: string; detail: string; path: string; line: number }[] }
  | { none: true; reason: string };
