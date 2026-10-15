// 粘贴到画布：工作区里能一字不差找到的代码 → 带位置和 commit 的代码卡；GitHub 链接 → GitHub Code 卡；
// 其他像代码的文本 → Free code（猜语言）；网址、普通文字由白板自己建 Web / Note（回 null）。
import * as vscode from "vscode";
import { classifyPaste, pythonDialect, type NewCard } from "@codeboard/core";
import { planSelection } from "@codeboard/core/analysis";
import { analysisOf } from "./analysis";
import { cardsFromPlan, freeCard, withViews } from "./cards";
import { githubCard } from "./github";
import { locOfFile } from "./source";
import { CODE_EXCLUDE, CODE_GLOB, langOf, readText, splitLines } from "./ws";

export async function pasteCard(text: string): Promise<NewCard | null> {
  const k = classifyPaste(text);
  if (k.kind === "github") return githubCard(text.trim());
  if (k.kind === "web") return null;
  const hit = await findInWorkspace(text);
  if (hit) {
    const lines = splitLines(hit.text);
    const lang = langOf(hit.abs);
    const plan = planSelection([{ startLine: hit.start, startCol: 0, endLine: hit.end, endCol: lines[hit.end - 1].length }], analysisOf(lang, hit.text));
    if (plan) {
      const built = await cardsFromPlan(await locOfFile(hit.abs), lines, plan.kind === "split" ? { kind: "segments", ranges: [plan.range] } : plan, lang);
      return (await withViews(built.cards))[0];
    }
  }
  if (k.kind === "code") {
    const lang = k.lang === "python" ? pythonDialect(text) : k.lang;
    return (await withViews([freeCard(text.replace(/\s+$/, ""), lang)]))[0];
  }
  return null;
}

const norm = (l: string) => l.replace(/\s+$/, "");

/** 在打开的文档和工作区代码文件里找这段文本（第一行可以只是行尾一部分：从行中间开始复制的） */
export async function findInWorkspace(text: string): Promise<{ abs: string; text: string; start: number; end: number } | null> {
  const block = splitLines(text).map(norm);
  while (block.length && !block[0].trim()) block.shift();
  while (block.length && !block[block.length - 1].trim()) block.pop();
  if (!block.length || block.join("").replace(/\s/g, "").length < 12) return null;
  const match = (abs: string, t: string) => {
    const probe = (block.find((l, i) => i > 0 && l.trim().length > 3) ?? block[0]).trim();
    if (!t.includes(probe)) return null;
    const lines = splitLines(t).map(norm);
    for (let i = 0; i + block.length <= lines.length; i++) {
      if (!lines[i].endsWith(block[0].trimStart())) continue;
      let ok = true;
      for (let k = 1; k < block.length && ok; k++) ok = lines[i + k] === block[k];
      if (ok) return { abs, text: t, start: i + 1, end: i + block.length };
    }
    return null;
  };
  for (const d of vscode.workspace.textDocuments) {
    if (d.uri.scheme !== "file") continue;
    const r = match(d.uri.fsPath, d.getText());
    if (r) return r;
  }
  const files = await vscode.workspace.findFiles(CODE_GLOB, CODE_EXCLUDE, 4000);
  for (const f of files) {
    const t = await readText(f.fsPath);
    const r = t && match(f.fsPath, t);
    if (r) return r;
  }
  return null;
}

