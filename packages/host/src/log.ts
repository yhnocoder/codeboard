// 日志：写到 Workspace 的输出（VS Code 的 “CodeBoard” 输出面板），同时留最近 200 条给 Copy Diagnostics。
import { hasWorkspace, workspace } from "./ws";

const recent: string[] = [];

export function log(level: "info" | "warn" | "error", text: string) {
  if (hasWorkspace()) workspace().log(level, text);
  recent.push(`${new Date().toISOString()} [${level}] ${text}`);
  if (recent.length > 200) recent.shift();
}

export const recentLog = () => recent.slice();
