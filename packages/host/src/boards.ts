// 一块打开的白板：读白板、算段的展示数据和版本状态、发 init；宿主信息；版本状态重算。
// 白板状态由界面持有，改动后把变了的项发回来保存（patch，存储改它缓存的那份再写盘）。界面本身（BoardView）由编辑器适配层实现
//（VS Code 里是 webview，见 env.ts 的 openView），所有打开的白板由 hub.ts 的 BoardHub 管（BoardHost）。
import { boardQuestions, type Board, type BoardMeta, type BoardToHost, type Camera, type Crumb, type Event, type HostInfo, type HostToBoard, type Segment, type Settings, type Skeleton, type Stale, type WalkHop } from "@codeboard/core";
import type { CardClip, Storage } from "@codeboard/core/storage";
import { boardSegments, countStale, staleFor, staleSegments, variantSegments } from "./versions";
import { syncVariants } from "./variants";
import { viewsFor } from "./views";
import { absOf, present, srcLabel } from "./source";
import { readSettings } from "./settings";
import { warmBoard } from "./prefetch";
import { startNameIndex } from "./nameindex";
import { workspace } from "./ws";
import type { ViewPlace } from "./env";

/** 宿主转发的 ⌘ / Ctrl 键（webview 里不自己处理）：与 package.json 里 codeboard.boardKey 的键一致（"+" 是 "=" 那个键按了 Shift）；board 的 lists.test.ts 会核对 */
export const FORWARDED_KEYS = ["k", "d", "0", "1", "=", "+", "-", "shift+l", "shift+b", ","];

/** 白板的界面（VS Code 里是一个 webview 标签页） */
export interface BoardView {
  /** 直接发给界面（不排队） */
  postMessage(m: HostToBoard): void;
  title: string;
  readonly visible: boolean;
  readonly active: boolean;
  reveal(preserveFocus?: boolean): void;
  dispose(): void;
  /** 本机目录在界面里的地址（图片卡的 assets/） */
  resourceUrl(dir: string): string;
  /** 界面发来的消息 */
  onMessage: Event<BoardToHost>;
  /** 成了当前的标签页 */
  onDidActivate: Event<void>;
  /** 关掉了 */
  onDidDispose: Event<void>;
}

/** 所有打开的白板（面板管理器） */
export interface BoardHost {
  readonly store: Storage;
  /** 编辑器里 Add to 的目标白板 */
  readonly target: string | undefined;
  get(id: string): BoardPanel | undefined;
  all(): BoardPanel[];
  metas(): Promise<BoardMeta[]>;
  show(id: string, opts?: ViewPlace): Promise<BoardPanel | undefined>;
  setTarget(id: string | undefined): void;
  broadcast(m: HostToBoard): void;
  pushBoards(): Promise<void>;
  staleChanged(id: string, n: number): void;
  /** 重算开着的白板的版本状态；paths = 只重查这些文件（绝对路径）里的段，只在有这些文件的白板上 */
  refreshStale(paths?: ReadonlySet<string>): Promise<void>;
  /** ⌘C 复制的卡（贴到别的白板时用） */
  clip: CardClip | undefined;
  /** 共享卡的情况（在几块白板上、谁连到它）重新推给白板；now = 不等防抖 */
  refreshShared(now?: boolean, fresh?: string): void;
  /** 面板换一块白板显示（进入 / 离开子白板） */
  /** 子白板的骨架重新推给白板（变了的）；now = 不等防抖，fresh = 刚 init 的白板 */
  refreshSkeletons(now?: boolean, fresh?: string): void;
  /** 一块白板的骨架（没了 = null） */
  skeleton(id: string): Skeleton | null;
  switchBoard(p: BoardPanel, to: string, o: { crumbs: Crumb[]; cams: Camera[]; walk?: WalkHop; cam?: Camera }): Promise<boolean>;
  /** 每块白板上次打开的时间（「回来接上」的提示用）；opened 记下这一次 */
  lastOpened?(id: string): number | undefined;
  opened?(id: string): void;
}

const DAY = 864e5;
/** 「回来接上」（线框 06）：设置 welcomeBack 允许、隔得够久、这块白板上还有没解决的问题时才提示 */
export function welcomeOf(b: Board, last: number | undefined, mode: Settings["welcomeBack"], now = Date.now()): { days: number; open: number } | undefined {
  if (mode === "off" || last === undefined) return undefined;
  const days = Math.floor((now - last) / DAY);
  if (mode !== "always" && now - last < 2 * DAY) return undefined;
  const open = boardQuestions(b).filter((q) => !q.done).length;
  return open ? { days, open } : undefined;
}

const INDEX_DELAY = 4000;

const inPaths = (s: Segment, paths: ReadonlySet<string>) => { const a = absOf(s); return !!a && paths.has(a); };

export class BoardPanel {
  board: Board | undefined;
  ready = false;
  private queue: HostToBoard[] = [];
  /** 白板上选中的卡和行（Add to Selected Card、⌥S 用） */
  selection: Extract<BoardToHost, { type: "selection" }> | undefined;
  stale: Record<string, Stale> = {};
  readonly: string | undefined;
  /** 子白板的面包屑（从最外层到上一级）和每一级离开时的镜头；顶层白板是空的 */
  crumbs: Crumb[] = [];
  cams: Camera[] = [];
  /** 下一次 init 要带上的：接着讲解、换掉存着的镜头（回到父白板时） */
  next: { walk?: WalkHop; cam?: Camera } = {};

