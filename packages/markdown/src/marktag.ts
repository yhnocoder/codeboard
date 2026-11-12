// Typed or pasted <mark>…</mark> becomes the one highlight syntax, ==…==
/**
 * `<mark>x</mark>` (no attributes, on one line, nothing nested) → `==x==`, spaces at its ends moved outside: the highlight has one
 * way to be written. Code (fenced, indented, inline) and HTML blocks stay as written, so does a `<mark>` the == form cannot say the
 * same way (== in it or touching it, an escaped one). Core's old-file upgrade (migrate.ts) does the same to notes saved before
 */
export function markTags(md: string): string {
  if (!/<mark>/i.test(md)) return md;
  const out: string[] = [];
  let run: string[] = [],
    fence = "",
    html = false;
  const flush = () => {
    if (run.length) out.push(markText(run.join("\n")));
    run = [];
  };
  const fixed = (l: string) => {
    flush();
    out.push(l);
  };
  for (const l of md.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) {
      fixed(l);
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(l)) fence = "";
    } else if (f) {
      fence = f[1];
      fixed(l);
    } else if (html) {
      fixed(l);
      html = !!l.trim();
    } else if (/^ {0,3}<[A-Za-z/!?]/.test(l) && !/^ {0,3}<mark>/i.test(l)) {
      html = true;
      fixed(l);
    } else if (/^( {4}|\t)/.test(l) && !(run.length && run[run.length - 1].trim())) fixed(l);
    else run.push(l);
  }
  flush();
  return out.join("\n");
}
/** Lines of text (no code or HTML blocks): inline code spans skipped */
function markText(src: string): string {
  let out = "",
    i = 0;
  while (i < src.length) {
    const tick = src.indexOf("`", i),
      end = tick < 0 ? src.length : tick;
    out += src.slice(i, end).replace(/(\\*)<mark>([^<>\n]*)<\/mark>/gi, (whole, esc: string, x: string, at: number) => {
      const t = x.trim(),
        abs = i + at,
        before = src[abs - 1 + esc.length] ?? "",
        after = src[abs + whole.length] ?? "";
      if (esc.length % 2 || !t || t.includes("==") || /^=|[=\\]$/.test(t) || before === "=" || after === "=")
        return whole;
      return `${esc}${x.slice(0, x.length - x.trimStart().length)}==${t}==${x.slice(x.trimEnd().length)}`;
    });
    if (tick < 0) break;
    const n = /^`+/.exec(src.slice(tick))![0].length,
      close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`).exec(src.slice(tick + n));
    const stop = close ? tick + n + close.index + n : tick + n;
    out += src.slice(tick, stop);
    i = stop;
  }
  return out;
}
