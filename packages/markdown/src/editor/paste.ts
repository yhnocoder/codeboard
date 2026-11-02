// Pasting into the editor: everything is written as Markdown source (code from VS Code as a code block, HTML read with the
// full schema, plain lines as paragraphs, into a table cell joined with <br>)
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { pastedMd, texBrackets } from "../schema";
import { htmlSource } from "./pastemarks";
import { undoubleTex } from "../doubled";
import { sourceDoc } from "./srcdoc";
import { revealMeta } from "./inline";
import { pastedImages } from "./image";
import type { MdEditorOpts } from "./types";
import { mdOf } from "./md";

/** Markdown → editor blocks (source paragraphs) as a slice open at a paragraph on either end, so the first joins the
 *  text before the caret and the last the text after it */
function sourceSlice(e: Editor, md: string): Slice {
  const d = e.state.schema.nodeFromJSON(sourceDoc(md));
  const open = (n: PMNode | null) => (n?.type.name === "paragraph" ? 1 : 0);
  return new Slice(d.content, open(d.firstChild), open(d.lastChild));
}
/** Plain lines, each its own paragraph (text that is not Markdown is still source: it reads back as the same text) */
function linesSlice(e: Editor, text: string): Slice {
  const ps = text
    .split(/\n+/)
    .filter((l, k, a) => l || (k > 0 && k < a.length - 1))
    .map((l) => e.schema.nodes.paragraph.create(null, l ? e.schema.text(l) : null));
  return new Slice(Fragment.from(ps), 1, 1);
}
export function handlePaste(e: Editor, _o: MdEditorOpts, ev: ClipboardEvent): boolean {
  const cd = ev.clipboardData;
  if (!cd) return false;
  const raw = cd.getData("text/plain").replace(/\r\n?/g, "\n");
  const $f = e.state.selection.$from;
  if ($f.parent.type.spec.code) return false; // pasted as is into a code block
  if (pastedImages(cd).length) return false; // images (and a whole SVG as text) go to imageEditing's paste
  const html = cd.getData("text/html");
  // only plain text (e-books, typeset formulas on web pages): "shown text + TeX" keeps only $TeX$; HTML is handled in mathInSlice
  const tex = mdOf(e.state).math;
  const text = html || cd.getData("vscode-editor-data") ? raw : undoubleTex(raw, tex);
  const put = (slice: Slice) => {
    e.view.dispatch(
      revealMeta(e.state.tr.replaceSelection(slice))
        .scrollIntoView()
        .setMeta("paste", true)
        .setMeta("uiEvent", "paste"),
    );
    return true;
  };
  // a table cell holds one paragraph (GFM cannot hold more): lines joined with <br>
  if ($f.depth && /cell/.test($f.node(-1).type.spec.tableRole ?? "") && text.includes("\n")) {
    e.view.dispatch(
      revealMeta(e.state.tr.insertText(text.replace(/\n$/, "").split("\n").join("<br>"))).scrollIntoView(),
    );
    return true;
  }
  // code copied from VS Code: indentation kept; several lines become a code block (in VS Code's language)
  const vs = cd.getData("vscode-editor-data");
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
  if (!text.includes("\n")) {
    e.view.dispatch(revealMeta(e.state.tr.insertText(text)).scrollIntoView().setMeta("paste", true));
    return true;
  }
  if (own) return put(sourceSlice(e, text));
  return put(pastedMd(text) ? sourceSlice(e, texBrackets(text)) : linesSlice(e, text));
}
function dedent(s: string) {
  const ls = s.split("\n");
  const ind = Math.min(...ls.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(ind) && ind > 0 ? ls.map((l) => l.slice(ind)).join("\n") : s;
}
