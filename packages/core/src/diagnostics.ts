// Copy Diagnostics 的文本：宿主收集事实，这里排版（纯函数，好测）。home 目录一律换成 ~。

export type DiagInfo = {
  ext: string; // 插件版本
  vscode: string;
  os: string; // darwin 24.1.0 arm64
  python: boolean;
  pylance: boolean;
  folders: { path: string; head?: string; dirty?: boolean; git: boolean }[];
  board?: { name: string; cards: number; arrows: number; sections: number };
  log: string[]; // 最近的日志行：`2026-10-16T03:35:00.000Z [error] …`
  boardJson?: string;
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 把 home 路径换成 ~（含 file:// 和 Windows 反斜杠写法） */
export function tildify(text: string, home: string): string {
  if (!home || home === "/") return text;
  const h = home.replace(/[\\/]+$/, "");
  const forms = new Set([h, h.replace(/\\/g, "/"), h.replace(/\//g, "\\")]);
  for (const f of [...forms].sort((a, b) => b.length - a.length)) text = text.replace(new RegExp(`${esc(f)}(?=[\\\\/]|$|[\\s"'\`:)\\]])`, "g"), "~");
  return text;
}

const time = (line: string) => /T(\d\d:\d\d:\d\d)/.exec(line)?.[1] ?? "";

/** 最近的报错：日志里 [error] / [warn] 的行，最新的在后面，最多 n 条 */
export function recentErrors(log: string[], n = 20): string[] {
  return log.filter((l) => /\[(error|warn)\]/.test(l)).slice(-n).map((l) => `  ${time(l)} ${l.replace(/^\S+\s+\[(error|warn)\]\s*/, (_, lv) => (lv === "warn" ? "" : "error: "))}`);
}

export function formatDiagnostics(d: DiagInfo, home: string): string {
  const yes = (b: boolean) => (b ? "yes" : "no");
  const out: string[] = [];
  out.push(`CodeBoard ${d.ext} · VS Code ${d.vscode} · ${d.os}`);
  out.push(`Python ext: ${yes(d.python)} · Pylance: ${yes(d.pylance)}`);
  if (!d.folders.length) out.push("Workspace: (no folder open)");
  for (const f of d.folders) out.push(`Workspace: ${f.path}${f.git ? ` @ ${f.head ? f.head.slice(0, 7) : "?"} (${f.dirty ? "dirty" : "clean"})` : " (not a git repo)"}`);
  if (d.board) out.push(`Board: “${d.board.name}” · ${d.board.cards} cards · ${d.board.arrows} arrows · ${d.board.sections} sections`);
  const errs = recentErrors(d.log);
  out.push("", `Recent errors:${errs.length ? "" : " none"}`, ...errs);
  out.push("", `Log (last ${Math.min(200, d.log.length)} lines):`, ...d.log.slice(-200));
  if (d.boardJson) out.push("", "Board JSON:", d.boardJson);
  return tildify(out.join("\n"), home);
}
