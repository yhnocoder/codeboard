import type { Editor, Node as TNode } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { Mapping } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { blockInfo } from "./spans";

/** 存一张图（data: URL、文件名）→ 写进 Markdown 的地址；null = 不插（存不了时用的一方自己提示） */
export type SaveImage = (dataUrl: string, name: string) => Promise<string | null>;

const readUrl = (f: File) => new Promise<string>((ok, bad) => {
  const rd = new FileReader();
  rd.onload = () => ok(String(rd.result));
  rd.onerror = () => bad(rd.error);
  rd.readAsDataURL(f);
});
const imagesOf = (files: FileList | File[] | undefined | null) => [...(files ?? [])].filter((f) => f.type.startsWith("image/"));

// 整段是一份 SVG 的文字（设计工具的 Copy as SVG）当图粘
const SVG_DOC = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg\b(?:[^>[]|\[[\s\S]*?\])*>)\s*)*<svg(?=[\s/>])(?:[^>]*\/>|[\s\S]*<\/svg>)\s*$/;
function svgText(cd: DataTransfer): File[] {
  const t = cd.getData("image/svg+xml") || cd.getData("text/plain");
  return SVG_DOC.test(t) ? [new File([t.trim()], "pasted.svg", { type: "image/svg+xml" })] : [];
}

/** 剪贴板里有图又有字（从 Excel、网页复制的东西常带一张图）：有字就粘字（交给别的粘贴处理）；网页上复制一张图时 HTML 里只有那张图 */
export function pastedImages(cd: DataTransfer): File[] {
  const files = imagesOf(cd.files).length ? imagesOf(cd.files) : [...cd.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => !!f);
  if (!files.length) return svgText(cd);
  const text = cd.getData("text/plain").trim(), html = cd.getData("text/html");
  const htmlText = html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "");
  return !text || (html && !htmlText) ? files : [];
}

/** Image source for a saved address */
const imageSrc = (src: string) => `![](${/[\s()<>]/.test(src) ? `<${src}>` : src})`;

/** Inserts the saved images at `at` (or at the caret if the document changed meanwhile), as one undo step */
async function insertFiles(editor: Editor, save: SaveImage, files: File[], at: number) {
  const doc0 = editor.state.doc;
  const srcs = await Promise.all(files.map((f) => readUrl(f).then((u) => save(u, f.name || "pasted.png")).catch(() => null)));
  const text = srcs.filter((s): s is string => !!s).map(imageSrc).join(" ");
  if (!text || editor.isDestroyed) return;
  const pos = editor.state.doc === doc0 ? Math.min(at, editor.state.doc.content.size) : editor.state.selection.from;
  const tr = closeHistory(editor.state.tr).insertText(text, pos);
  editor.view.dispatch(tr);
  editor.view.dispatch(closeHistory(editor.state.tr)); // what is typed next is a new step
  editor.view.focus();
}

/** Inserts a data: URL (picked from a file, or from elsewhere) at the caret */
export function insertImageUrl(editor: Editor, save: SaveImage, dataUrl: string, name: string) {
  return save(dataUrl, name).then((src) => {
    if (!src || editor.isDestroyed) return;
    editor.view.dispatch(closeHistory(editor.state.tr).insertText(imageSrc(src)));
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.view.focus();
  });
}

/** A paragraph holding only images (and line breaks): what is left empty after its image is dragged away */
const imageOnly = (p: PMNode) => {
  const t = p.textContent;
  if (!t.trim()) return false;
  const sps = blockInfo(t, false).spans;
  let rest = t;
  for (const sp of [...sps].reverse()) if (sp.atom?.type === "image" || sp.atom?.type === "br") rest = rest.slice(0, sp.from) + rest.slice(sp.to);
  return !rest.trim();
};

/** Pasting and dropping image files; save is read per paste (the editor is shared, the options follow this session) */
export function imageEditing(base: TNode, editor: () => Editor, save: () => SaveImage) {
  return base.extend({
    addProseMirrorPlugins() {
      return [...(this.parent?.() ?? []), new Plugin({
        key: new PluginKey("cbImage"),
        // An image dragged out of a paragraph of its own leaves it empty: take that paragraph away too, in the same undo step
        appendTransaction: (trs, old, now) => {
          if (!trs.some((t) => t.docChanged && t.getMeta("uiEvent") === "drop")) return null;
          const map = new Mapping(trs.flatMap((t) => t.mapping.maps));
          const empty: number[] = [];
          old.doc.descendants((n, pos) => {
            if (n.type.name !== "paragraph") return true;
            if (!imageOnly(n)) return false;
            const r = map.mapResult(pos, 1), p = now.doc.nodeAt(r.pos);
            if (!r.deleted && p?.type.name === "paragraph" && !p.content.size && now.doc.resolve(r.pos).parent.childCount > 1) empty.push(r.pos);
            return false;
          });
          if (!empty.length) return null;
          const tr = now.tr;
          for (const pos of empty.sort((a, b) => b - a)) tr.delete(pos, pos + 2);
          return tr;
        },
        props: {
          handlePaste: (view: EditorView, ev: ClipboardEvent) => {
            const files = ev.clipboardData && !view.state.selection.$from.parent.type.spec.code ? pastedImages(ev.clipboardData) : [];
            if (!files.length) return false;
            ev.preventDefault();
            void insertFiles(editor(), save(), files, view.state.selection.from);
            return true;
          },
          handleDrop: (view: EditorView, ev: DragEvent, _slice, moved: boolean) => {
            const files = moved ? [] : imagesOf(ev.dataTransfer?.files);
            if (!files.length) return false;
            ev.preventDefault();
            const at = view.posAtCoords({ left: ev.clientX, top: ev.clientY })?.pos ?? view.state.selection.from;
            if (view.state.doc.resolve(at).parent.type.spec.code) return false;
            void insertFiles(editor(), save(), files, at);
            return true;
          },
        },
      })];
    },
  });
}
