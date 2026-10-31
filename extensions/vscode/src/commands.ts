import * as vscode from "vscode";
import { prompts, type Host } from "@codeboard/host";
import { DEEPSEEK_SECRET } from "./vscode/workspace";

export function registerCommands(ctx: vscode.ExtensionContext, host: Host) {
  const cmd = (id: string, fn: Parameters<typeof vscode.commands.registerCommand>[1]) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  for (const [id, fn] of Object.entries(host.actions)) cmd(id, fn);
  cmd("codeboard.setDeepseekKey", async () => {
    const key = await prompts(host.hub.all().find((p) => p.view.active)).input({ title: "DeepSeek API Key", ok: "Save", prompt: "Used for gray inline completions in Notes and for the AI tools (Extract Text, Convert to SVG, Auto Focus). Stored in VS Code's secret storage.", password: true, placeHolder: "sk-…" });
    if (!key?.trim()) return;
    await ctx.secrets.store(DEEPSEEK_SECRET, key.trim());
    void vscode.window.showInformationMessage("DeepSeek API key saved.");
  });
  cmd("codeboard.clearDeepseekKey", async () => {
    await ctx.secrets.delete(DEEPSEEK_SECRET);
    void vscode.window.showInformationMessage("DeepSeek API key cleared.");
  });
}
