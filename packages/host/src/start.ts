// 宿主的组合根：给一个 Workspace 和 HostEnv，接好存储、白板协调、分析、索引、版本检查和它们之间的事件。
// 编辑器的壳（VS Code 插件、以后的 Node sidecar）只调这一个函数，再把自己的界面（侧栏、CodeLens、状态栏）挂到返回的事件上
import type { Disposable, Event, Workspace } from "@codeboard/core";
import { HOST_SETTINGS } from "@codeboard/core/settings";
import type { Storage } from "./storage/boards";
import { makeActions } from "./actions";
import { startAnalysis } from "./analysis";
import { scheduleAssetSweep } from "./assetsweep";
import type { HostEnv } from "./env";
import { allQuestions } from "./exports";
import { workspaceGithubFiles } from "./github";
import { makeHandler } from "./handlers";
import { BoardHub } from "./hub";
import { affectsSettings, readSettings } from "./settings";
import { BoardPlace, githubDir, watchProjectDir } from "./storage/place";
import { recordProject } from "./transfer";
import { watchVersions } from "./watch";
import { HostContext } from "./context";
import { BoardMarks } from "./marks";
import type { BoxOptions } from "./meaning";

export type HostOptions = {
  /** 放 tree-sitter wasm 的目录；不给 = 从 npm 包里找（Node 下） */
  wasmDir?: string;
  /** 白板页面的资源目录（导出 HTML 时内联字体和图标） */
  mediaDir: string;
  /** The built thumbnail worker (src/thumbs/worker.ts): the smaller copies of big images are made in it. None: in the host's
   *  own thread (tests and the harness, which run the TypeScript sources) */
  thumbWorker?: string;
  /** The box binary behind Related by Meaning (packages/box; the extension bundles one per platform). None, or no file
   *  there: Related by Meaning is off and says why */
  box?: BoxOptions;
};

export type Host = Disposable & {
  hub: BoardHub;
  store: Storage;
  /** 命令 id → 做什么 */
  actions: ReturnType<typeof makeActions>;
  /** tree-sitter 准备好、版本检查开始之后 */
  ready: Promise<void>;
  /** 存储目录换了（设置、.codeboard/ 出现或没了、Move Boards into Project） */
  onDidSwitchStorage: Event<Storage>;
  /** 打开过一个 GitHub 文件（下载缓存里多了一个） */
  onDidOpenGithubFile: Event<void>;
  /** 把没写盘的白板改动写完（退出时） */
  flush(): Promise<void>;
  /** A file at a commit (git show), for the editor's read-only version documents */
  showFile(root: string, commit: string, rel: string): Promise<string | null>;
  /** Where boards have code in the workspace's files (CodeLens, line marks) */
  marks: BoardMarks;
  /** GitHub files this workspace opened or has on its boards (sidebar) */
  githubFiles(): ReturnType<typeof workspaceGithubFiles>;
  /** The questions on all boards (sidebar) */
  questions(): ReturnType<typeof allQuestions>;
};

export function startHost(ws: Workspace, env: HostEnv, o: HostOptions): Host {
  const cx = new HostContext(ws, { thumbWorker: o.thumbWorker, box: o.box });
  const subs: Disposable[] = [cx];
  const on = (d: Disposable) => void subs.push(d);
  const analysis = startAnalysis(o.wasmDir);
  const place = new BoardPlace(cx);
  const store = place.store;
  on(place);
  cx.sources.init(githubDir(cx));
  const hub = new BoardHub(cx, env, store, (h) => makeHandler(cx, h, o.mediaDir));
  on(hub);

  // 跨工作区记下这个项目的存储目录：别的窗口的 Copy / Move to Another Project… 在里面找
  const record = () => void recordProject(cx, hub.globalState, store.dir());
  record();
  let unsweep = scheduleAssetSweep(cx, store);
  on({ dispose: () => unsweep() });
  on(
    place.onDidSwitch(() => {
      void hub.followStorage();
      unsweep();
      unsweep = scheduleAssetSweep(cx, store);
      record();
    }),
  );
  const follow = () => void place.follow();
  on(watchProjectDir(cx, follow));
  on(ws.files.onDidChangeRoots(follow));

  on(store.onDidChange(() => void hub.pushBoards()));
  // SVG pictures reach the embedding model as pixels an open board draws
  cx.meaning.drawWith((u) => hub.draw(u));
  on(store.onDidChange(() => cx.meaning.soon(store)));
  cx.meaning.soon(store);
  on(hub.onDidChangeStale(() => void hub.pushBoards()));

  // 代码变了：记下的定义跳转结果作废
  const files = ws.files;
  on(
    files.onDidEdit((abs) => {
      if (abs) cx.defs.forget();
    }),
  );
  on(
    files.onDidSave((abs) => {
      if (abs) cx.defs.forget();
    }),
  );
  on(files.onDidCreate(() => cx.defs.forget()));
  on(files.onDidDelete(() => cx.defs.forget()));
  on(files.onDidRename(() => cx.defs.forget()));
  on(cx.index.watch());

  on(
    ws.settings.onDidChange((e) => {
      if (e.affects(`codeboard.${HOST_SETTINGS.storageDir.key}`)) follow();
      if (e.affects("codeboard.search")) cx.meaning.soon(store);
      if (e.affects("codeboard.search.rerank")) cx.meaning.rerankChanged();
      if (affectsSettings(e)) hub.broadcast({ type: "host", host: { settings: readSettings(cx) } });
      if (e.affects("editor.fontFamily"))
        hub.broadcast({ type: "host", host: { fontFamily: ws.settings.get<string>("editor.fontFamily") } });
    }),
  );

  let disposed = false;
  const ready = analysis.then(() => {
    if (!disposed) on(watchVersions(cx, hub, store));
  });

  return {
    hub,
    store,
    ready,
    actions: makeActions(cx, hub, store, () => place.follow()),
    onDidSwitchStorage: place.onDidSwitch,
    onDidOpenGithubFile: cx.githubFiles.onDidOpen,
    flush: () => store.flush(),
    showFile: cx.git.showFile,
    marks: new BoardMarks(cx),
    githubFiles: () => workspaceGithubFiles(cx, store),
    questions: () => allQuestions(store),
    dispose() {
      disposed = true;
      for (const d of subs.splice(0).reverse()) d.dispose();
    },
  };
}
