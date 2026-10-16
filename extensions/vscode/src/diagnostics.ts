// Copy Diagnostics：版本、Python / Pylance、工作区 git 状态、白板规模、最近的日志 → 剪贴板（home 换成 ~）。
// 另外：Sticker Packs 目录的 Open Folder。
import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { formatDiagnostics, type Board, type DiagInfo } from "@codeboard/core";
import { git } from "./git";
import { log, recentLog } from "./log";
import { readSettings } from "./settings";

const EXT_ID = "yhnocoder.codeboard-vscode";

async function folderInfo(f: vscode.WorkspaceFolder): Promise<DiagInfo["folders"][number]> {
  const p = f.uri.fsPath;
  const head = (await git(p, ["rev-parse", "HEAD"]))?.trim();
  if (!head) return { path: p, git: false };
  const st = await git(p, ["status", "--porcelain", "--untracked-files=no"]);
  return { path: p, git: true, head, dirty: !!st?.trim() };
}

/** board 给了就带上规模；attach = undefined 时问一次要不要附上白板 JSON */
export async function copyDiagnostics(board?: Board, attach?: boolean) {
  if (board && attach === undefined) {
    const pick = await vscode.window.showQuickPick([
      { label: "Copy Diagnostics", description: "Versions, workspace, recent log", attach: false },
      { label: "Copy Diagnostics + Board JSON", description: `Also attach “${board.name}”`, attach: true },
    ], { title: "Copy Diagnostics", placeHolder: "Attach board JSON?" });
    if (!pick) return;
    attach = pick.attach;
  }
  const ext = vscode.extensions.getExtension(EXT_ID) ?? vscode.extensions.all.find((e) => e.packageJSON?.name === "codeboard-vscode");
  const info: DiagInfo = {
    ext: ext?.packageJSON?.version ?? "?",
    vscode: vscode.version,
    os: `${process.platform} ${os.release()} ${process.arch}`,
    python: !!vscode.extensions.getExtension("ms-python.python"),
    pylance: !!vscode.extensions.getExtension("ms-python.vscode-pylance"),
    folders: await Promise.all((vscode.workspace.workspaceFolders ?? []).map(folderInfo)),
    board: board && { name: board.name, cards: board.cards.length, arrows: board.links.length, sections: board.sections.length },
    log: recentLog(),
    boardJson: board && attach ? JSON.stringify(board, null, 1) : undefined,
  };
  await vscode.env.clipboard.writeText(formatDiagnostics(info, os.homedir()));
  void vscode.window.showInformationMessage("Diagnostics copied to clipboard");
}

/** Sticker Packs 目录：设置为空 = ~/.codeboard/stickers；没有就建，然后在系统文件管理器里打开 */
export function stickerDir(): string {
  const s = readSettings().stickerDir.trim();
  if (!s) return path.join(os.homedir(), ".codeboard", "stickers");
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(1));
  return path.isAbsolute(s) ? s : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(), s);
}

export async function openStickerDir() {
  const dir = stickerDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(dir));
  } catch (e) {
    log("error", `sticker folder ${dir}: ${e instanceof Error ? e.message : e}`);
    void vscode.window.showErrorMessage(`Cannot open the sticker folder ${dir}`);
  }
}
