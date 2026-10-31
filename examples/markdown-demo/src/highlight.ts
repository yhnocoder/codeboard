// A small Python highlighter for the demo (a real host would use shiki or the like): text → HTML with the class names
// the package's code blocks expect from a highlighter (.kw .fn .str .com .num .self), one \n between lines
const KW = new Set(
  "def return if else elif for while in not and or import from as class with pass None True False lambda yield".split(
    " ",
  ),
);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TOKEN = /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|([\s\S])/g;

export function highlight(text: string, lang: string): string | null {
  if (lang !== "python") return null;
  let out = "",
    prev = "";
  for (const m of text.matchAll(TOKEN)) {
    const [t, com, str, num, word] = m;
    const span = (cls: string) => `<span class="${cls}">${esc(t)}</span>`;
    if (com) out += span("com");
    else if (str) out += span("str");
    else if (num) out += span("num");
    else if (word)
      out += KW.has(word) ? span("kw") : word === "self" ? span("self") : prev === "def" ? span("fn") : esc(t);
    else out += esc(t);
    if (word || /\S/.test(t)) prev = word ?? "";
  }
  return out;
}
