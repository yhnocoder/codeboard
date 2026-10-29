import * as vscode from "vscode";
import { makeActions } from "@codeboard/host/actions";
import type { BoardHub } from "@codeboard/host/hub";
import type { Storage } from "@codeboard/host/storage";
import { prompts } from "@codeboard/host/prompts";
import { DEEPSEEK_SECRET } from "./vscode/workspace";

export function registerCommands(ctx: vscode.ExtensionContext, panels: BoardHub, store: Storage) {
  const cmd = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  for (const [id, fn] of Object.entries(makeActions(panels, store))) cmd(id, fn as (...a: any[]) => unknown);
  cmd("codeboard.setDeepseekKey", async () => {
    const key = await prompts(panels.all().find((p) => p.view.active)).input({ title: "DeepSeek API Key", ok: "Save", prompt: "Used for gray inline completions in Notes and for the AI tools (Extract Text, Convert to SVG, Auto Focus). Stored in VS Code's secret storage.", password: true, placeHolder: "sk-…" });
    if (!key?.trim()) return;
    await ctx.secrets.store(DEEPSEEK_SECRET, key.trim());
    void vscode.window.showInformationMessage("DeepSeek API key saved.");
  });
  cmd("codeboard.clearDeepseekKey", async () => {
    await ctx.secrets.delete(DEEPSEEK_SECRET);
    void vscode.window.showInformationMessage("DeepSeek API key cleared.");
  });
  // 共享卡还没有界面（下一步做），这两个命令是测试用的入口
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
  cmd("codeboard.openGithubFile", async (abs: string) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession").then(undefined, () => {});
  });
}
