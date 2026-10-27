// 白板状态由界面持有，改动后把变了的项发回来保存（patch，存储改它缓存的那份再写盘）。
import { boardQuestions, type Board, type BoardAsk, type BoardMeta, type BoardToHost, type Camera, type Crumb, type Event, type HostInfo, type HostToBoard, type Segment, type Settings, type Skeleton, type Stale, type WalkHop } from "@codeboard/core";
import type { CardClip, Storage } from "@codeboard/core/storage";
import { boardSegments, countStale, staleFor, staleSegments, variantSegments } from "./versions";
import { syncVariants } from "./variants";
import { viewsFor } from "./views";
import { absOf, present, srcLabel } from "./source";
import { readSettings } from "./settings";
import { warmBoard } from "./prefetch";
import { startNameIndex } from "./nameindex";
import { workspace } from "./ws";
import type { StateStore, ViewPlace } from "./env";

/** 宿主转发的 ⌘ / Ctrl 键（webview 里不自己处理）：与 package.json 里 codeboard.boardKey 的键一致（"+" 是 "=" 那个键按了 Shift）；board 的 lists.test.ts 会核对 */
export const FORWARDED_KEYS = ["k", "d", "0", "1", "=", "+", "-", "shift+l", "shift+b", ","];

export interface BoardView {
  /** 直接发给界面（不排队） */
  postMessage(m: HostToBoard): void;
  title: string;
  readonly visible: boolean;
  readonly active: boolean;
  reveal(preserveFocus?: boolean): void;
  /** Give the active board the keyboard; resolves once the editor has started to (the keyboard reaches the board's frame a moment
   *  later), where reveal resolves nothing */
  focus(): Promise<void>;
  dispose(): void;
  /** 本机目录在界面里的地址（图片卡的 assets/） */
  resourceUrl(dir: string): string;
  onMessage: Event<BoardToHost>;
  onDidActivate: Event<void>;
  onDidDispose: Event<void>;
}

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
  /** 子白板的骨架重新推给白板（变了的）；now = 不等防抖，fresh = 刚 init 的白板 */
  refreshSkeletons(now?: boolean, fresh?: string): void;
  skeleton(id: string): Skeleton | null;
  /** 面板换一块白板显示（进入 / 离开子白板） */
  switchBoard(p: BoardPanel, to: string, o: { crumbs: Crumb[]; cams: Camera[]; walk?: WalkHop; cam?: Camera }): Promise<boolean>;
  /** 每块白板上次打开的时间（「回来接上」的提示用）；opened 记下这一次 */
  lastOpened?(id: string): number | undefined;
  opened?(id: string): void;
  /** 这个工作区第一次 Add to Board：返回 true 并记下，之后都是 false */
  firstAdd?(): boolean;
  /** 跨工作区的状态（HostEnv.globalState）：Copy / Move to Another Project… 在里面找别的项目 */
  readonly globalState?: StateStore;
  /** The board's "focus" message */
  boardFocus(p: BoardPanel, has: boolean): Promise<void>;
}

const DAY = 864e5;
/** 「回来接上」：设置 welcomeBack 允许、隔得够久、这块白板上还有没解决的问题时才提示 */
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

  /** What the board last said about the keyboard (its "focus" messages) */
  hasKeyboard = false;
  private asks = new Map<number, (v: string | number | null) => void>();
  private askN = 0;

  /** id 会变：进入子白板时同一个面板换成那块白板（BoardHub.switchBoard） */
  constructor(public id: string, readonly view: BoardView, private mgr: BoardHost) {}

  get visible() { return this.view.visible; }

  post(m: HostToBoard) {
    if (this.ready) this.view.postMessage(m);
    else if (m.type !== "init") this.queue.push(m);
  }
  toast(text: string) { this.post({ type: "toast", text }); }

  /** Ask in a board dialog (HostToBoard "ask"); null when cancelled, or when the board closes or reloads first */
  ask(a: BoardAsk): Promise<string | number | null> {
    const id = ++this.askN;
    return new Promise((r) => { this.asks.set(id, r); this.post({ type: "ask", id, ask: a }); });
  }
  answer(id: number, v: string | number | null) { this.asks.get(id)?.(v); this.asks.delete(id); }
  dropAsks() { for (const r of this.asks.values()) r(null); this.asks.clear(); }

  /** webview 说 ready：读白板、算所有段的展示数据和版本状态，发 init */
  async init() {
    this.dropAsks(); // a reloaded webview has no dialogs open
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

  holds(paths: ReadonlySet<string>): boolean {
    return !!this.board && [...boardSegments(this.board), ...variantSegments(this.board)].some((s) => inPaths(s, paths));
  }

  /** 重算版本状态并推给白板；paths = 只重查这些文件里的段（别的段留着上次的结果） */
  refreshStale(paths?: ReadonlySet<string>): Promise<void> {
    // One at a time: a check started before a commit can end after the one the commit started, and the older result would stay
    const run = this.staleRun.then(() => this.checkStale(paths));
    this.staleRun = run.catch(() => undefined);
    return run;
  }
  private staleRun: Promise<void> = Promise.resolve();
  private async checkStale(paths?: ReadonlySet<string>) {
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
