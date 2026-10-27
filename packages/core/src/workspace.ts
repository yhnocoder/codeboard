// 宿主功能访问编辑器 / 工作区的唯一入口。只按 VS Code 插件现在真正用到的调用点抽出来，不为以后预设能力。
// 行号从 1 开始，列号从 0 开始。
import type { Disposable, Event } from "./emitter";

export type LogLevel = "info" | "warn" | "error";

export interface WorkspaceFiles {
  /** 工作区根目录（绝对路径）；第一个是主根，Source.repo 相对它 */
  roots(): string[];
  /** 工作区的名字：存成文件的多根工作区是 .code-workspace 的名字，否则是第一个根的文件夹名；没打开文件夹是 "" */
  name(): string;
  rootOf(abs: string): string | undefined;
  /** 编辑器里有未保存改动的磁盘文件：未保存的内容；没打开或没改过返回 undefined（读磁盘上的） */
  unsavedText(abs: string): string | undefined;
  /** 打开着的文件的语言（VS Code languageId）；没打开返回 undefined */
  openLanguage(abs: string): string | undefined;
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
  onDidChangeRoots: Event<void>;
  /** 编辑器自带的 git 集成报告仓库状态变了（checkout、commit、pull）；没有 git 集成就从不触发 */
  onDidChangeGit: Event<void>;
}

export interface WorkspaceStorage {
  /** 这个工作区的存储目录（没有工作区时是全局目录） */
  dir(): string;
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
  /** 转到实现：在基类方法上问，回所有覆盖它的子类方法（Pylance）；没有语言服务时回空 */
  implementations(abs: string, line: number, col: number): Promise<{ abs: string; line: number; col: number }[]>;
  /** 白板里编辑中的代码的虚拟文档；宿主没有语言服务时不给 */
  scratch?: WorkspaceScratch;
}

/** 补全的一项（从语言服务转过来）：insert 缺省 = label；from / to = 这一行上要替换的列（缺省 = 光标前的词） */
export type LspItem = { label: string; kind?: LspKind; detail?: string; doc?: string; insert?: string; from?: number; to?: number };
export type LspKind = "function" | "method" | "class" | "interface" | "enum" | "variable" | "constant" | "property" | "module" | "keyword" | "type" | "text";
/** 签名提示：label 是整个签名，params 是每个参数在 label 里的 [起, 止)，active = 当前参数（没有时 -1） */
export type LspSignature = { label: string; doc?: string; params: { at: [number, number]; doc?: string }[]; active: number };

/** 白板里编辑中的代码的虚拟文档（不在编辑器里显示）：语言服务照它回答。行列从 0 开始 */
export interface WorkspaceScratch {
  /** 建或更新：near = 放在这个文件旁边（同目录，Python 的 import 才找得到）；没给就放在工作区根 */
  sync(id: string, lang: string, text: string, near?: string): Promise<void>;
  close(id: string): Promise<void>;
  completions(id: string, line: number, col: number, trigger?: string): Promise<LspItem[]>;
  hover(id: string, line: number, col: number): Promise<string[]>;
  signature(id: string, line: number, col: number, trigger?: string): Promise<LspSignature | null>;
}

/** 用户设置，键是完整的点分名字（codeboard.theme、editor.fontFamily） */
export interface WorkspaceSettings {
  get<T>(key: string): T | undefined;
  /** 写设置；undefined = 删掉。默认写用户级，"workspace" 写进当前项目（.vscode/settings.json） */
  set(key: string, value: unknown, scope?: "user" | "workspace"): Promise<void>;
  onDidChange: Event<{ affects(key: string): boolean }>;
}

/** 一处选区：行从 1 开始，列从 0 开始 */
export type EditorRange = { startLine: number; startCol: number; endLine: number; endCol: number };

export type EditorState = {
  /** 文档路径（磁盘文件是绝对路径） */
  path: string;
  file: boolean;
  /** 历史版本的只读文档：它的仓库、commit、相对路径 */
  version?: { root: string; commit: string; path: string };
  lang: string;
  text: string;
  /** 所有选区，第一个是主选区 */
  selections: EditorRange[];
  /** 主选区的光标所在行 */
  cursorLine: number;
  selectionText: string;
};

export interface WorkspaceEditor {
  active(): EditorState | undefined;
  /** 在代码栏（白板旁边那一栏）打开文件；line..end 闪一下；readonly = 只读打开 */
  open(abs: string, opts?: { line?: number; end?: number; readonly?: boolean }): Promise<void>;
  /** 打开某个 commit 里的文件（只读虚拟文档） */
  openVersion(v: { root: string; commit: string; path: string }, line?: number): Promise<void>;
}

export type PickItem = { label: string; description?: string; detail?: string };

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
  openUrl(url: string): Promise<void>;
  openFolder(abs: string): Promise<void>;
  revealInOS(abs: string): Promise<void>;
  copy(text: string): Promise<void>;
  clipboard(): Promise<string>;
  /** 编辑器里接着按 ⌘Z 撤销刚加到白板上的卡（codeboard.undoAdd）：打开后，编辑器里一改字、动光标、换编辑器就自己关掉 */
  undoAddKey?(on: boolean): void;
}

/** 语言模型（VS Code 的 Language Model API 之类）：可选，宿主没有就不给 */
export interface WorkspaceAi {
  /** 发一次提示，回模型的文字；没有可用模型、用户没同意或被取消时回 undefined（不抛出） */
  ask(system: string, prompt: string, opts?: { signal?: AbortSignal; maxChars?: number }): Promise<string | undefined>;
  /** 灰字补全：光标前后的文字 → 模型的原话（清理交给 cleanCompletion）。宿主按设置选模型（Copilot、DeepSeek…）；不给时用 ask */
  complete?(before: string, after: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

export interface Workspace {
  files: WorkspaceFiles;
  storage: WorkspaceStorage;
  language: WorkspaceLanguage;
  settings: WorkspaceSettings;
  editor: WorkspaceEditor;
  ui: WorkspaceUi;
  ai?: WorkspaceAi;
  /** GitHub 登录的 token：ask = 没登录时请用户登录（取消时抛出）；否则只静默拿已有的 */
  githubToken(ask: boolean): Promise<string | undefined>;
  log(level: LogLevel, text: string): void;
  about: { app: string; ext: string; hasExtension(id: string): boolean };
}
