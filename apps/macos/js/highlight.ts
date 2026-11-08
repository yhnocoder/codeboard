// Code colours for the app's Code cards: the host's Highlighter (packages/host/src/highlight.ts), so a card is coloured exactly as in
// VS Code: shiki with its JavaScript regex engine for the languages the language table gives it, tree-sitter (the analysis
// package's wasm, read through the shell: JavaScriptCore has WebAssembly but no file paths) for C / C++ / CUDA. A grammar is
// loaded the first time a card in its language is drawn, never before (the CUDA one is 9 MB).
import { highlightLines, initAnalysis } from "@codeboard/analysis";
import { type Grammar, grammarOf, langInfo } from "@codeboard/analysis/langs";
import type { Tok } from "@codeboard/core";
import { Highlighter } from "@codeboard/host/highlight";

/** A token: text and its colour class (none = plain) */
export type SceneTok = [string, string?];

export function makeHighlighter(readWasm: (file: string) => Promise<Uint8Array>) {
  const grammars = new Map<string, Promise<boolean>>();
  const loaded = new Set<Grammar>();
  /** The grammar's load, started the first time it is asked for; false when it is not there (no wasm beside the app) */
  function grammar(g: Grammar): Promise<boolean> {
    let p = grammars.get(g);
    if (!p) {
      p = initAnalysis(readWasm, [g]).then(
        () => (loaded.add(g), true),
        (e) => (console.error(`tree-sitter ${g}: ${e instanceof Error ? e.message : e}`), false),
      );
      grammars.set(g, p);
    }
    return p;
  }
  const hl = new Highlighter({
    async treeLines(g, text, tree) {
      return (await grammar(g)) ? highlightLines(g, text, tree) : null;
    },
  });
  return {
    /** The lines' tokens. With `wait` false, a language whose tree-sitter grammar is still loading (the CUDA one compiles for
     *  ~130 ms) gives null instead, and the load goes on: `ready()` resolves when it is there */
    async tokens(lang: string, lines: string[], wait = true): Promise<SceneTok[][] | null> {
      if (!wait && langInfo(lang)?.highlight?.by === "tree-sitter") {
        const g = grammarOf(lang);
        if (g && !loaded.has(g)) {
          void grammar(g);
          return null;
        }
      }
      const toks = await hl.tokensOf(lang, lines.join("\n"));
      const out = toks.map((line: Tok[]) => line.map((t): SceneTok => (t.cls ? [t.text, t.cls] : [t.text])));
      while (out.length < lines.length) out.push([[lines[out.length]]]);
      return out;
    },
    ready: () => Promise.all(grammars.values()).then(() => {}),
  };
}
export type Highlight = ReturnType<typeof makeHighlighter>;