  /** id 会变：进入子白板时同一个面板换成那块白板（BoardHub.switchBoard） */
  constructor(public id: string, readonly view: BoardView, private mgr: BoardHost) {}

  get visible() { return this.view.visible; }

  post(m: HostToBoard) {
    if (this.ready) this.view.postMessage(m);
    else if (m.type !== "init") this.queue.push(m);
  }
  toast(text: string) { this.post({ type: "toast", text }); }

  /** webview 说 ready：读白板、算所有段的展示数据和版本状态，发 init */
  async init() {
    const b = await this.mgr.store.load(this.id);
    if (!b) { this.view.dispose(); return; }
    const next = this.next;
    this.next = {};
    if (next.cam) b.cam = next.cam;
    this.board = b;
    this.view.title = b.name;
    const segs = boardSegments(b);
    const ss = staleSegments(b);
    const [views, stale, boards] = await Promise.all([viewsFor([...segs, ...variantSegments(b)]), staleFor(ss.segs, ss.up), this.mgr.metas()]);
    this.stale = stale;
    this.readonly = await this.readonlyNote(b);
    const host = this.host();
    const init: HostToBoard = { type: "init", board: b, boards, views, stale, host };
    if (this.crumbs.length) init.crumbs = this.crumbs;
    // 进出子白板不算「回来」
    if (!this.crumbs.length && !next.walk) { const w = welcomeOf(b, this.mgr.lastOpened?.(b.id), host.settings.welcomeBack); if (w) init.welcome = w; }
    this.mgr.opened?.(b.id);
    if (next.walk) init.walk = next.walk;
    this.view.postMessage(init);
    this.ready = true;
    const q = this.queue;
    this.queue = [];
    for (const m of q) this.view.postMessage(m);
    this.mgr.refreshShared(true, this.id);
    this.mgr.refreshSkeletons(true, this.id);
    this.mgr.staleChanged(this.id, countStale(b, stale));
    this.variantSent.clear();
    void this.refreshVariants(true);
    // 白板已经出来了：后台让语言服务先热起来
    warmBoard(segs, () => this.mgr.get(this.id) === this);
    // 名字索引也在后台建（语言服务给不出定义时用），等白板和预热先跑一会儿
    startNameIndex(INDEX_DELAY);
  }

  host(): HostInfo {
    return {
      fontFamily: workspace().settings.get<string>("editor.fontFamily"),
      isMac: process.platform === "darwin",
      forwardedKeys: FORWARDED_KEYS,
      assetBase: this.view.resourceUrl(this.mgr.store.assetsDir()),
      readonly: this.readonly,
      settings: readSettings(),
      target: this.mgr.target === this.id,
      complete: !!workspace().ai,
      clip: this.mgr.clip && { board: this.mgr.clip.board, n: this.mgr.clip.cards.length },
    };
  }

  /** 仓库找不到时的提示（只读快照） */
  private async readonlyNote(b: Board): Promise<string | undefined> {
    const miss = new Set<string>();
    for (const s of boardSegments(b)) if (s.src.kind !== "free" && s.src.kind !== "github" && !(await present(s))) miss.add(srcLabel(s.src));
    if (!miss.size) return undefined;
    const names = [...miss].map((n) => `“${n}”`).join(", ");
    return `Repo ${names} not found in this workspace. Showing saved code, read-only.`;
  }

  /** 有 Variant 的卡：每张卡上次发过的状态（只发变了的） */
  private variantSent = new Map<string, string>();
  /** 刷新 Variant（保存、HEAD 变了、打开白板）；net = 也问 GitHub（PR 的 head、合没合），只在打开白板时 */
  async refreshVariants(net = false) {
    if (!this.board || !this.ready) return;
    try {
      const cards = await syncVariants(this.board, this.variantSent, { net });
      if (Object.keys(cards).length) this.post({ type: "variants", cards });
    } catch (e) { workspace().log("warn", `variants: ${e instanceof Error ? e.message : e}`); }
  }

  /** 白板上（含不在显示的 Variant）有没有这些文件里的段 */
  holds(paths: ReadonlySet<string>): boolean {
    return !!this.board && [...boardSegments(this.board), ...variantSegments(this.board)].some((s) => inPaths(s, paths));
  }

  /** 重算版本状态并推给白板；paths = 只重查这些文件里的段（别的段留着上次的结果） */
  async refreshStale(paths?: ReadonlySet<string>) {
    if (!this.board || !this.ready) return;
    void this.refreshVariants();
    const ss = staleSegments(this.board);
    const fresh = await staleFor(paths ? ss.segs.filter((s) => inPaths(s, paths)) : ss.segs, ss.up);
    let st = fresh;
    if (paths) {
      st = {};
      for (const s of ss.segs) { const v = fresh[s.id] ?? this.stale[s.id]; if (v) st[s.id] = v; }
    }
    const changed = JSON.stringify(st) !== JSON.stringify(this.stale);
    this.stale = st;
    if (changed) this.post({ type: "stale", stale: st });
    this.mgr.staleChanged(this.id, countStale(this.board, st));
  }

  /** Locate Repo 之后：重新读代码、只读提示 */
  async reload() {
    if (!this.board) return;
    const segs = boardSegments(this.board);
    this.readonly = await this.readonlyNote(this.board);
    this.post({ type: "views", views: await viewsFor([...segs, ...variantSegments(this.board)]) });
    this.post({ type: "host", host: { readonly: this.readonly } });
    await this.refreshStale();
  }
}
