// The documents behind code being edited on a board (packages/host/src/scratchfiles.ts makes, refreshes and deletes the hidden
// files next to the source file): opened here so the language service (Python: usually Pylance) answers completions and
// signature help from them. Pylance only reads workspace files on disk and untitled documents, and resolves a same-folder or
// relative import from the file's place.
// The text is written straight into the file (vscode.workspace.fs) and VS Code reads it back: changed with a WorkspaceEdit
// (untitled too), VS Code soon opens a tab for the unsaved document and brings it back when the window reloads.
// Known side effects: the Explorer shows the file while it is edited, and Pylance may list its problems.
import * as vscode from "vscode";
import * as path from "node:path";
import type { LspItem, LspKind, LspSignature, WorkspaceScratch } from "@codeboard/core";
import { isScratchName } from "@codeboard/host";

export type Doc = { uri: vscode.Uri; doc: vscode.TextDocument };
/** Skipped by the document and file listeners. By name: a notice that comes after the file is deleted, or for another window's
 *  file, is skipped too */
export const isScratch = (u: vscode.Uri) => u.scheme === "file" && isScratchName(path.basename(u.fsPath));

const KIND: Partial<Record<vscode.CompletionItemKind, LspKind>> = {
  [vscode.CompletionItemKind.Method]: "method",
  [vscode.CompletionItemKind.Function]: "function",
  [vscode.CompletionItemKind.Constructor]: "class",
  [vscode.CompletionItemKind.Field]: "property",
  [vscode.CompletionItemKind.Variable]: "variable",
  [vscode.CompletionItemKind.Class]: "class",
  [vscode.CompletionItemKind.Interface]: "interface",
  [vscode.CompletionItemKind.Module]: "module",
  [vscode.CompletionItemKind.Property]: "property",
  [vscode.CompletionItemKind.Enum]: "enum",
  [vscode.CompletionItemKind.EnumMember]: "constant",
  [vscode.CompletionItemKind.Keyword]: "keyword",
  [vscode.CompletionItemKind.Constant]: "constant",
  [vscode.CompletionItemKind.Struct]: "class",
  [vscode.CompletionItemKind.TypeParameter]: "type",
  [vscode.CompletionItemKind.Value]: "constant",
  [vscode.CompletionItemKind.Text]: "text",
  [vscode.CompletionItemKind.Snippet]: "text",
};

const md = (d: string | vscode.MarkdownString | undefined) =>
  (d === undefined ? undefined : typeof d === "string" ? d : d.value) || undefined;
/** 代码片段 → 纯文字（${1:x} → x，$1 / $0 去掉） */
const unsnippet = (s: string) =>
  s
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$\{\d+\}|\$\d+/g, "")
    .replace(/\\([$}\\])/g, "$1");

/** docs = file → its document */
async function ensure(docs: Map<string, Doc>, file: string, lang: string): Promise<Doc> {
  const have = docs.get(file);
  if (have && !have.doc.isClosed) {
    if (have.doc.languageId !== lang) have.doc = await vscode.languages.setTextDocumentLanguage(have.doc, lang);
    return have;
  }
  const uri = vscode.Uri.file(file);
  let doc = await vscode.workspace.openTextDocument(uri);
  if (doc.languageId !== lang) doc = await vscode.languages.setTextDocumentLanguage(doc, lang);
  const d: Doc = { uri, doc };
  docs.set(file, d);
  return d;
}

/** 等 VS Code 把写好的文件读回文档最多等多久：过了就当这次同步失败（这次请求回空、下次再同步），不拿旧内容去问语言服务 */
export const RELOAD_LIMIT_MS = 10_000;
// VS Code 读回来时可能把换行统一成 \r\n
const sameText = (a: string, b: string) => a === b || a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/**
 * 写文件后等 VS Code 把文档读回来（onDidChangeTextDocument，文档的字和要的一样）再返回：问语言服务之前文档要和白板上的一样。
 * 等不到就失败（写文件出错、文档在读回来之前被关掉、RELOAD_LIMIT_MS 内没来），这次的补全 / 悬停 / 签名回空
 */
