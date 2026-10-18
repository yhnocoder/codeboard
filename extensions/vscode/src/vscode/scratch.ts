// WorkspaceScratch 的 VS Code 实现：白板里编辑中的代码对应一个不在编辑器里显示的文档，补全 / 悬停 / 签名走
// vscode.executeCompletionItemProvider / executeHoverProvider / executeSignatureHelpProvider（Python 一般是 Pylance 在答）。
// 文档是 near 那个源文件旁边的一个隐藏文件 .codeboard-scratch-<id>.py（Pylance 只认工作区里的磁盘文件和 untitled：同目录下 import、
// 相对 import 都按源文件的位置找），编辑结束就删掉；它的名字写进仓库的 .git/info/exclude（只在本机，不进提交），git status 看不到。
// 内容直接写文件（vscode.workspace.fs），VS Code 从磁盘读回来：文档从来不是“未保存”的。用 WorkspaceEdit 改的话（untitled 也一样），
// VS Code 过一会儿会给未保存的文档开一个标签页，重新加载窗口时还会恢复出来。
// 编辑的这段时间里资源管理器能看到这个文件；Pylance 的问题面板也可能列出它的问题。
// 文件名规则、心跳和崩溃后清理的规则见 ../scratchnames.ts。
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import type { LspItem, LspKind, LspSignature, WorkspaceScratch } from "@codeboard/core";
import { HEARTBEAT_MS, SCRATCH_GLOB, isScratchName, scratchName, staleScratch } from "../scratchnames";

type Doc = { uri: vscode.Uri; lang: string; doc: vscode.TextDocument };
const docs = new Map<string, Doc>();
const files = new Set<string>();
/** 这是不是某段编辑中的代码的文档（文档变了、存了、文件变了的监听里要跳过它） */
export const isScratch = (u: vscode.Uri) => u.scheme === "file" && (files.has(u.fsPath) || isScratchName(path.basename(u.fsPath)));

/** 放文件的目录：near 那个文件的目录；没给就是工作区根（store：没有工作区时） */
function dirFor(near: string | undefined, store: string): string {
  return near ? path.dirname(near) : path.join(store, "scratch");
}
/** 仓库的 .git/info/exclude 里加上 .codeboard-scratch-*（每个仓库一次）；以前版本写的 .codeboard-* 那段换掉（它连用户自己的 .codeboard-xxx 也藏起来） */
const excluded = new Set<string>();
function exclude(dir: string) {
  for (let d = dir; d && d !== path.dirname(d); d = path.dirname(d)) {
    const g = path.join(d, ".git");
    if (!fs.existsSync(g)) continue;
    if (excluded.has(g)) return;
    excluded.add(g);
    try {
      let gd = g;
      if (!fs.statSync(g).isDirectory()) { const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, "utf8")); if (!m) return; gd = path.resolve(d, m[1].trim()); const c = path.join(gd, "commondir"); if (fs.existsSync(c)) gd = path.resolve(gd, fs.readFileSync(c, "utf8").trim()); }
      const f = path.join(gd, "info", "exclude");
      const t = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      const NOTE = "# CodeBoard: code being edited on a board (deleted when editing ends)\n";
      const OLD = `${NOTE}.codeboard-*\n`;
      if (!t.split("\n").includes(SCRATCH_GLOB)) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        if (t.includes(OLD)) fs.writeFileSync(f, t.replace(OLD, `${NOTE}${SCRATCH_GLOB}\n`));
        else fs.appendFileSync(f, `${t && !t.endsWith("\n") ? "\n" : ""}${NOTE}${SCRATCH_GLOB}\n`);
      }
    } catch { /* 写不了就算了 */ }
    return;
  }
}
const cleaned = new Set<string>();
/** 上次没删掉的（窗口被关掉、崩了）：只删名字对得上、不是这个进程的、mtime 超过 10 分钟的（别的窗口在用的文件每分钟刷一次 mtime）。出错就跳过 */
function cleanup(dir: string) {
  try {
    const now = Date.now();
    const entries: { name: string; mtimeMs: number }[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!isScratchName(name)) continue;
      try { const st = fs.statSync(path.join(dir, name)); if (st.isFile()) entries.push({ name, mtimeMs: st.mtimeMs }); } catch { /* 刚被删了 */ }
    }
    for (const name of staleScratch(entries, now, (n) => files.has(path.join(dir, n)))) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* 删不了就算了 */ }
    }
  } catch { /* 读不了目录就算了 */ }
}
/** 心跳：打开着的文件每分钟 touch 一次，别的窗口的清理就知道它还在用 */
let heartbeat: ReturnType<typeof setInterval> | undefined;
function beat() {
  const now = new Date();
  for (const d of docs.values()) { try { fs.utimesSync(d.uri.fsPath, now, now); } catch { /* 文件没了 */ } }
}

