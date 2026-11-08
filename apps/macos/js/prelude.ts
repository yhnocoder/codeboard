// Before any other module of the bundle runs: the tree-sitter runtime (Emscripten, in @codeboard/analysis) wants its script's URL as
// it loads, from `__filename` through Node's `url` module or from a `document`. JavaScriptCore has neither, and a fake `document`
// would send the Markdown libraries down their DOM paths, so it gets the Node pair: a file name and a `require` that knows `url`
const g = globalThis as { __filename?: string; require?: (m: string) => unknown };
if (typeof g.__filename === "undefined" && typeof g.require === "undefined") {
  g.__filename = "bridge.js";
  g.require = (m: string) => {
    if (m === "url") return { pathToFileURL: (f: string) => ({ href: `file:///${f}` }) };
    throw new Error(`require("${m}") is not available in the app`);
  };
}
