import raw from "./nanovllm.json";
import { tokenizePython, type Tok } from "../lib/pytok";

type Raw = {
  name: string;
  url: string;
  head: string;
  commits: { sha: string; short: string; date: string; subject: string }[];
  files: Record<string, Record<string, string>>;
};
const data = raw as Raw;

export const repo = {
  name: data.name,
  url: data.url,
  head: data.head,
  commits: data.commits,
};

export function commitInfo(short: string) {
  return data.commits.find((c) => c.short === short)!;
}

export function listFiles(): string[] {
  return Object.keys(data.files[data.head]).sort((a, b) => {
    // 根目录文件排在后面，目录内按名字
    const da = a.split("/").length, db = b.split("/").length;
    return da === db ? a.localeCompare(b) : db - da;
  });
}

export function fileText(commit: string, path: string): string | undefined {
  return data.files[commit]?.[path] ?? data.files[data.head][path];
}

const lineCache = new Map<string, string[]>();
export function fileLines(commit: string, path: string): string[] {
  const key = commit + ":" + path;
  let v = lineCache.get(key);
  if (!v) {
    v = (fileText(commit, path) ?? "").split("\n");
    lineCache.set(key, v);
  }
  return v;
}

const tokCache = new Map<string, Tok[][]>();
export function fileTokens(commit: string, path: string): Tok[][] {
  const key = commit + ":" + path;
  let v = tokCache.get(key);
  if (!v) {
    v = tokenizePython(fileText(commit, path) ?? "");
    tokCache.set(key, v);
  }
  return v;
}

export type Symbol = {
  name: string;
  qual: string; // 例如 Scheduler.schedule
  kind: "def" | "class";
  path: string;
  start: number; // 1-based，包含装饰器
  defLine: number; // def/class 所在行
  end: number; // 1-based，含
};

const symCache = new Map<string, Symbol[]>();
export function symbols(commit: string, path: string): Symbol[] {
  const key = commit + ":" + path;
  const hit = symCache.get(key);
  if (hit) return hit;
  const lines = fileLines(commit, path);
  const out: Symbol[] = [];
  const stack: { indent: number; qual: string }[] = [];
  const indentOf = (s: string) => s.length - s.trimStart().length;
  lines.forEach((line, idx) => {
    const m = /^(\s*)(def|class)\s+(\w+)/.exec(line);
    if (!m) return;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const qual = [...stack.map((s) => s.qual.split(".").pop()), m[3]].join(".");
    let start = idx;
    while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
    let end = idx;
    for (let j = idx + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") continue;
      if (indentOf(l) <= indent) break;
      end = j;
    }
    out.push({ name: m[3], qual, kind: m[2] as "def" | "class", path, start: start + 1, defLine: idx + 1, end: end + 1 });
    stack.push({ indent, qual });
  });
  symCache.set(key, out);
  return out;
}

export function allSymbols(commit: string): Symbol[] {
  return listFiles().flatMap((p) => symbols(commit, p));
}

export function findSymbol(commit: string, path: string, qual: string): Symbol | undefined {
  return symbols(commit, path).find((s) => s.qual === qual);
}

/** 根据调用名找候选定义；receiver 是点号前面那一段（如 scheduler），用来排序。 */
export function resolveCall(commit: string, name: string, receiver?: string): Symbol[] {
  const c = allSymbols(commit).filter((s) => s.kind === "def" && s.name === name);
  if (!receiver) return c;
  const r = receiver.replace(/_/g, "").toLowerCase();
  return c.sort((a, b) => score(b) - score(a));
  function score(s: Symbol) {
    const cls = s.qual.split(".").slice(-2, -1)[0]?.toLowerCase() ?? "";
    return cls && (cls.includes(r) || r.includes(cls)) ? 1 : 0;
  }
}

/** 含有给定行的最内层符号 */
export function symbolAt(commit: string, path: string, line: number): Symbol | undefined {
  return symbols(commit, path)
    .filter((s) => s.start <= line && line <= s.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}