const KIND: Partial<Record<vscode.CompletionItemKind, LspKind>> = {
  [vscode.CompletionItemKind.Method]: "method", [vscode.CompletionItemKind.Function]: "function", [vscode.CompletionItemKind.Constructor]: "class",
  [vscode.CompletionItemKind.Field]: "property", [vscode.CompletionItemKind.Variable]: "variable", [vscode.CompletionItemKind.Class]: "class",
  [vscode.CompletionItemKind.Interface]: "interface", [vscode.CompletionItemKind.Module]: "module", [vscode.CompletionItemKind.Property]: "property",
  [vscode.CompletionItemKind.Enum]: "enum", [vscode.CompletionItemKind.EnumMember]: "constant", [vscode.CompletionItemKind.Keyword]: "keyword",
  [vscode.CompletionItemKind.Constant]: "constant", [vscode.CompletionItemKind.Struct]: "class", [vscode.CompletionItemKind.TypeParameter]: "type",
  [vscode.CompletionItemKind.Value]: "constant", [vscode.CompletionItemKind.Text]: "text", [vscode.CompletionItemKind.Snippet]: "text",
};

const md = (d: string | vscode.MarkdownString | undefined) => (d === undefined ? undefined : typeof d === "string" ? d : d.value) || undefined;
/** 代码片段 → 纯文字（${1:x} → x，$1 / $0 去掉） */
export const unsnippet = (s: string) => s.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{\d+\}|\$\d+/g, "").replace(/\\([$}\\])/g, "$1");

async function ensure(id: string, lang: string, near: string | undefined, store: string): Promise<Doc> {
  const have = docs.get(id);
  if (have && !have.doc.isClosed) {
    if (have.doc.languageId !== lang) have.doc = await vscode.languages.setTextDocumentLanguage(have.doc, lang);
    have.lang = lang;
    return have;
  }
  const dir = dirFor(near, store);
  fs.mkdirSync(dir, { recursive: true });
  exclude(dir);
  if (!cleaned.has(dir)) { cleaned.add(dir); cleanup(dir); }
  const file = path.join(dir, scratchName(id, lang));
  if (!files.has(file)) fs.writeFileSync(file, "");
  files.add(file);
  if (!heartbeat) { heartbeat = setInterval(beat, HEARTBEAT_MS); heartbeat.unref?.(); }
  const uri = vscode.Uri.file(file);
  let doc = await vscode.workspace.openTextDocument(uri);
  if (doc.languageId !== lang) doc = await vscode.languages.setTextDocumentLanguage(doc, lang);
  const d: Doc = { uri, lang, doc };
  docs.set(id, d);
  return d;
}

/** 换内容：写文件，等 VS Code 把文档读回来（问语言服务之前文档要和白板上的一样） */
async function setText(d: Doc, text: string) {
  if (d.doc.getText() === text) return;
  const k = d.uri.toString();
  await new Promise<void>((done) => {
    const t = setTimeout(() => { sub.dispose(); done(); }, 1500);
    const sub = vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.toString() === k && e.document.getText() === text) { clearTimeout(t); sub.dispose(); done(); } });
    void vscode.workspace.fs.writeFile(d.uri, Buffer.from(text, "utf8"));
  });
}

