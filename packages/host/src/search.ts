import * as path from "node:path";
import {
  allCodeCards,
  cardTitle,
  computeFlows,
  fuzzy,
  guessLang,
  substr,
  type GenSource,
  type NameHit,
  type NewCard,
  type SearchItem,
} from "@codeboard/core";
import { codeExts, LANG_TABLE } from "@codeboard/analysis/langs";
import { escapeRegExp } from "@codeboard/analysis/basics";
import { initExports, moduleFiles, pyprojectScripts } from "@codeboard/analysis";
import { analysisOf } from "./analysis";
import { cardForFileSym, freeCard, newCodeCard, withViews } from "./cards";
import { locOfFile } from "./source";
import { allNames, grepWord, lookupName } from "./nameindex";
import type { Storage } from "./storage";
import { makeSegment } from "./versions";
import { CODE_EXCLUDE, exists, fromHostPath, hostPath, langOf, readText, splitLines, workspace, wsRoots } from "./ws";

/**
 * ⌘K：所有白板上的卡和 Sidenote（here = 发起搜索的白板，排在前面），工作区的符号和文件。
 * 共享卡在几块白板上只列一次：在这块白板上就跳这里，否则跳第一块；detail 写出它在哪几块白板上。跟着共享卡走的 Sidenote 也只列一次
 */
export async function search(
  store: Storage,
  q: string,
  scope: "all" | "code" | "symbols" = "all",
  here?: string,
): Promise<SearchItem[]> {
  const scored: { s: number; item: SearchItem }[] = [];
  if (scope === "all") {
    const boards = (await store.all()).map((x) => x.board).sort((a, b) => (a.id === here ? -1 : b.id === here ? 1 : 0));
    const seen = new Map<string, Extract<SearchItem, { kind: "card" }>>();
    const seenNotes = new Set<string>();
    for (const board of boards) {
      const refs = store.refsOf(board.id);
      let flows: ReturnType<typeof computeFlows> | undefined;
      board.cards.forEach((c) => {
        if (
          !board.place[c.id] &&
          c.kind === "code" &&
          board.cards.some((k) => k.kind === "compare" && k.cols.includes(c.id))
        )
          return; // Compare 的栏
        const shared = refs.has(c.id);
        const prev = shared ? seen.get(c.id) : undefined;
        if (prev) {
          prev.detail = `${prev.detail} · ${board.name}`;
          return;
        }
        const t = cardTitle(c);
        const body = c.kind === "note" ? c.md : c.kind === "code" ? c.segments.map((s) => s.path).join(" ") : "";
        const s = Math.max(fuzzy(q, t), body.toLowerCase().includes(q.toLowerCase()) ? 20 : -1);
        if (s < 0) return;
        flows ??= computeFlows(board);
        const num = flows.byId.get(c.id)?.label || undefined;
        const item: Extract<SearchItem, { kind: "card" }> = {
          kind: "card",
          label: t,
          detail: `${shared ? "⧉ " : ""}${board.id === here ? "This board" : board.name}`,
          board: board.id,
          card: c.id,
          num,
        };
        if (shared) seen.set(c.id, item);
        scored.push({ s: s + 30 + (board.id === here ? 5 : 0), item });
      });
      for (const n of board.sidenotes ?? []) {
        if (refs.has(n.at.card) && !n.boardOnly && n.kind !== "card") {
          if (seenNotes.has(n.id)) continue;
          seenNotes.add(n.id);
        }
        const t =
          n.kind === "text"
            ? n.md
            : n.kind === "code"
              ? n.code.text.join("\n")
              : n.kind === "paste"
                ? n.text
                : n.kind === "link"
                  ? `${n.title ?? ""} ${n.url}`
                  : "";
        if (!t || !t.toLowerCase().includes(q.toLowerCase())) continue;
        const host = allCodeCards(board).find((c) => c.id === n.at.card) ?? board.cards.find((c) => c.id === n.at.card);
        scored.push({
          s: 25,
          item: {
            kind: "sidenote",
            label: t
              .split("\n")
              .find((l) => l.toLowerCase().includes(q.toLowerCase()))!
              .trim()
              .slice(0, 80),
            detail: `${board.name}${host ? ` · ${cardTitle(host)}` : ""}`,
            board: board.id,
            card: n.at.card,
            sidenote: n.id,
          },
        });
      }
    }
  }
  if (q.trim()) {
    for (const ents of await allNames())
      for (const e of ents) {
        // 子串（名字或带类名的全名里）排前面；子序列只配名字本身，而且要配得紧（fuzzy）
        const n = fuzzy(q, e.name),
          s = Math.max(n < 0 ? -1 : n + 5, substr(q, e.qual));
        if (s < 0) continue;
        scored.push({
          s,
          item: {
            kind: "symbol",
            label: e.qual,
            detail: `${hostPath(e.abs)}:${e.defLine}`,
            path: hostPath(e.abs),
            line: e.defLine,
            sym: e.qual,
            glyph: e.kind === "class" ? "C" : "ƒ",
          },
        });
      }
    if (scope !== "symbols") {
      const files = await workspace().files.findFiles(`**/*${q.replace(/[^\w.-]/g, "")}*`, CODE_EXCLUDE, 200);
      for (const f of files) {
        const rel = hostPath(f);
        const s = fuzzy(q, path.basename(rel));
        if (s >= 0)
          scored.push({ s: s - 5, item: { kind: "file", label: path.basename(rel), detail: rel, path: rel } });
      }
    }
  }
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map((x) => x.item);
}

