// Workspace 的 VS Code 实现：功能代码只经过它访问编辑器和工作区（见 core/workspace.ts）。
import * as vscode from "vscode";
import * as path from "node:path";
import { COMPLETE_SYSTEM, Emitter, completePrompt, deepseekComplete, type Workspace } from "@codeboard/core";

const EXT_ID = "yhnocoder.codeboard-vscode";

// ---------- 历史版本的只读文档：codeboard-git:/<path>?{root, commit, path} ----------

export const GIT_SCHEME = "codeboard-git";
export function gitUri(root: string, commit: string, rel: string): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${commit.slice(0, 7)}/${rel}`, query: JSON.stringify({ root, commit, path: rel }) });
}
export function parseGitUri(u: vscode.Uri): { root: string; commit: string; path: string; abs: string } | null {
  try {
    const q = JSON.parse(u.query);
    return { ...q, abs: path.join(q.root, q.path) };
  } catch { return null; }
}
/** 历史版本文档的内容由 show(root, commit, path) 给 */
export function registerVersionDocs(show: (root: string, commit: string, rel: string) => Promise<string | null>): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
    provideTextDocumentContent: async (u) => {
      const q = parseGitUri(u);
      return q ? ((await show(q.root, q.commit, q.path)) ?? "") : "";
    },
  });
}

// ---------- 跳转：开在白板旁边那一栏，闪一下行 ----------

let flashDeco: vscode.TextEditorDecorationType | undefined;

async function show(uri: vscode.Uri, line: number | undefined, end?: number, readonly = false) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const ed = await vscode.window.showTextDocument(doc, { viewColumn: codeColumn(), preserveFocus: false, preview: true });
  if (readonly && uri.scheme === "file") await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession").then(undefined, () => {});
  if (line) {
    const l = Math.max(0, Math.min(doc.lineCount - 1, line - 1));
    const pos = new vscode.Position(l, doc.lineAt(l).firstNonWhitespaceCharacterIndex);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    const r = new vscode.Range(l, 0, Math.max(l, Math.min(doc.lineCount - 1, (end ?? line) - 1)), 0);
    const deco = (flashDeco ??= vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"), isWholeLine: true }));
    ed.setDecorations(deco, [r]);
    setTimeout(() => ed.setDecorations(deco, []), 1200);
  }
}

/** 代码开在白板旁边的那一栏（白板在第一栏时开第二栏） */
function codeColumn(): vscode.ViewColumn {
  const tab = vscode.window.tabGroups.activeTabGroup;
  const boardActive = tab.activeTab?.input instanceof vscode.TabInputWebview;
  if (!boardActive) return tab.viewColumn;
  const other = vscode.window.tabGroups.all.find((g) => g !== tab);
  return other?.viewColumn ?? vscode.ViewColumn.Beside;
}

// ---------- 设置：完整键 codeboard.newCards.hide = 节 codeboard + 键 newCards.hide ----------

const splitKey = (k: string) => { const i = k.indexOf("."); return [k.slice(0, i), k.slice(i + 1)] as const; };

const fileOrUndef = (u: vscode.Uri) => (u.scheme === "file" ? u.fsPath : undefined);

/** DeepSeek 的 API 密钥在 SecretStorage 里的名字（不进设置、不进白板文件、不写日志） */
export const DEEPSEEK_SECRET = "codeboard.deepseekApiKey";

// 用户装了 Copilot 之类提供模型的扩展才有；第一次用时 VS Code 会问用户同不同意。任何失败都静默回 undefined
async function copilotAsk(system: string, prompt: string, o?: { signal?: AbortSignal; maxChars?: number }): Promise<string | undefined> {
  const lm = (vscode as any).lm as typeof vscode.lm | undefined;
  if (!lm?.selectChatModels) return undefined;
  try {
    const all = await lm.selectChatModels();
    if (!all.length) return undefined;
    // 补全要快：优先小模型
    const fast = /mini|haiku|flash|nano|small|fast/i;
    const m = all.find((x) => fast.test(x.family) || fast.test(x.id)) ?? all[0];
    const cts = new vscode.CancellationTokenSource();
    o?.signal?.addEventListener("abort", () => cts.cancel());
    if (o?.signal?.aborted) return undefined;
    const r = await m.sendRequest([vscode.LanguageModelChatMessage.User(`${system}\n\n${prompt}`)], { justification: "CodeBoard suggests gray inline completions while you write a Note." }, cts.token);
    let out = "";
    for await (const t of r.text) { out += t; if (o?.maxChars && out.length > o.maxChars) { cts.cancel(); break; } }
    return out;
  } catch { return undefined; }
}

export function vscodeWorkspace(ctx: vscode.ExtensionContext): Workspace {
  let ch: vscode.LogOutputChannel | undefined;

  // VS Code 自带的 git 插件（有的话）：checkout、commit、pull 都会触发；第一次有人订阅时才接上
  const git = new Emitter<void>();
  let gitHooked = false;
  const hookGit = async () => {
    try {
      const gitExt = vscode.extensions.getExtension("vscode.git");
      const api = (gitExt?.isActive ? gitExt.exports : await gitExt?.activate())?.getAPI?.(1);
      if (!api) return;
      const hook = (repo: { state: { onDidChange: vscode.Event<void> } }) => ctx.subscriptions.push(repo.state.onDidChange(() => git.fire()));
      api.repositories.forEach(hook);
      ctx.subscriptions.push(api.onDidOpenRepository(hook));
    } catch { /* 没有 git 插件 */ }
  };

  return {
    files: {
      roots: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      rootOf: (abs) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(abs))?.uri.fsPath,
      openText: (abs) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === abs)?.getText(),
      openLanguage: (abs) => vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs)?.languageId,
      openFiles: () => vscode.workspace.textDocuments.filter((d) => d.uri.scheme === "file").map((d) => ({ abs: d.uri.fsPath, text: () => d.getText() })),
      findFiles: async (include, exclude, max) => (await vscode.workspace.findFiles(include, exclude, max)).map((u) => u.fsPath),
      watch: (base, glob, fn) => {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
        const f = (u: vscode.Uri) => fn(u.fsPath);
        w.onDidChange(f); w.onDidCreate(f); w.onDidDelete(f);
        return w;
      },
      onDidSave: (fn) => vscode.workspace.onDidSaveTextDocument((d) => fn(fileOrUndef(d.uri))),
      onDidEdit: (fn) => vscode.workspace.onDidChangeTextDocument((e) => { if (e.contentChanges.length) fn(fileOrUndef(e.document.uri)); }),
      onDidCreate: (fn) => vscode.workspace.onDidCreateFiles((e) => fn(e.files.map((u) => u.fsPath))),
      onDidDelete: (fn) => vscode.workspace.onDidDeleteFiles((e) => fn(e.files.map((u) => u.fsPath))),
      onDidRename: (fn) => vscode.workspace.onDidRenameFiles((e) => fn(e.files.map((f) => ({ from: f.oldUri.fsPath, to: f.newUri.fsPath })))),
      onDidChangeRoots: (fn) => vscode.workspace.onDidChangeWorkspaceFolders(() => fn()),
      onDidChangeGit: (fn) => {
        if (!gitHooked) { gitHooked = true; void hookGit(); }
        return git.event(fn);
      },
    },
    storage: {
      dir: () => (ctx.storageUri ?? ctx.globalStorageUri).fsPath,
      globalDir: () => ctx.globalStorageUri.fsPath,
      get: (k) => ctx.workspaceState.get(k),
      set: async (k, v) => { await ctx.workspaceState.update(k, v); },
    },
    language: {
      definitions: async (abs, line, col) => {
        const r = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
          "vscode.executeDefinitionProvider", vscode.Uri.file(abs), new vscode.Position(line - 1, col),
        );
        const out: { abs: string; line: number; col: number }[] = [];
        for (const d of r ?? []) {
          const uri = "targetUri" in d ? d.targetUri : d.uri;
          const range = "targetUri" in d ? (d.targetSelectionRange ?? d.targetRange) : d.range;
          if (uri.scheme === "file") out.push({ abs: uri.fsPath, line: range.start.line + 1, col: range.start.character });
        }
        return out;
      },
      hover: async (abs, line, col) => {
        const hs = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", vscode.Uri.file(abs), new vscode.Position(line - 1, col));
        const parts: string[] = [];
        for (const h of hs ?? []) for (const c of h.contents) {
          if (typeof c === "string") parts.push(c);
          else if ("language" in c) parts.push("```" + c.language + "\n" + c.value + "\n```");
          else if (c.value) parts.push(c.value);
        }
        return parts;
      },
    },
    settings: {
      get: (key) => { const [s, k] = splitKey(key); return vscode.workspace.getConfiguration(s).get(k); },
      set: async (key, v) => { const [s, k] = splitKey(key); await vscode.workspace.getConfiguration(s).update(k, v, vscode.ConfigurationTarget.Global); },
      onDidChange: (fn) => vscode.workspace.onDidChangeConfiguration((e) => fn({ affects: (k) => e.affectsConfiguration(k) })),
    },
    editor: {
      active: () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed) return undefined;
        const doc = ed.document, u = doc.uri;
        const q = u.scheme === GIT_SCHEME ? parseGitUri(u) : null;
        return {
          path: u.fsPath, file: u.scheme === "file", version: q ? { root: q.root, commit: q.commit, path: q.path } : undefined,
          lang: doc.languageId, text: doc.getText(),
          selections: ed.selections.map((s) => ({ startLine: s.start.line + 1, startCol: s.start.character, endLine: s.end.line + 1, endCol: s.end.character })),
          cursorLine: ed.selection.active.line + 1, selectionText: doc.getText(ed.selection),
        };
      },
      open: (abs, o = {}) => show(vscode.Uri.file(abs), o.line, o.end, o.readonly),
      openVersion: (v, line) => show(gitUri(v.root, v.commit, v.path), line),
    },
    ui: {
      info: async (text, ...actions) => vscode.window.showInformationMessage(text, ...actions),
      warn: async (text, o, ...actions) => vscode.window.showWarningMessage(text, { modal: o.modal, detail: o.detail }, ...actions),
      error: (text) => void vscode.window.showErrorMessage(text),
      pick: async (items, o) => vscode.window.showQuickPick(items, o),
      input: async (o) => vscode.window.showInputBox(o),
      openDialog: async (o) => {
        const r = await vscode.window.showOpenDialog(o.folders
          ? { canSelectFolders: true, canSelectFiles: false, openLabel: o.label, title: o.title }
          : { canSelectMany: false, filters: o.filters, openLabel: o.label, title: o.title });
        return r?.[0]?.fsPath;
      },
      saveDialog: async (o) => (await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(o.defaultPath), filters: o.filters }))?.fsPath,
      openUrl: async (url) => void (await vscode.env.openExternal(vscode.Uri.parse(url))),
      openFolder: async (abs) => void (await vscode.env.openExternal(vscode.Uri.file(abs))),
      revealInOS: async (abs) => void (await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(abs))),
      copy: async (text) => vscode.env.clipboard.writeText(text),
    },
    ai: {
      ask: copilotAsk,
      // 灰字补全：codeboard.ai.provider 选模型。auto = 设了 DeepSeek 密钥就用 DeepSeek，否则 Copilot
      complete: async (before, after, o) => {
        const cfg = vscode.workspace.getConfiguration("codeboard.ai");
        const provider = cfg.get<string>("provider", "auto");
        if (provider === "off") return undefined;
        if (provider === "deepseek" || provider === "auto") {
          const key = await ctx.secrets.get(DEEPSEEK_SECRET);
          if (key) return deepseekComplete({ key, model: cfg.get<string>("deepseekModel") || undefined, baseUrl: cfg.get<string>("deepseekBaseUrl") || undefined, signal: o?.signal }, before, after);
          if (provider === "deepseek") return undefined;
        }
        return copilotAsk(COMPLETE_SYSTEM, completePrompt(before, after), { signal: o?.signal, maxChars: 600 });
      },
    },
    githubToken: async (ask) => (await vscode.authentication.getSession("github", ["repo"], ask ? { createIfNone: true } : { silent: true }))?.accessToken,
    log: (level, text) => { (ch ??= vscode.window.createOutputChannel("CodeBoard", { log: true }))[level](text); },
    about: {
      app: vscode.version,
      get ext() { return (vscode.extensions.getExtension(EXT_ID) ?? vscode.extensions.all.find((e) => e.packageJSON?.name === "codeboard-vscode"))?.packageJSON?.version ?? "?"; },
      hasExtension: (id) => !!vscode.extensions.getExtension(id),
    },
  };
}
