// One host's state: the Workspace it serves and everything it remembers about it (caches, indexes, background work,
// what it logged). startHost makes one and every part of the host gets it explicitly, so two hosts can run side by side
// in one process, and dispose() lets go of all of it.
// Each feature keeps its own state in a class of its module; the context only holds one of each.
// The parsers and the content-addressed analysis and highlighting caches stay per process (analysis.ts, views.ts):
// tree-sitter's runtime is loaded once per process, and a cache keyed by content gives every host the same answer. The syntax
// trees kept for incremental parsing are keyed by file, so they are per host (trees).
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Disposable, Workspace } from "@codeboard/core";
import { TreeCache } from "@codeboard/analysis";
import { langOfExt } from "@codeboard/analysis/langs";
import { AiMemory } from "./ai";
import { CodeEdit } from "./codeedit";
import { DefCache } from "./defcache";
import { Remotes } from "./exports";
import { GitCache } from "./git";
import { OpenedGithubFiles } from "./github";
import { Lsp } from "./lsp";
import { MeaningSearch } from "./meaning";
import { NameIndex } from "./nameindex";
import { Prefetch } from "./prefetch";
import { ScratchFiles } from "./scratchfiles";
import { Scheduler } from "./sched";
import { WorkspacePkgs } from "./scope";
import { SettingWrites } from "./settings";
import { Sources } from "./source";
import { Thumbs } from "./thumbs";
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
  /** This host's syntax trees, kept by file for incremental parsing */
  readonly trees = new TreeCache();
  readonly defs = new DefCache(this);
  readonly lsp = new Lsp(this);
  readonly index = new NameIndex(this);
  readonly ops = new OpIndex(this);
  readonly prefetch = new Prefetch(this);
  readonly sources = new Sources(this);
  readonly pkgs = new WorkspacePkgs(this);
  readonly settingWrites = new SettingWrites();
  readonly remotes = new Remotes();
  readonly ai = new AiMemory();
  readonly githubFiles = new OpenedGithubFiles(this);
  readonly codeEdit = new CodeEdit(this);
  /** ⌘K's Related by Meaning: the project's semantic index */
  readonly meaning = new MeaningSearch(this);
  /** The hidden files behind code being edited on a board */
  readonly scratch = new ScratchFiles(this);
  /** Smaller copies of the board's big images */
  readonly thumbs: Thumbs;

  private recent = new Lru<true>(RECENT_FILES);
  private logs: string[] = [];

  /** thumbWorker: the built thumbnail worker (HostOptions) */
  constructor(
    readonly ws: Workspace,
    thumbWorker?: string,
  ) {
    this.thumbs = new Thumbs(ws, thumbWorker);
  }

  dispose() {
    this.index.dispose();
    this.meaning.dispose();
    this.prefetch.dispose();
    this.ops.dispose();
    this.githubFiles.dispose();
    this.scratch.dispose();
    this.trees.dispose();
    this.thumbs.dispose();
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
