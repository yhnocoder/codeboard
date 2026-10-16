// 日志：写到 “CodeBoard” 输出面板，同时留最近 200 条给 Copy Diagnostics。
import * as vscode from "vscode";

let ch: vscode.LogOutputChannel | undefined;
const recent: string[] = [];

export function log(level: "info" | "warn" | "error", text: string) {
  ch ??= vscode.window.createOutputChannel("CodeBoard", { log: true });
  ch[level](text);
  recent.push(`${new Date().toISOString()} [${level}] ${text}`);
  if (recent.length > 200) recent.shift();
}

export const recentLog = () => recent.slice();
