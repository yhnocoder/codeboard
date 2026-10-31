// 问 VS Code 的语言服务（executeDefinitionProvider 之类）：Workspace.language 和代码编辑器的草稿文件都用
import * as vscode from "vscode";

/** 定义 / 实现在哪（line 从 1 数）；只回磁盘上的文件 */
export async function locations(
  cmd: string,
  abs: string,
  line: number,
  col: number,
): Promise<{ abs: string; line: number; col: number }[]> {
  const r = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    cmd,
    vscode.Uri.file(abs),
    new vscode.Position(line - 1, col),
  );
  const out: { abs: string; line: number; col: number }[] = [];
  for (const d of r ?? []) {
    const uri = "targetUri" in d ? d.targetUri : d.uri;
    const range = "targetUri" in d ? (d.targetSelectionRange ?? d.targetRange) : d.range;
    if (uri.scheme === "file") out.push({ abs: uri.fsPath, line: range.start.line + 1, col: range.start.character });
  }
  return out;
}

/** 语言服务在这个位置的悬停说明，每段一个 Markdown（line 从 0 数） */
export async function hoverAt(uri: vscode.Uri, line: number, col: number): Promise<string[]> {
  const hs = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    uri,
    new vscode.Position(line, col),
  );
  const parts: string[] = [];
  for (const h of hs ?? [])
    for (const c of h.contents) {
      if (typeof c === "string") parts.push(c);
      else if ("language" in c) parts.push("```" + c.language + "\n" + c.value + "\n```");
      else if (c.value) parts.push(c.value);
    }
  return parts;
}
