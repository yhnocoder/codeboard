// 宿主的组合根：给一个 Workspace 和 HostEnv，接好存储、白板协调、分析、索引、版本检查和它们之间的事件。
// 编辑器的壳（VS Code 插件、以后的 Node sidecar）只调这一个函数，再把自己的界面（侧栏、CodeLens、状态栏）挂到返回的事件上
import type { Disposable, Event, Workspace } from "@codeboard/core";
import type { Storage } from "@codeboard/core/storage";
import { makeActions } from "./actions";
import { startAnalysis } from "./analysis";
import { scheduleAssetSweep } from "./assetsweep";
import { forgetDefs } from "./defcache";
import type { HostEnv } from "./env";
import { setMediaDir } from "./exports";
import { onDidOpenGithubFile } from "./github";
import { makeHandler } from "./handlers";
import { BoardHub } from "./hub";
import { watchNameIndex } from "./nameindex";
import { affectsSettings, readSettings } from "./settings";
import { initSource } from "./source";
import { followStorageDir, githubDir, onDidSwitchStorage, openStorage, watchProjectDir } from "./storage";
import { recordProject } from "./transfer";
import { watchVersions } from "./watch";
import { useWorkspace } from "./ws";

export type HostOptions = {
  /** 放 tree-sitter wasm 的目录；不给 = 从 npm 包里找（Node 下） */
  wasmDir?: string;
  /** 白板页面的资源目录（导出 HTML 时内联字体和图标） */
  mediaDir?: string;
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
};

export function startHost(ws: Workspace, env: HostEnv, o: HostOptions = {}): Host {
  useWorkspace(ws);
  const subs: Disposable[] = [];
  const on = (d: Disposable) => void subs.push(d);
  const analysis = startAnalysis(o.wasmDir);
  if (o.mediaDir) setMediaDir(o.mediaDir);
  const store = openStorage();
  on(store);
  initSource(githubDir());
  const hub = new BoardHub(env, store);
  on(hub);
  hub.handler = makeHandler(hub);

  // 跨工作区记下这个项目的存储目录：别的窗口的 Copy / Move to Another Project… 在里面找
  const record = () => void recordProject(hub.globalState, store.dir());
  record();
  let unsweep = scheduleAssetSweep(store);
  on({ dispose: () => unsweep() });
  on(
    onDidSwitchStorage(() => {
      void hub.followStorage();
      unsweep();
      unsweep = scheduleAssetSweep(store);
      record();
    }),
  );
  const follow = () => void followStorageDir(store);
  on(watchProjectDir(follow));
  on(ws.files.onDidChangeRoots(follow));

  on(store.onDidChange(() => void hub.pushBoards()));
  on(hub.onDidChangeStale(() => void hub.pushBoards()));

  // 代码变了：记下的定义跳转结果作废
  const files = ws.files;
  on(
    files.onDidEdit((abs) => {
      if (abs) forgetDefs();
    }),
  );
  on(
    files.onDidSave((abs) => {
      if (abs) forgetDefs();
    }),
  );
  on(files.onDidCreate(() => forgetDefs()));
  on(files.onDidDelete(() => forgetDefs()));
  on(files.onDidRename(() => forgetDefs()));
  on(watchNameIndex());

  on(
    ws.settings.onDidChange((e) => {
      if (e.affects("codeboard.storageDir")) follow();
      if (affectsSettings(e)) hub.broadcast({ type: "host", host: { settings: readSettings() } });
      if (e.affects("editor.fontFamily"))
        hub.broadcast({ type: "host", host: { fontFamily: ws.settings.get<string>("editor.fontFamily") } });
    }),
  );

  let disposed = false;
  const ready = analysis.then(() => {
    if (!disposed) on(watchVersions(hub, store));
  });

  return {
    hub,
    store,
    ready,
    actions: makeActions(hub, store),
    onDidSwitchStorage,
    onDidOpenGithubFile,
    flush: () => store.flush(),
    dispose() {
      disposed = true;
      for (const d of subs.splice(0).reverse()) d.dispose();
    },
  };
}