function item(c: vscode.CompletionItem, line: number): LspItem {
  const label = typeof c.label === "string" ? c.label : c.label.label;
  const ins = c.insertText === undefined ? undefined : typeof c.insertText === "string" ? c.insertText : unsnippet(c.insertText.value);
  const r = c.range && ("replacing" in c.range ? c.range.replacing : c.range);
  const detail = c.detail ?? (typeof c.label === "string" ? undefined : c.label.description ?? c.label.detail);
  const out: LspItem = { label };
  if (c.kind !== undefined && KIND[c.kind]) out.kind = KIND[c.kind];
  if (detail) out.detail = detail;
  const doc = md(c.documentation);
  if (doc) out.doc = doc;
  if (ins !== undefined && ins !== label) out.insert = ins;
  if (r && r.start.line === line && r.end.line === line) { out.from = r.start.character; out.to = r.end.character; }
  return out;
}

function signature(h: vscode.SignatureHelp | undefined): LspSignature | null {
  const s = h?.signatures[h.activeSignature ?? 0] ?? h?.signatures[0];
  if (!s) return null;
  let at = 0;
  const params = (s.parameters ?? []).map((p) => {
    let r: [number, number];
    if (typeof p.label === "string") { const i = s.label.indexOf(p.label, at); r = i >= 0 ? [i, i + p.label.length] : [0, 0]; }
    else r = [p.label[0], p.label[1]];
    at = r[1];
    return { at: r, doc: md(p.documentation) };
  });
  const active = s.activeParameter ?? h!.activeParameter ?? -1;
  return { label: s.label, doc: md(s.documentation), params, active: active < params.length ? active : -1 };
}

/** 插件停用时：删掉还在编辑的那些文件（窗口关了、白板关了没来得及结束编辑） */
export function disposeScratch() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
  for (const f of files) fs.rmSync(f, { force: true });
  files.clear();
  docs.clear();
}

export function vscodeScratch(storeDir: () => string): WorkspaceScratch {
  return {
    sync: async (id, lang, text, near) => { await setText(await ensure(id, lang, near, storeDir()), text); },
    close: async (id) => {
      const d = docs.get(id);
      docs.delete(id);
      if (!d) return;
      // 删掉文件：没打开在编辑器里、也没改过的文档，VS Code 过一会儿自己放掉
      fs.rmSync(d.uri.fsPath, { force: true });
      setTimeout(() => files.delete(d.uri.fsPath), 5000); // 删文件的通知晚一点才来，那之前还要跳过它
    },
    completions: async (id, line, col, trigger) => {
      const d = docs.get(id);
      if (!d) return [];
      const l = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", d.uri, new vscode.Position(line, col), trigger, 0);
      const items = [...(l?.items ?? [])].sort((a, b) => (a.sortText ?? (typeof a.label === "string" ? a.label : a.label.label)).localeCompare(b.sortText ?? (typeof b.label === "string" ? b.label : b.label.label)));
      return items.map((c) => item(c, line));
    },
    hover: async (id, line, col) => {
      const d = docs.get(id);
      if (!d) return [];
      const hs = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", d.uri, new vscode.Position(line, col));
      const parts: string[] = [];
      for (const h of hs ?? []) for (const c of h.contents) {
        if (typeof c === "string") parts.push(c);
        else if ("language" in c) parts.push("```" + c.language + "\n" + c.value + "\n```");
        else if (c.value) parts.push(c.value);
      }
      return parts;
    },
    signature: async (id, line, col, trigger) => {
      const d = docs.get(id);
      if (!d) return null;
      return signature(await vscode.commands.executeCommand<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", d.uri, new vscode.Position(line, col), trigger));
    },
  };
}
