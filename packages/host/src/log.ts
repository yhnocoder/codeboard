import { hasWorkspace, workspace } from "./ws";

const recent: string[] = [];

export function log(level: "info" | "warn" | "error", text: string) {
  if (hasWorkspace()) workspace().log(level, text);
  recent.push(`${new Date().toISOString()} [${level}] ${text}`);
  if (recent.length > 200) recent.shift();
}

export const recentLog = () => recent.slice();
