// Code colours for the app's Code cards: shiki with its JavaScript regex engine (no wasm, runs in JavaScriptCore), the tokens
// mapped to the board's colour classes (core tokenClass: kw, fn, str, com, num, self, p) the way the host's highlight.ts does.
// The segments carry their text, so nothing is read from a repository (Code cards are read-only in the app).
import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore, type LanguageInput } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { fingerprint, tokenClass } from "@codeboard/core";

/** A token: text and its colour class (none = plain) */
export type SceneTok = [string, string?];

// VS Code language ids → the shiki grammar; CUDA and C are coloured as C++ (the host uses tree-sitter for them; the app has no wasm)
const GRAMMAR: Record<string, [string, LanguageInput]> = {
  python: ["python", () => import("shiki/langs/python.mjs")],
  cpp: ["cpp", () => import("shiki/langs/cpp.mjs")],
  "cuda-cpp": ["cpp", () => import("shiki/langs/cpp.mjs")],
  c: ["cpp", () => import("shiki/langs/cpp.mjs")],
  rust: ["rust", () => import("shiki/langs/rust.mjs")],
  typescript: ["typescript", () => import("shiki/langs/typescript.mjs")],
  javascript: ["javascript", () => import("shiki/langs/javascript.mjs")],
  go: ["go", () => import("shiki/langs/go.mjs")],
  java: ["java", () => import("shiki/langs/java.mjs")],
  shellscript: ["shellscript", () => import("shiki/langs/shellscript.mjs")],
  json: ["json", () => import("shiki/langs/json.mjs")],
  yaml: ["yaml", () => import("shiki/langs/yaml.mjs")],
};

const plain = (lines: string[]): SceneTok[][] => lines.map((l) => [[l]]);

export class Highlight {
  private hl: Promise<HighlighterCore> | undefined;
  private loaded = new Map<string, Promise<unknown>>();
  private cache = new Map<string, SceneTok[][]>();
  private theme = createCssVariablesTheme({ name: "codeboard", variablePrefix: "--shiki-", fontStyle: true });

  /** Tokens per line; cached by the text's fingerprint */
  async tokens(lang: string, lines: string[]): Promise<SceneTok[][]> {
    const g = GRAMMAR[lang];
    if (!g) return plain(lines);
    const text = lines.join("\n");
    const k = `${g[0]}\0${text.length}\0${fingerprint(text)}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    let out: SceneTok[][];
    try {
      const h = await (this.hl ??= createHighlighterCore({
        themes: [this.theme],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }));
      let p = this.loaded.get(g[0]);
      if (!p) this.loaded.set(g[0], (p = h.loadLanguage(g[1])));
      await p;
      out = h.codeToTokens(text, { lang: g[0], theme: "codeboard" }).tokens.map((line) =>
        line.map((t) => {
          const cls = tokenClass(t.color, t.content);
          return cls ? [t.content, cls] : [t.content];
        }),
      );
      while (out.length < lines.length) out.push([[""]]);
    } catch {
      out = plain(lines);
    }
    if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(k, out);
    return out;
  }
}
