// Start from Entry Point…：找 Python 项目的入口（__main__ 块、pyproject 脚本、包导出的公共 API）。
// 这里只做文本解析，读文件、找符号由宿主做。

/** pyproject.toml 的 [project.scripts]：name = "pkg.mod:func" */
export function pyprojectScripts(toml: string): { name: string; module: string; func: string }[] {
  const out: { name: string; module: string; func: string }[] = [];
  let inSec = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { inSec = /^\[(project\.scripts|tool\.poetry\.scripts)\]$/.test(line); continue; }
    if (!inSec) continue;
    const m = /^["']?([\w.-]+)["']?\s*=\s*["']([\w.]+):([\w.]+)["']/.exec(line);
    if (m) out.push({ name: m[1], module: m[2], func: m[3] });
  }
  return out;
}

/** 包 __init__.py 里导出的名字：from .llm import LLM / from .x import (A, B as C) / __all__ */
export function initExports(text: string): { name: string; from: string }[] {
  const out: { name: string; from: string }[] = [];
  const src = text.replace(/\(\s*([^)]*)\)/gs, (_m, inner: string) => inner.replace(/\s+/g, " "));
  for (const line of src.split(/\r?\n/)) {
    const m = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    for (const part of m[2].split(",")) {
      const p = part.trim().replace(/#.*$/, "");
      if (!p || p === "*") continue;
      const [orig, alias] = p.split(/\s+as\s+/);
      out.push({ name: (alias ?? orig).trim(), from: m[1] });
    }
  }
  return out;
}

/** 模块路径 a.b.c → 相对文件路径候选 */
export const moduleFiles = (mod: string, base = "") => {
  const p = (base ? base + "/" : "") + mod.replace(/^\.+/, "").split(".").join("/");
  return [`${p}.py`, `${p}/__init__.py`];
};
