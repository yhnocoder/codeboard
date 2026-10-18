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
  // 共享卡还没有界面（下一步做）：测试用的入口。把白板上的卡变成共享卡 / 拆回独立的拷贝；卡换了 id 时开着的白板重新加载
  cmd("codeboard._shareCards", async (board: string, cards: string[]) => {
    const renamed = await store.share(board, cards);
    if (Object.keys(renamed).length) await panels.get(board)?.init();
    return renamed;
  });
  cmd("codeboard._unshareCard", async (board: string, card: string) => {
    const to = await store.unshare(board, card);
    if (to) await panels.get(board)?.init(); // 卡换了 id：白板重新载入
    return to;
  });
  // GITHUB FILES 里点文件：只读打开（不在白板旁边那一栏，也不闪行）
  cmd("codeboard.openGithubFile", async (abs: string) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession").then(undefined, () => {});
  });
}
