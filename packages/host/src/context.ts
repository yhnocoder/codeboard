// One host's state: the Workspace it serves and everything it remembers about it (caches, indexes, background work,
// what it logged). startHost makes one and every part of the host gets it explicitly, so two hosts can run side by side
// in one process, and dispose() lets go of all of it.
// The parsers and the content-addressed analysis and highlighting caches stay per process (analysis.ts, views.ts):
// tree-sitter's runtime is loaded once per process, and a cache keyed by content gives every host the same answer.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Emitter, type Disposable, type Workspace } from "@codeboard/core";
import { langOfExt } from "@codeboard/analysis/langs";
import { DefCache } from "./defcache";
import { GitCache } from "./git";
import { Lsp } from "./lsp";
import { NameIndex } from "./nameindex";
import { Prefetch } from "./prefetch";
import { ScratchFiles } from "./scratchfiles";
import { Scheduler } from "./sched";
import { Sources } from "./source";
import { OpIndex } from "./torchops";
import { Lru, notProject, posix } from "./ws";

export type LogLevel = "info" | "warn" | "error";
/** Lines of the log kept for Copy Diagnostics */
const LOG_LINES = 200;
/** Files read lately, for lookups that do not scan the workspace */
const RECENT_FILES = 80;

export class HostContext implements Disposable {
  readonly sched = new Scheduler();
  readonly git = new GitCache();
  readonly defs = new DefCache(this);
  readonly lsp = new Lsp(this);
  readonly index = new NameIndex(this);
  readonly ops = new OpIndex(this);
  readonly prefetch = new Prefetch(this);
  readonly sources = new Sources(this);
  /** Top-level package names and whether they are in the workspace (scope.ts) */
  readonly wsPkgs = new Map<string, Promise<boolean>>();
  /** Settings the board changed that are still being written (settings.ts) */
  readonly settingWrites = new Map<string, { v: unknown }>();
  /** The board's media folder (CSS, fonts), inlined into exported HTML (exports.ts) */
  readonly mediaDir: string;
  /** A repository's origin URL (exports.ts) */
  readonly remotes = new Map<string, Promise<string | undefined>>();
  /** Endpoints and models that turned DeepSeek's FIM completion down (deepseek.ts) */
  readonly noFim = new Set<string>();
  /** Text read from images, by image and model (imageai.ts) */
  readonly imageText = new Map<string, string>();
  /** A GitHub file was opened (github.ts) */
  readonly githubOpened = new Emitter<void>();
  /** Recording opened GitHub files one after another (github.ts) */
  githubRecording: Promise<void> = Promise.resolve();
  /** Edited code's hidden documents for the language service (codeedit.ts) */
  readonly codeDocs = new Map<string, { lang: string; near?: string; text: string; chain: Promise<unknown> }>();
  readonly codeGen = new Map<string, number>();
  /** The hidden files behind code being edited on a board */
  readonly scratch = new ScratchFiles(this);

  private recent = new Lru<true>(RECENT_FILES);
  private logs: string[] = [];

  constructor(
    readonly ws: Workspace,
    o: { mediaDir?: string } = {},
  ) {
    this.mediaDir = o.mediaDir ?? path.resolve(__dirname, "../media/board");
  }

  dispose() {
    this.index.dispose();
    this.prefetch.dispose();
    this.ops.dispose();
    this.githubOpened.dispose();
    this.scratch.dispose();
  }

  log = (level: LogLevel, text: string) => {
    this.ws.log(level, text);
    this.logs.push(`${new Date().toISOString()} [${level}] ${text}`);
    if (this.logs.length > LOG_LINES) this.logs.shift();
  };
  recentLog = () => this.logs.slice();

  roots = () => this.ws.files.roots();
  /** 第一个工作区根：Source.repo 相对它 */
  root0 = () => this.roots()[0] ?? "";
  /** 设置里写的文件夹：~ 开头的在主目录下，相对路径相对第一个工作区根（没有工作区时相对主目录） */
  settingDir = (p: string) => path.resolve(this.root0() || os.homedir(), p.replace(/^~(?=$|[\\/])/, os.homedir()));
  /** 显示 / 往返用的路径：在第一个根下面就写相对路径，否则写绝对路径 */
  hostPath = (abs: string): string => {
    const r = this.root0() ? path.relative(this.root0(), abs) : abs;
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? posix(r) : abs;
  };
  fromHostPath = (p: string) => (path.isAbsolute(p) ? p : path.resolve(this.root0(), p));
  inWorkspace = (abs: string) =>
    this.roots().some((f) => {
      const r = path.relative(f, abs);
      return !r.startsWith("..") && !path.isAbsolute(r);
    });
  /** 在 CODE_EXCLUDE 排除的目录里：和 findFiles 一样只看工作区根下面的那段（打开的文件夹本身在 site-packages、build 里不算） */
  inExcludedDir = (abs: string) => {
    const root = this.ws.files.rootOf(abs);
    return notProject(path.sep + (root ? path.relative(root, abs) : abs));
  };

  /** 文件当前内容：编辑器里有未保存的改动就用编辑器的，否则读磁盘（文件删了 = null，哪怕编辑器里还开着）。track = 记进最近读过的文件 */
  readText = async (abs: string, track = true): Promise<string | null> => {
    if (track) this.recent.set(abs, true);
    const unsaved = this.ws.files.unsavedText(abs);
    if (unsaved !== undefined) return unsaved;
    try {
      return await fs.readFile(abs, "utf8");
    } catch {
      return null;
    }
  };
  /** 最近读过的文件（不扫工作区的兜底查找用） */
  recentFiles = (): string[] => this.recent.keys();

  langOf = (file: string): string => {
    const open = this.ws.files.openLanguage(file);
    if (open && open !== "plaintext") return open;
    return langOfExt(file)?.id ?? "plaintext";
  };
}
