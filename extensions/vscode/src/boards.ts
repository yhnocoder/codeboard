// 一块打开的白板（与 VS Code 无关的部分）：读白板、算段的展示数据和版本状态、发 init；宿主信息；版本状态重算。
// 白板状态由 webview 持有，每次改动整板发回来保存。webview 本身（BoardView）和面板管理（BoardHost）由 VS Code 适配层实现。
import type { Board, BoardMeta, BoardToHost, HostInfo, HostToBoard, Stale } from "@codeboard/core";
import type { Storage } from "@codeboard/core/storage";
import { boardSegments, countStale, staleFor } from "./versions";
import { viewsFor } from "./views";
import { present, srcLabel } from "./source";
import { readSettings } from "./settings";
import { warmBoard } from "./prefetch";
import { startNameIndex } from "./nameindex";
import { workspace } from "./ws";

/** 宿主转发的 ⌘ / Ctrl 键（webview 里不自己处理）：与 package.json 里 codeboard.boardKey 的键一致（"+" 是 "=" 那个键按了 Shift）；board 的 lists.test.ts 会核对 */
export const FORWARDED_KEYS = ["k", "d", "0", "1", "=", "+", "-", "shift+l", ","];

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
}

/** 所有打开的白板（面板管理器） */
export interface BoardHost {
  readonly store: Storage;
  /** 编辑器里 Add to 的目标白板 */
  readonly target: string | undefined;
  get(id: string): BoardPanel | undefined;
  all(): BoardPanel[];
  metas(): Promise<BoardMeta[]>;
  show(id: string, opts?: { preserveFocus?: boolean; side?: boolean; here?: boolean }): Promise<BoardPanel | undefined>;
  setTarget(id: string | undefined): void;
  broadcast(m: HostToBoard): void;
  pushBoards(): Promise<void>;
  staleChanged(id: string, n: number): void;
  refreshStale(): Promise<void>;
}

const INDEX_DELAY = 4000;

export class BoardPanel {
  board: Board | undefined;
  ready = false;
  private queue: HostToBoard[] = [];
  /** 白板上选中的卡和行（Add to Selected Card、⌥S 用） */
  selection: Extract<BoardToHost, { type: "selection" }> | undefined;
  stale: Record<string, Stale> = {};
  readonly: string | undefined;

  constructor(readonly id: string, readonly view: BoardView, private mgr: BoardHost) {}

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
    this.board = b;
    this.view.title = b.name;
    const segs = boardSegments(b);
    const [views, stale, boards] = await Promise.all([viewsFor(segs), staleFor(segs), this.mgr.metas()]);
    this.stale = stale;
    this.readonly = await this.readonlyNote(b);
    this.view.postMessage({ type: "init", board: b, boards, views, stale, host: this.host() });
    this.ready = true;
    const q = this.queue;
    this.queue = [];
    for (const m of q) this.view.postMessage(m);
    this.mgr.staleChanged(this.id, countStale(b, stale));
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

  /** 重算版本状态并推给白板 */
  async refreshStale() {
    if (!this.board || !this.ready) return;
    const st = await staleFor(boardSegments(this.board));
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
    this.post({ type: "views", views: await viewsFor(segs) });
    this.post({ type: "host", host: { readonly: this.readonly } });
    await this.refreshStale();
  }
}
