import * as vscode from "vscode";
import type { Host } from "@codeboard/host";

export function registerCommands(ctx: vscode.ExtensionContext, host: Host) {
  for (const [id, fn] of Object.entries(host.actions)) ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
}
