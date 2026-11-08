// Code colours for the app's Code cards: the host's Highlighter (packages/host/src/highlight.ts), so a card is coloured exactly as in
// VS Code: shiki with its JavaScript regex engine for the languages the language table gives it, tree-sitter (the analysis
// package's wasm, read through the shell: JavaScriptCore has WebAssembly but no file paths) for C / C++ / CUDA.
import { highlightLines, initAnalysis } from "@codeboard/analysis";
import { Highlighter } from "@codeboard/host/highlight";
import type { Tok } from "@codeboard/core";

/** A token: text and its colour class (none = plain) */
export type SceneTok = [string, string?];

export function makeHighlighter(readWasm: (file: string) => Promise<Uint8Array>) {
  let parsers: Promise<boolean> | undefined;
  const hl = new Highlighter({
    async treeLines(g, text, tree) {
      // the grammars load the first time they are needed; without them (no wasm beside the app) the lines stay plain
      parsers ??= initAnalysis(readWasm).then(
        () => true,
        (e) => (console.error("tree-sitter: " + (e instanceof Error ? e.message : e)), false),
      );
      return (await parsers) ? highlightLines(g, text, tree) : null;
    },
  });
  return {
    async tokens(lang: string, lines: string[]): Promise<SceneTok[][]> {
      const toks = await hl.tokensOf(lang, lines.join("\n"));
      const out = toks.map((line: Tok[]) => line.map((t): SceneTok => (t.cls ? [t.text, t.cls] : [t.text])));
      while (out.length < lines.length) out.push([[lines[out.length]]]);
      return out;
    },
  };
}
export type Highlight = ReturnType<typeof makeHighlighter>;
