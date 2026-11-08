// Code colours for the app's Code cards: the host's Highlighter (packages/host/src/highlight.ts), so a card is coloured exactly as in
// VS Code: shiki with its JavaScript regex engine for the languages the language table gives it, tree-sitter (the analysis
// package's wasm, read through the shell: JavaScriptCore has WebAssembly but no file paths) for C / C++ / CUDA. A grammar is
// loaded the first time a card in its language is drawn, never before (the CUDA one is 9 MB).
import { highlightLines, initAnalysis } from "@codeboard/analysis";
import type { Tok } from "@codeboard/core";
import { Highlighter } from "@codeboard/host/highlight";

/** A token: text and its colour class (none = plain) */
export type SceneTok = [string, string?];

export function makeHighlighter(readWasm: (file: string) => Promise<Uint8Array>) {
  const grammars = new Map<string, Promise<boolean>>();
  const hl = new Highlighter({
    async treeLines(g, text, tree) {
      // without its grammar (no wasm beside the app) the lines stay plain
      let p = grammars.get(g);
      if (!p) {
        p = initAnalysis(readWasm, [g]).then(
          () => true,
          (e) => (console.error(`tree-sitter ${g}: ${e instanceof Error ? e.message : e}`), false),
        );
        grammars.set(g, p);
      }
      return (await p) ? highlightLines(g, text, tree) : null;
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