export async function setText(d: Doc, text: string) {
  if (sameText(d.doc.getText(), text)) return;
  const k = d.uri.toString();
  await new Promise<void>((resolve, reject) => {
    let over = false;
    const end = (err?: Error) => {
      if (over) return;
      over = true;
      clearTimeout(limit);
      for (const s of subs) s.dispose();
      if (err) reject(err);
      else resolve();
    };
    const subs = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === k && sameText(e.document.getText(), text)) {
          d.doc = e.document;
          end();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.toString() === k) end(new Error(`scratch document was closed before it reloaded: ${d.uri.fsPath}`));
      }),
    ];
    const limit = setTimeout(
      () => end(new Error(`scratch document did not reload within ${RELOAD_LIMIT_MS} ms: ${d.uri.fsPath}`)),
      RELOAD_LIMIT_MS,
    );
    vscode.workspace.fs
      .writeFile(d.uri, Buffer.from(text, "utf8"))
      .then(undefined, (e: unknown) => end(e instanceof Error ? e : new Error(String(e))));
  });
}

function item(c: vscode.CompletionItem, line: number): LspItem {
  const label = typeof c.label === "string" ? c.label : c.label.label;
  const ins =
    c.insertText === undefined
      ? undefined
      : typeof c.insertText === "string"
        ? c.insertText
        : unsnippet(c.insertText.value);
  const r = c.range && ("replacing" in c.range ? c.range.replacing : c.range);
  const detail = c.detail ?? (typeof c.label === "string" ? undefined : (c.label.description ?? c.label.detail));
  const out: LspItem = { label };
  if (c.kind !== undefined && KIND[c.kind]) out.kind = KIND[c.kind];
  if (detail) out.detail = detail;
  const doc = md(c.documentation);
  if (doc) out.doc = doc;
  if (ins !== undefined && ins !== label) out.insert = ins;
  if (r && r.start.line === line && r.end.line === line) {
    out.from = r.start.character;
    out.to = r.end.character;
  }
  return out;
}

function signature(h: vscode.SignatureHelp | undefined): LspSignature | null {
  const s = h?.signatures[h.activeSignature ?? 0] ?? h?.signatures[0];
  if (!s) return null;
  let at = 0;
  const params = (s.parameters ?? []).map((p) => {
    let r: [number, number];
    if (typeof p.label === "string") {
      const i = s.label.indexOf(p.label, at);
      r = i >= 0 ? [i, i + p.label.length] : [0, 0];
    } else r = [p.label[0], p.label[1]];
    at = r[1];
    return { at: r, doc: md(p.documentation) };
  });
  const active = s.activeParameter ?? h!.activeParameter ?? -1;
  return { label: s.label, doc: md(s.documentation), params, active: active < params.length ? active : -1 };
}

export function vscodeScratch(): WorkspaceScratch {
  /** file → its document */
  const docs = new Map<string, Doc>();
  return {
    sync: async (file, lang, text) => {
      await setText(await ensure(docs, file, lang), text);
    },
    // a document that is not open in an editor and has no unsaved changes VS Code lets go by itself
    close: (file) => void docs.delete(file),
    completions: async (file, line, col, trigger) => {
      const d = docs.get(file);
      if (!d) return [];
      const l = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        d.uri,
        new vscode.Position(line, col),
        trigger,
        0,
      );
      const items = [...(l?.items ?? [])].sort((a, b) =>
        (a.sortText ?? (typeof a.label === "string" ? a.label : a.label.label)).localeCompare(
          b.sortText ?? (typeof b.label === "string" ? b.label : b.label.label),
        ),
      );
      return items.map((c) => item(c, line));
    },
    signature: async (file, line, col, trigger) => {
      const d = docs.get(file);
      if (!d) return null;
      return signature(
        await vscode.commands.executeCommand<vscode.SignatureHelp>(
          "vscode.executeSignatureHelpProvider",
          d.uri,
          new vscode.Position(line, col),
          trigger,
        ),
      );
    },
  };
}