/** 选中一条结果：符号 / 文件 / 入口 → 新卡（Sidenote 还是卡由白板决定）；卡和 Sidenote 白板自己处理 */
export async function searchPick(item: SearchItem): Promise<NewCard | null> {
  if (item.kind === "symbol" || (item.kind === "entry" && item.sym)) {
    const abs = fromHostPath(item.path);
    const text = await readText(abs);
    if (text === null) return null;
    const syms = analysisOf(langOf(abs), text).symbols;
    const sym =
      syms.find((s) => s.qual === item.sym && s.defLine === item.line) ?? syms.find((s) => s.qual === item.sym);
    return sym ? cardForFileSym(abs, sym) : null;
  }
  if (item.kind === "entry") return fileRangeCard(fromHostPath(item.path), item.line, item.end ?? item.line);
  if (item.kind === "file") return fileTopCard(fromHostPath(item.path));
  return null;
}

async function fileRangeCard(abs: string, start: number, end: number): Promise<NewCard | null> {
  const text = await readText(abs);
  if (text === null) return null;
  const lines = splitLines(text);
  const lang = langOf(abs);
  const syms = analysisOf(lang, text).symbols;
  const scope = syms
    .filter((s) => s.start <= start && end <= s.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0]?.qual;
  const seg = await makeSegment(await locOfFile(abs), lines, start, Math.min(end, lines.length), {
    lang,
    scope,
    symbol: scope ? undefined : { qual: "<module>", kind: "module" },
  });
  return (await withViews([newCodeCard([seg])]))[0];
}

/** 文件 → 模块顶部（第一个函数 / 类之前）；没有符号的短文件整个放上来 */
async function fileTopCard(abs: string): Promise<NewCard | null> {
  const text = await readText(abs);
  if (text === null) return null;
  const lines = splitLines(text);
  const lang = langOf(abs);
  if (lang === "plaintext") return (await withViews([freeCard(lines.slice(0, 200).join("\n"), "plaintext")]))[0];
  const first = analysisOf(lang, text).symbols[0];
  let end = first ? first.start - 1 : Math.min(lines.length, 200);
  while (end > 1 && !lines[end - 1].trim()) end--;
  if (end < 1) end = Math.min(lines.length, first ? first.end : 200);
  return fileRangeCard(abs, 1, end);
}

