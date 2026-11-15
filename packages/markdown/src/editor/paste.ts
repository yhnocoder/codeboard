// Pasting into the editor: everything is written as Markdown source (code from VS Code as a code block, HTML read with the
// full schema, plain lines as paragraphs, into a table cell joined with <br>)
import type { Editor, JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { pastedMd, texBrackets } from "../schema";
import { htmlSource } from "./pastemarks";
import { undoubleTex } from "../doubled";
import { sourceDoc } from "./srcdoc";
import { revealMeta } from "./inline";
import { pasteSlice } from "./headings";
import { pastedImages } from "./image";
import { mdOf } from "./md";
import { hrefSource, linkRef } from "./links";
import { markTags } from "../marktag";
import { blockInfo, flat } from "./spans";

/** Markdown → editor blocks (source paragraphs) as a slice open at a paragraph on either end, so the first joins the
 *  text before the caret and the last the text after it */
function sourceSlice(e: Editor, md: string): Slice {
  const d = e.state.schema.nodeFromJSON(sourceDoc(md));
  const open = (n: PMNode | null) => (n?.type.name === "paragraph" ? 1 : 0);
  return new Slice(d.content, open(d.firstChild), open(d.lastChild));
}
/**
 * The Markdown a pasted address makes (null: pasted as text). On words selected in one paragraph: [those words](address), with
 * the address in <angle brackets> when it holds spaces or parentheses. On nothing, a link to an item that is there: [[its title]]
 */
function linkPaste(e: Editor, addr: string): string | null {
  const refs = mdOf(e.state).refs;
  if (!refs.link?.(addr) && !/^https?:\/\/\S+$/i.test(addr)) return null;
  const { from, to, $from, $to } = e.state.selection;
  if (from === to) {
    const ref = linkRef(addr, refs);
    return ref && `${ref} `;
  }
  if ($from.parent !== $to.parent || !$from.parent.isTextblock) return null;
  const words = e.state.doc.textBetween(from, to);
  if (!words.trim() || /[[\]\n]/.test(words)) return null;
  return `[${words}](${hrefSource(addr)})`;
}
/** Plain lines, each its own paragraph (text that is not Markdown is still source: it reads back as the same text) */
function linesSlice(e: Editor, text: string): Slice {
  const ps = text
    .split(/\n+/)
    .filter((l, k, a) => l || (k > 0 && k < a.length - 1))
    .map((l) => e.schema.nodes.paragraph.create(null, l ? e.schema.text(l) : null));
  return new Slice(Fragment.from(ps), 1, 1);
}
export function handlePaste(e: Editor, ev: ClipboardEvent): boolean {
  const cd = ev.clipboardData;
  if (!cd) return false;
  const raw = cd.getData("text/plain").replace(/\r\n?/g, "\n");
  const $f = e.state.selection.$from;
  if ($f.parent.type.spec.code) return false; // pasted as is into a code block
  if (pastedImages(cd).length) return false; // images (and a whole SVG as text) go to imageEditing's paste
  const html = cd.getData("text/html");
  // only plain text (e-books, typeset formulas on web pages): "shown text + TeX" keeps only $TeX$; HTML is handled in mathInSlice
  const tex = mdOf(e.state).math;
  const vs = cd.getData("vscode-editor-data");
  const plain = html || vs ? raw : undoubleTex(raw, tex);
  // code pasted from elsewhere is decided on the text as copied; prose has its <mark>x</mark> written ==x== (code copied from
  // VS Code stays as it is, so does a line pasted into an inline code span)
  const codeLang = html || vs || $f.parent.type.spec.code ? null : pastedCodeLang(plain, mdOf(e.state).codeLang),
    text = vs || codeLang !== null || inCode($f.parent.textContent, $f.parentOffset) ? plain : markTags(plain);
  const put = (slice: Slice) => {
    e.view.dispatch(
      revealMeta(pasteSlice(e.state.tr, slice)).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"),
    );
    return true;
  };
  const cell = !!$f.depth && /cell/.test($f.node(-1).type.spec.tableRole ?? "");
  // a table cell holds one paragraph (GFM cannot hold more): lines joined with <br>
  if (cell && text.includes("\n")) {
    e.view.dispatch(
      revealMeta(e.state.tr.insertText(text.replace(/\n$/, "").split("\n").join("<br>"))).scrollIntoView(),
    );
    return true;
  }
  // code copied from VS Code: indentation kept; several lines become a code block (in VS Code's language)
  if (vs && text) {
    let lang = "";
    try {
      lang = JSON.parse(vs).mode ?? "";
    } catch {
      /* ignore */
    }
    if (!text.includes("\n")) {
      const ticks = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1),
        pad = /^`|`$/.test(text) ? " " : "";
      e.view.dispatch(e.state.tr.insertText(`${ticks}${pad}${text}${pad}${ticks} `));
      return true;
    }
    e.chain()
      .focus()
      .insertContent({
        type: "codeBlock",
        attrs: { language: lang && lang !== "plaintext" ? lang : null },
        content: [{ type: "text", text: dedent(text.replace(/\n$/, "")) }],
      })
      // the caret lands after the code block (adding a paragraph when there is none), so typing goes on outside the code
      .command(({ tr, state }) => {
        const $p = tr.selection.$from;
        if (!$p.parent.type.spec.code) return true;
        const after = $p.after();
        const next = tr.doc.resolve(after).nodeAfter;
        if (!next?.isTextblock) tr.insert(after, state.schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
        return true;
      })
      .run();
    return true;
  }
  // a copy from an editor of this board carries data-pm-slice, and its text/plain is the Markdown source: pasted as that
  const own = !!html && html.includes("data-pm-slice");
  // HTML from elsewhere (or ours without its text/plain): read with the full schema (formatting, links, typeset formulas), then written
  // as Markdown source
  if (html && (!own || !text)) {
    const md = htmlSource(new DOMParser().parseFromString(html, "text/html").body, tex);
    return md ? put(sourceSlice(e, md)) : false;
  }
  if (!text) return false;
  // one address: on selected words a link (a web address, or a link to an item copied with the page's Copy Link); a link to an
  // item pasted on nothing is a reference to it, as picked from the [[ list
  const one = text.trim();
  if (!cell && !one.includes("\n")) {
    const link = linkPaste(e, one);
    if (link !== null) {
      e.view.dispatch(revealMeta(e.state.tr.insertText(link)).scrollIntoView().setMeta("paste", true));
      return true;
    }
  }
  // one heading line (a copied heading) is a block: into an empty paragraph it makes a heading, into text only its words go
  if (!text.includes("\n") && (cell || !/^ {0,3}#{1,6}[ \t]+\S/.test(text))) {
    e.view.dispatch(revealMeta(e.state.tr.insertText(text)).scrollIntoView().setMeta("paste", true));
    return true;
  }
  if (own) return put(sourceSlice(e, text));
  const lines = pastedMd(text) ? sourceSlice(e, texBrackets(text)) : linesSlice(e, text);
  if (codeLang === null) return put(lines);
  // Code from elsewhere (a terminal, a chat, a web page): one code block. Pasted in two steps, the lines as before and then the
  // block in their place, so one undo turns the block back into the lines and a second takes the paste away
  const from = e.state.selection.from,
    first = revealMeta(closeHistory(e.state.tr).replaceSelection(lines))
      .setMeta("paste", true)
      .setMeta("uiEvent", "paste");
  e.view.dispatch(first);
  const tr = e.state.tr;
  tr.setSelection(TextSelection.create(tr.doc, first.mapping.map(from, -1), e.state.selection.to));
  const code = dedent(text.replace(/^\n+|\s+$/g, ""));
  tr.replaceSelectionWith(e.schema.nodes.codeBlock.create({ language: codeLang || null }, e.schema.text(code)), false);
  // the caret after the block (a paragraph added when there is none), so typing goes on outside the code
  const $e = tr.selection.$from;
  if ($e.parent.type.spec.code || !$e.parent.isTextblock) {
    const at = $e.parent.type.spec.code ? $e.after() : $e.pos;
    if (!tr.doc.resolve(at).nodeAfter?.isTextblock) tr.insert(at, e.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, at + 1));
  }
  e.view.dispatch(closeHistory(tr).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
  return true;
}

/** The language of pasted plain text that is code ("" when it is code in no language the classifier names), null when it is
 *  prose: several lines the page's classifier calls code, unless Markdown's own structure (a link, a list, a quote, a table,
 *  a fence, a formula) says prose. Headings and emphasis say nothing: `# comment` and `*args` are code's too */
export function pastedCodeLang(text: string, classify: (text: string) => string | null): string | null {
  if (text.split("\n").filter((l) => l.trim()).length < 2) return null;
  const lang = classify(text);
  if (lang === null || mdStructure(text)) return null;
  return lang;
}
function mdStructure(text: string): boolean {
  if (/^ {0,3}(```|~~~)/m.test(text)) return true;
  // a link written [text](address) and not right after a name (fs[i](x) is an index and a call); a bare address
  // (url = "https://…") is code's as much as prose's
  if (/(^|[^\w\])])\[[^\]\n]+\]\((?:[a-z][\w+.-]*:|\.{0,2}\/|#)[^)\s]*(?:\s+"[^"]*")?\)/im.test(text)) return true;
  const doc = pastedMd(text);
  if (!doc) return false;
  let found = false;
  const walk = (n: JSONContent) => {
    if (/^(bulletList|orderedList|taskList|blockquote|table)$/.test(n.type ?? "")) found = true;
    // a formula: a $$ block, or a $…$ that reads as TeX (a command, a sub/superscript, a group); shell's "$a" … "$b" pairs
    // up as $…$ too, but holds none of these
    if (n.type === "blockMath" || (n.type === "inlineMath" && /\\[A-Za-z]|[\^_{}]/.test(String(n.attrs?.latex ?? ""))))
      found = true;
    n.content?.forEach(walk);
  };
  walk(doc);
  return found;
}
/** Is the caret inside an inline code span's text: right after its opening backticks and right before its closing ones count */
export function inCode(text: string, off: number) {
  return flat(blockInfo(text).spans).some(
    (s) => s.tag?.nodeName === "code" && s.inner && off >= s.inner[0] && off <= s.inner[1],
  );
}
function dedent(s: string) {
  const ls = s.split("\n");
  const ind = Math.min(...ls.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(ind) && ind > 0 ? ls.map((l) => l.slice(ind)).join("\n") : s;
}
