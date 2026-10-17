// 命令注册（VS Code 适配层）：命令做什么在 actions.ts。
import * as vscode from "vscode";
import { makeActions } from "./actions";
import type { Panels } from "./panel";
import type { Storage } from "./storage";
import { DEEPSEEK_SECRET } from "./vscode/workspace";

export function registerCommands(ctx: vscode.ExtensionContext, panels: Panels, store: Storage) {
  const cmd = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  for (const [id, fn] of Object.entries(makeActions(panels, store))) cmd(id, fn as (...a: any[]) => unknown);
  // DeepSeek 灰字补全的密钥：只存在 SecretStorage 里
  cmd("codeboard.setDeepseekKey", async () => {
    const key = await vscode.window.showInputBox({ title: "DeepSeek API Key", prompt: "Used for gray inline completions in Notes. Stored in VS Code's secret storage.", password: true, ignoreFocusOut: true, placeHolder: "sk-…" });
    if (!key?.trim()) return;
    await ctx.secrets.store(DEEPSEEK_SECRET, key.trim());
    void vscode.window.showInformationMessage("DeepSeek API key saved.");
  });
  cmd("codeboard.clearDeepseekKey", async () => {
    await ctx.secrets.delete(DEEPSEEK_SECRET);
    void vscode.window.showInformationMessage("DeepSeek API key cleared.");
  });
  // GITHUB FILES 里点文件：只读打开（不在白板旁边那一栏，也不闪行）
  cmd("codeboard.openGithubFile", async (abs: string) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession").then(undefined, () => {});
  });
}
