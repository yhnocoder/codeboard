// 宿主功能访问编辑器 / 工作区的唯一入口。只按 VS Code 插件现在真正用到的调用点抽出来（不为以后的 macOS 版预设能力）；
// VS Code 的实现在 extensions/vscode/src/vscode/。行号从 1 开始，列号从 0 开始。
import type { Disposable, Event } from "./emitter";

export type LogLevel = "info" | "warn" | "error";

/** 工作区的根、文件内容、找文件、文件变化 */
export interface WorkspaceFiles {
  /** 工作区根目录（绝对路径）；第一个是主根，Source.repo 相对它 */
  roots(): string[];
  /** 文件所在的工作区根（不在任何根下返回 undefined） */
  rootOf(abs: string): string | undefined;
  /** 编辑器里打开着的磁盘文件：内容含未保存的改动；没打开返回 undefined */
  openText(abs: string): string | undefined;
  /** 打开着的文件的语言（VS Code languageId）；没打开返回 undefined */
  openLanguage(abs: string): string | undefined;
  /** 所有打开着的磁盘文件 */
  openFiles(): { abs: string; text(): string }[];
  /** 按 glob 找工作区里的文件（绝对路径） */
  findFiles(include: string, exclude?: string, max?: number): Promise<string[]>;
  /** 监听 base 目录下匹配 glob 的文件：新建、删除、修改（含 VS Code 外面的改动） */
  watch(base: string, glob: string, fn: (abs: string) => void): Disposable;
  /** 保存了一个文档（磁盘文件给路径；未命名 / 虚拟文档给 undefined） */
  onDidSave: Event<string | undefined>;
  /** 编辑器里改了一个文档的内容（还没保存） */
  onDidEdit: Event<string | undefined>;
  /** 在 VS Code 里新建 / 删除 / 改名的文件 */
  onDidCreate: Event<string[]>;
  onDidDelete: Event<string[]>;
  onDidRename: Event<{ from: string; to: string }[]>;
  /** 工作区根变了 */
  onDidChangeRoots: Event<void>;
  /** 编辑器自带的 git 集成报告仓库状态变了（checkout、commit、pull）；没有 git 集成就从不触发 */
  onDidChangeGit: Event<void>;
}

/** 插件自己的存储：目录和按工作区记住的小状态 */
export interface WorkspaceStorage {
  /** 这个工作区的存储目录（没有工作区时是全局目录） */
  dir(): string;
  /** 所有工作区共用的存储目录 */
  globalDir(): string;
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): Promise<void>;
}

/** 语言服务（Pylance、clangd…）：没有时回空 */
export interface WorkspaceLanguage {
  /** 转到定义：只回磁盘文件里的位置；语言服务出错时抛出 */
  definitions(abs: string, line: number, col: number): Promise<{ abs: string; line: number; col: number }[]>;
  /** 悬停：每一段内容转成 Markdown（带语言的签名是代码块） */
  hover(abs: string, line: number, col: number): Promise<string[]>;
}

/** 用户设置，键是完整的点分名字（codeboard.theme、editor.fontFamily） */
export interface WorkspaceSettings {
  get<T>(key: string): T | undefined;
  /** 写用户级设置；undefined = 删掉 */
  set(key: string, value: unknown): Promise<void>;
  onDidChange: Event<{ affects(key: string): boolean }>;
}

/** 一处选区：行从 1 开始，列从 0 开始 */
export type EditorRange = { startLine: number; startCol: number; endLine: number; endCol: number };

/** 当前编辑器（建卡、Reveal on Board 用） */
export type EditorState = {
  /** 文档路径（磁盘文件是绝对路径） */
  path: string;
  /** 是不是磁盘文件 */
  file: boolean;
  /** 历史版本的只读文档：它的仓库、commit、相对路径 */
  version?: { root: string; commit: string; path: string };
  lang: string;
  text: string;
  /** 所有选区，第一个是主选区 */
  selections: EditorRange[];
  /** 主选区的光标所在行 */
  cursorLine: number;
  /** 主选区的文本 */
  selectionText: string;
};

/** 编辑器：开文件到某一行（闪一下高亮）、开历史版本 */
export interface WorkspaceEditor {
  active(): EditorState | undefined;
  /** 在代码栏（白板旁边那一栏）打开文件；line..end 闪一下；readonly = 只读打开 */
  open(abs: string, opts?: { line?: number; end?: number; readonly?: boolean }): Promise<void>;
  /** 打开某个 commit 里的文件（只读虚拟文档） */
  openVersion(v: { root: string; commit: string; path: string }, line?: number): Promise<void>;
}

export type PickItem = { label: string; description?: string; detail?: string };

/** 提示、选择、对话框、外部打开、剪贴板 */
export interface WorkspaceUi {
  info(text: string, ...actions: string[]): Promise<string | undefined>;
  warn(text: string, opts: { modal?: boolean; detail?: string }, ...actions: string[]): Promise<string | undefined>;
  error(text: string): void;
  /** 选一项；回的是传进来的那个对象 */
  pick<T extends PickItem>(items: T[], opts?: { placeHolder?: string; title?: string; matchOnDescription?: boolean }): Promise<T | undefined>;
  input(opts: { prompt: string; value?: string; placeHolder?: string }): Promise<string | undefined>;
  /** 选一个文件（filters）或文件夹（folders） */
  openDialog(opts: { folders?: boolean; filters?: Record<string, string[]>; label: string; title?: string }): Promise<string | undefined>;
  saveDialog(opts: { defaultPath: string; filters: Record<string, string[]> }): Promise<string | undefined>;
  /** 用系统默认程序打开网址 */
  openUrl(url: string): Promise<void>;
  /** 用系统文件管理器打开文件夹 */
  openFolder(abs: string): Promise<void>;
  /** 在系统文件管理器里选中文件 */
  revealInOS(abs: string): Promise<void>;
  copy(text: string): Promise<void>;
}

/** 语言模型（VS Code 的 Language Model API 之类）：可选，宿主没有就不给 */
export interface WorkspaceAi {
  /** 发一次提示，回模型的文字；没有可用模型、用户没同意或被取消时回 undefined（不抛出） */
  ask(system: string, prompt: string, opts?: { signal?: AbortSignal; maxChars?: number }): Promise<string | undefined>;
}

export interface Workspace {
  files: WorkspaceFiles;
  storage: WorkspaceStorage;
  language: WorkspaceLanguage;
  settings: WorkspaceSettings;
  editor: WorkspaceEditor;
  ui: WorkspaceUi;
  /** 语言模型；没有这个能力的宿主不给 */
  ai?: WorkspaceAi;
  /** GitHub 登录的 token：ask = 没登录时请用户登录（取消时抛出）；否则只静默拿已有的 */
  githubToken(ask: boolean): Promise<string | undefined>;
  /** 写到输出面板 */
  log(level: LogLevel, text: string): void;
  /** 版本信息（Copy Diagnostics） */
  about: { app: string; ext: string; hasExtension(id: string): boolean };
}
