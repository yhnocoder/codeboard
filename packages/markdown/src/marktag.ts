// Typed or pasted <mark>…</mark> becomes the one highlight syntax, ==…==
/**
 * `<mark>x</mark>` (no attributes, on one line, nothing nested) → `==x==`, spaces at its ends moved outside: the highlight has one
 * way to be written. Code (fenced, indented, inline), formulas and HTML blocks stay as written, so does a `<mark>` the == form
 * cannot say the same way (== in it or touching it, an escaped one, one right after another). Core's old-file upgrade
 * (migrate.ts) does the same to notes saved before
 */
export function markTags(md: string): string {
  if (!/<mark>/i.test(md)) return md;
  const out: string[] = [];
  let run: string[] = [],
    fence = "",
    cont = "",
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
    // inside a fence only its own container's prefix comes off a line (a "- ```" or an indented ``` there is code); a line
    // without that prefix ends the container, and the fence with it
    if (fence && (l.startsWith(cont) || !l.trim())) {
      fixed(l);
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(l.slice(cont.length))) fence = "";
      continue;
    }
    fence = "";
    // a fence may stand in a list item or a quote: its container's markers and indent come first
    const inner = l.replace(CONTAINER, ""),
      f = /^(`{3,}|~{3,})/.exec(inner);
    if (f) {
      fence = f[1];
      cont = contOf(l.slice(0, l.length - inner.length));
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
/** A line's list and quote markers and its indent */
const CONTAINER = /^(?:\s*(?:>|[-+*](?=\s)|\d{1,9}[.)](?=\s)))*\s*/;
/** What the lines inside a fence opened after this prefix start with: its quote markers (list markers and indents trimmed:
 *  up to 3 spaces before a closing fence are allowed anyway, and a fence kept open longer only leaves a <mark> as it is) */
const contOf = (prefix: string) => prefix.replace(/[-+*]|\d{1,9}[.)]/g, (m) => " ".repeat(m.length)).trimEnd();

/** Lines of text (no code or HTML blocks): inline code spans and formulas skipped */
function markText(src: string): string {
  let out = "",
    i = 0,
    // where the last rewritten <mark> ended: one right after it stays as written (==a====b== would read as one run)
    last = -1;
  const marks = (from: number, to: number) =>
    src
      .slice(from, to)
      .replace(/(?<!\\)(\\*)<mark>([^<>\n]*)<\/mark>/gi, (whole, esc: string, x: string, at: number) => {
        const t = x.trim(),
          abs = from + at,
          before = src[abs - 1 + esc.length] ?? "",
          after = src[abs + whole.length] ?? "";
        if (
          esc.length % 2 ||
          !t ||
          t.includes("==") ||
          /^=|[=\\]$/.test(t) ||
          before === "=" ||
          after === "=" ||
          abs === last
        )
          return whole;
        last = abs + whole.length;
        return `${esc}${x.slice(0, x.length - x.trimStart().length)}==${t}==${x.slice(x.trimEnd().length)}`;
      });
  while (i < src.length) {
    const at = skipAt(src, i);
    if (!at) {
      out += marks(i, src.length);
      break;
    }
    out += marks(i, at[0]) + src.slice(at[0], at[1]);
    i = at[1];
  }
  return out;
}
/** The next inline code span or formula from i on, as [start, end]: none when there is no ` or unescaped $ left */
function skipAt(src: string, i: number): [number, number] | null {
  const re = /`+|(?<!\\)\$\$?/g;
  re.lastIndex = i;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const s = m.index,
      d = m[0];
    if (d[0] === "`") {
      const close = new RegExp(`(?<!\`)\`{${d.length}}(?!\`)`).exec(src.slice(s + d.length));
      return [s, close ? s + d.length + close.index + d.length : s + d.length];
    }
    // a formula ends at the same $ or $$ before a blank line; an unclosed $ is a dollar sign
    const rest = src.slice(s + d.length),
      para = rest.search(/\n\s*\n/),
      close = new RegExp(`(?<!\\\\)${d === "$$" ? "\\$\\$" : "\\$(?!\\$)"}`).exec(
        para < 0 ? rest : rest.slice(0, para),
      );
    if (close) return [s, s + d.length + close.index + d.length];
    re.lastIndex = s + d.length;
  }
  return null;
}
