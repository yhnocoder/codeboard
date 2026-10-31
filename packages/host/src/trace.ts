// A pasted traceback: each frame's file is found in the workspace (the printed path may be from another machine or checkout, so
// by the longest matching tail of the path), its line checked against the printed source line (code that moved a few lines is
// followed), and the function around it made into a card. Frames in libraries, or in files this workspace does not have, are null
import * as path from "node:path";
import type { TraceFrame, TraceHit } from "@codeboard/core";
import { analysisOf } from "./analysis";
import { cardsFromPlan, symCard, withViews } from "./cards";
import { locOfFile } from "./source";
import { CODE_EXCLUDE, CODE_GLOB, exists, inWorkspace, inExcludedDir, langOf, readText, splitLines, workspace } from "./ws";

/** How far from the printed line the printed source line is looked for, when the file changed since the traceback */
const DRIFT = 40;
/** Lines shown around a frame that ran outside any function (a script's top level) */
const MODULE_CONTEXT = 4;

export async function traceCards(frames: TraceFrame[]): Promise<(TraceHit | null)[]> {
  let all: string[] | undefined;
  const files = async () => (all ??= await workspace().files.findFiles(CODE_GLOB, CODE_EXCLUDE, 20000));
  const found = new Map<string, string | null>();
  const out: (TraceHit | null)[] = [];
  for (const f of frames) {
    if (!found.has(f.file)) found.set(f.file, await locate(f.file, files));
    const abs = found.get(f.file);
    out.push(abs ? await frameCard(abs, f) : null);
  }
  return out;
}

/** Where Python keeps installed packages and its own library: a frame there is not the project's code, even when the workspace
 *  happens to have a file with the same tail */
const LIBRARY = /[\\/](site-packages|dist-packages)[\\/]|[\\/]lib[\\/]python\d[\w.]*[\\/]|^<frozen /;

async function locate(file: string, files: () => Promise<string[]>): Promise<string | null> {
  if (LIBRARY.test(file)) return null;
  if (path.isAbsolute(file) && inWorkspace(file) && !inExcludedDir(file) && (await exists(file))) return file;
  const want = file.split(/[\\/]/).filter((p) => p && p !== ".");
  if (!want.length) return null;
  // the deepest match of the path's tail: at least a folder and the file name, or the whole path of a file at the workspace's top
  let best: string | null = null, bestN = 0;
  for (const abs of await files()) {
    const root = workspace().files.rootOf(abs);
    const have = (root ? path.relative(root, abs) : abs).split(/[\\/]/);
    let n = 0;
    while (n < want.length && n < have.length && want[want.length - 1 - n] === have[have.length - 1 - n]) n++;
    if ((n >= 2 || (n && n === have.length)) && n > bestN) { best = abs; bestN = n; }
  }
  return best;
}

async function frameCard(abs: string, f: TraceFrame): Promise<TraceHit | null> {
  const text = await readText(abs);
  if (text === null) return null;
  const lines = splitLines(text);
  const line = lineOf(lines, f);
  if (!line) return null;
  const lang = langOf(abs);
  const loc = await locOfFile(abs);
  const syms = analysisOf(lang, text).symbols.filter((s) => s.kind === "def" && s.start <= line && line <= s.end);
  // the innermost function: a nested def or a method, not the class or the outer function around it
  const sym = syms.reduce<(typeof syms)[number] | undefined>((a, s) => (!a || s.start >= a.start ? s : a), undefined);
  const card = sym
    ? await symCard(loc, lines, sym, lang)
    : (await cardsFromPlan(loc, lines, { kind: "segments", ranges: [{ start: Math.max(1, line - MODULE_CONTEXT), end: Math.min(lines.length, line + MODULE_CONTEXT), module: true }] }, lang)).cards[0];
  return { card: (await withViews([card]))[0], line };
}

/** The frame's line in the file as it is now: the printed line if its source matches (or none was printed), else the nearest
 *  line with the printed source within DRIFT; 0 when the code is not there any more */
function lineOf(lines: string[], f: TraceFrame): number {
  if (f.line < 1 || f.line > lines.length + DRIFT) return 0;
  if (!f.code) return f.line <= lines.length ? f.line : 0;
  for (let d = 0; d <= DRIFT; d++) {
    for (const l of d ? [f.line - d, f.line + d] : [f.line]) if (l >= 1 && l <= lines.length && lines[l - 1].trim() === f.code) return l;
  }
  return 0;
}
