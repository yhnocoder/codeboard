// Shared by the host tests: start tree-sitter, build a card for a symbol, find a line in a segment, small git repos, a board view stub
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Emitter, type CodeCard, type HostToBoard, type Segment } from "@codeboard/core";
import { analysisOf, startAnalysis } from "../src/analysis";
import { cardForFileSym } from "../src/cards";
import type { BoardView } from "../src/boards";
import { langOf } from "../src/ws";

export const REPO = path.resolve(__dirname, "../../..");
export const startTreeSitter = () => startAnalysis();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A card for the symbol `qual` in a file (as Add Function would make it) and its first segment */
export async function card(abs: string, qual: string, text = fs.readFileSync(abs, "utf8")): Promise<{ card: CodeCard; seg: Segment }> {
  const sym = analysisOf(langOf(abs), text).symbols.find((s) => s.qual === qual);
  if (!sym) throw new Error(`${qual} not in ${abs}`);
  const c = (await cardForFileSym(abs, sym))!.card as CodeCard;
  return { card: c, seg: c.segments[0] };
}
/** The file line of the first segment line matching re */
export const lineOf = (seg: Segment, re: RegExp) => seg.start + seg.text.findIndex((l) => re.test(l));
/** A click position on `word` in the first line of seg matching re */
export const at = (seg: Segment, re: RegExp, word: string) => { const line = lineOf(seg, re); return { seg, line, col: seg.text[line - seg.start].indexOf(word) }; };

/** git in cwd with a fixed identity; returns trimmed stdout */
export const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...a], { cwd, stdio: "pipe" }).toString().trim();
/** A new git repo in a temp dir with files, committed on main */
export function tempRepo(prefix: string, files: Record<string, string>): string {
  const r = fs.mkdtempSync(`/tmp/codeboard-${prefix}-`);
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), t); }
  git(r, "init", "-q", "-b", "main"); git(r, "add", "-A"); git(r, "commit", "-qm", "base");
  return r;
}

/** A board view that records what the host posts; fire its events from the test */
export function stubView(o: { visible?: boolean; active?: boolean } = {}) {
  const posted: HostToBoard[] = [];
  const message = new Emitter<Parameters<Parameters<BoardView["onMessage"]>[0]>[0]>(), activate = new Emitter<void>(), dispose = new Emitter<void>();
  const view: BoardView = {
    postMessage: (m) => { posted.push(m); }, title: "", visible: o.visible ?? true, active: o.active ?? true,
    reveal: () => undefined, focus: async () => undefined, dispose: () => dispose.fire(), resourceUrl: () => "",
    onMessage: message.event, onDidActivate: activate.event, onDidDispose: dispose.event,
  };
  return { view, posted, message, activate, dispose };
}