/** Start from Entry Point…（只做 Python）：pyproject 脚本、包 __init__ 导出、__main__ 块 */
export async function entryPoints(): Promise<SearchItem[]> {
  const out: SearchItem[] = [];
  const seen = new Set<string>();
  const add = (it: SearchItem & { kind: "entry" }) => {
    const k = `${it.path}:${it.line}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  };
  const symIn = async (abs: string, qual: string) => {
    const t = await readText(abs);
    return t === null ? undefined : analysisOf("python", t).symbols.find((s) => s.qual === qual);
  };
  for (const root of wsRoots()) {
    // pyproject [project.scripts]
    const toml = await readText(path.join(root, "pyproject.toml"));
    if (toml)
      for (const s of pyprojectScripts(toml)) {
        for (const cand of moduleFiles(s.module)) {
          const abs = path.join(root, cand);
          const sym = await symIn(abs, s.func);
          if (sym) {
            add({
              kind: "entry",
              label: sym.qual,
              detail: `script “${s.name}” · pyproject.toml`,
              path: hostPath(abs),
              line: sym.defLine,
              sym: sym.qual,
            });
            break;
          }
        }
      }
  }
  // 包 __init__.py 里导出的公共 API（浅层包）
  const inits = await workspace().files.findFiles(
    "{*/__init__.py,*/*/__init__.py,src/*/__init__.py}",
    CODE_EXCLUDE,
    50,
  );
  for (const u of inits) {
    const text = await readText(u);
    if (!text) continue;
    const dir = path.dirname(u);
    for (const ex of initExports(text)) {
      if (!ex.from.startsWith(".")) continue;
      for (const cand of moduleFiles(ex.from)) {
        const abs = path.join(dir, cand);
        if (!(await exists(abs))) continue;
        const sym = await symIn(abs, ex.name);
        if (sym)
          add({
            kind: "entry",
            label: sym.qual,
            detail: `exported from ${hostPath(u)}`,
            path: hostPath(abs),
            line: sym.defLine,
            sym: sym.qual,
          });
        break;
      }
    }
  }
  // __main__ 块和示例脚本
  const scripts = await workspace().files.findFiles(
    "{*.py,examples/**/*.py,example/**/*.py,scripts/*.py,*/__main__.py}",
    CODE_EXCLUDE,
    200,
  );
  for (const u of scripts) {
    const text = await readText(u);
    if (!text) continue;
    const a = analysisOf("python", text);
    for (const b of a.mainBlocks)
      add({
        kind: "entry",
        label: path.basename(u),
        detail: `${hostPath(u)} · if __name__ == "__main__"`,
        path: hostPath(u),
        line: b.start,
        end: b.end,
      });
    if (!a.mainBlocks.length && path.basename(u) === "__main__.py")
      add({
        kind: "entry",
        label: hostPath(u),
        detail: "python -m",
        path: hostPath(u),
        line: 1,
        end: Math.min(splitLines(text).length, 80),
      });
  }
  // __main__ 块里调用的 main() 之类
  for (const it of [...out]) {
    if (it.kind !== "entry" || it.sym || !it.end) continue;
    const abs = fromHostPath(it.path);
    const text = await readText(abs);
    if (!text) continue;
    const a = analysisOf("python", text);
    const main = a.calls.find(
      (c) => c.line >= it.line && c.line <= it.end! && !c.recv && a.symbols.some((s) => s.qual === c.name),
    );
    const sym = main && a.symbols.find((s) => s.qual === main.name);
    if (sym)
      add({
        kind: "entry",
        label: sym.qual,
        detail: `called from ${path.basename(abs)}:${main!.line}`,
        path: it.path,
        line: sym.defLine,
        sym: sym.qual,
      });
  }
  return out;
}

/** 叫这个名字的定义（名字索引，所有语言）+ 字符串里的这个名字（"unified_attention"：注册表、绑定），按语言排 */
export async function searchName(name: string): Promise<NameHit[]> {
  const out: NameHit[] = [];
  for (const e of await lookupName(name)) {
    out.push({
      lang: langOf(e.abs),
      label: e.sig,
      detail: `${hostPath(e.abs)}:${e.defLine}`,
      path: hostPath(e.abs),
      line: e.defLine,
      def: true,
      qual: e.qual,
    });
  }
  const re = new RegExp(`["']${escapeRegExp(name)}["(.']`);
  let refs = 0;
  for (const { abs, text } of await grepWord(name)) {
    const lines = splitLines(text);
    for (let i = 0; i < lines.length && refs < 40; i++) {
      if (!re.test(lines[i])) continue;
      refs++;
      out.push({
        lang: langOf(abs),
        label: lines[i].trim().slice(0, 120),
        detail: `${hostPath(abs)}:${i + 1}`,
        path: hostPath(abs),
        line: i + 1,
        def: false,
      });
    }
  }
  // 按语言表的顺序排（Python 在前），表里没有的放最后
  const k = (h: NameHit) => {
    const i = LANG_TABLE.findIndex((l) => l.id === h.lang);
    return i < 0 ? LANG_TABLE.length : i;
  };
  return out
    .map((h, i) => [h, i] as const)
    .sort((a, b) => k(a[0]) - k(b[0]) || Number(b[0].def) - Number(a[0].def) || a[1] - b[1])
    .map(([h]) => h);
}

/** 选文件的过滤：代码文件，再加上编译器的中间产物和日志 */
const GEN_EXT = [...codeExts(), "ptx", "ll", "mlir", "txt", "log"];

/** 剪贴板或选一个文件：文本、语言（按扩展名，认不出按内容猜）、文件名 */
export async function genSource(from: "clipboard" | "file"): Promise<GenSource | null> {
  const ui = workspace().ui;
  if (from === "clipboard") {
    const text = await ui.clipboard();
    return text.trim() ? { text, lang: guessLang(text) ?? "plaintext", name: "" } : null;
  }
  const f = await ui.openDialog({
    filters: { "Generated code": GEN_EXT, "All files": ["*"] },
    label: "Add Generated Card",
    title: "Choose generated code (Inductor output, CUDA source, PTX…)",
  });
  if (!f) return null;
  const text = await readText(f, false);
  if (text === null) return null;
  const l = langOf(f);
  return { text, lang: l === "plaintext" ? (guessLang(text) ?? "plaintext") : l, name: f };
}
