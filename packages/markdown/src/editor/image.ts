import type { Editor, Node as TNode } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { Mapping } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { blockInfo, flat, spanEdgeOut } from "./spans";

/** 存一张图（data: URL、文件名）→ 写进 Markdown 的地址；null = 不插（存不了时用的一方自己提示） */
export type SaveImage = (dataUrl: string, name: string) => Promise<string | null>;
/** Put the image at src (its address as written in the Markdown) on the clipboard; md: its Markdown */
export type CopyImage = (src: string, md: string) => void;
/** A pasted or dropped picture the page knows (one it copied): the Markdown it stands for, null for any other */
export type KnownImage = (f: File) => Promise<string | null>;

const readUrl = (f: File) =>
  new Promise<string>((ok, bad) => {
    const rd = new FileReader();
    rd.onload = () => ok(String(rd.result));
    rd.onerror = () => bad(rd.error);
    rd.readAsDataURL(f);
  });
const imagesOf = (files: FileList | File[] | undefined | null) =>
  [...(files ?? [])].filter((f) => f.type.startsWith("image/"));

// 整段是一份 SVG 的文字（设计工具的 Copy as SVG）当图粘
const SVG_DOC =
  /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg\b(?:[^>[]|\[[\s\S]*?\])*>)\s*)*<svg(?=[\s/>])(?:[^>]*\/>|[\s\S]*<\/svg>)\s*$/;
function svgText(cd: DataTransfer): File[] {
  const t = cd.getData("image/svg+xml") || cd.getData("text/plain");
  return SVG_DOC.test(t) ? [new File([t.trim()], "pasted.svg", { type: "image/svg+xml" })] : [];
}

/** 剪贴板里有图又有字（从 Excel、网页复制的东西常带一张图）：有字就粘字（交给别的粘贴处理）；网页上复制一张图时 HTML 里只有那张图 */
export function pastedImages(cd: DataTransfer): File[] {
  const files = imagesOf(cd.files).length
    ? imagesOf(cd.files)
    : [...cd.items]
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
  if (!files.length) return svgText(cd);
  const text = cd.getData("text/plain").trim(),
    html = cd.getData("text/html");
  const htmlText = html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|\s/g, "");
  return !text || (html && !htmlText) ? files : [];
}

/** Image source for a saved address */
const imageSrc = (src: string) => `![](${/[\s()<>]/.test(src) ? `<${src}>` : src})`;

/** The caret's position moved outside the markers of spans it sits at the edge of (spans.ts outsideSpans) */
function outsideSpans(doc: PMNode, pos: number) {
  const $p = doc.resolve(pos);
  if ($p.parent.type.name !== "paragraph" || !$p.depth) return pos;
  return (
    $p.start() +
    spanEdgeOut($p.parent.textContent, pos - $p.start(), !/cell/.test($p.node(-1).type.spec.tableRole ?? ""))
  );
}

/** Inserts the saved images at `at` (or at the caret if the document changed meanwhile), as one undo step */
async function insertFiles(editor: Editor, save: SaveImage, known: KnownImage | undefined, files: File[], at: number) {
  const doc0 = editor.state.doc;
  const mds = await Promise.all(
    files.map(async (f) => {
      const md = await known?.(f).catch(() => null);
      if (md) return md;
      return readUrl(f)
        .then((u) => save(u, f.name || "pasted.png"))
        .then((src) => (src ? imageSrc(src) : null))
        .catch(() => null);
    }),
  );
  const text = mds.filter((s): s is string => !!s).join(" ");
  if (!text || editor.isDestroyed) return;
  const pos = outsideSpans(
    editor.state.doc,
    editor.state.doc === doc0 ? Math.min(at, editor.state.doc.content.size) : editor.state.selection.from,
  );
  const tr = closeHistory(editor.state.tr).insertText(text, pos);
  editor.view.dispatch(tr);
  editor.view.dispatch(closeHistory(editor.state.tr)); // what is typed next is a new step
  editor.view.focus();
}

/** Inserts a data: URL (picked from a file, or from elsewhere) at the caret */
export function insertImageUrl(editor: Editor, save: SaveImage, dataUrl: string, name: string) {
  return save(dataUrl, name).then((src) => {
    if (!src || editor.isDestroyed) return;
    const { from, to, empty } = editor.state.selection;
    editor.view.dispatch(
      empty
        ? closeHistory(editor.state.tr).insertText(imageSrc(src), outsideSpans(editor.state.doc, from))
        : closeHistory(editor.state.tr).insertText(imageSrc(src), from, to),
    );
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.view.focus();
  });
}

/** Transaction meta: an image's source taken out because the image was dragged out of the editor (widgets.ts dragEnd) */
export const DRAGGED_OUT = "imageDraggedOut";

/** A paragraph holding only images (and line breaks): what is left empty after its image is dragged away */
const imageOnly = (p: PMNode) => {
  const t = p.textContent;
  if (!t.trim()) return false;
  const sps = blockInfo(t, false).spans;
  let rest = t;
  for (const sp of [...sps].reverse())
    if (sp.atom?.type === "image" || sp.atom?.type === "br") rest = rest.slice(0, sp.from) + rest.slice(sp.to);
  return !rest.trim();
};

/**
 * The image the selection stands for: the caret in its source (the image is drawn selected, with its grips) or exactly its
 * source selected (spaces around it aside)
 */
function selectedImage(state: EditorState): { src: string; md: string } | null {
  const { $from, $to, from, to } = state.selection;
  if (!$from.sameParent($to) || $from.parent.type.name !== "paragraph") return null;
  const text = $from.parent.textContent,
    cell = $from.depth > 0 && /cell|header/.test($from.node(-1).type.spec.tableRole ?? "");
  let a = from - $from.start(),
    b = to - $from.start();
  const picked = text.slice(a, b);
  a += picked.length - picked.trimStart().length;
  b -= picked.length - picked.trimEnd().length;
  const sp = flat(blockInfo(text, !cell).spans).find(
    (s) => s.atom?.type === "image" && (a === b ? s.from <= a && a <= s.to : s.from === a && s.to === b),
  );
  return sp?.atom?.type === "image" && sp.atom.src ? { src: sp.atom.src, md: text.slice(sp.from, sp.to) } : null;
}

/** Pasting and dropping image files, copying an image; save and copy are read per use (the editor is shared, the options
 *  follow this session) */
export function imageEditing(
  base: TNode,
  editor: () => Editor,
  save: () => SaveImage,
  copy: () => CopyImage | undefined,
  known: () => KnownImage | undefined,
) {
  return base.extend({
    addProseMirrorPlugins() {
      return [
        ...(this.parent?.() ?? []),
        new Plugin({
          key: new PluginKey("cbImage"),
          // An image dragged out of a paragraph of its own (to elsewhere in the editor, or out of it) leaves it empty: take that
          // paragraph away too, in the same undo step
          appendTransaction: (trs, old, now) => {
            if (!trs.some((t) => t.docChanged && (t.getMeta("uiEvent") === "drop" || t.getMeta(DRAGGED_OUT))))
              return null;
            const map = new Mapping(trs.flatMap((t) => t.mapping.maps));
            const empty: number[] = [];
            old.doc.descendants((n, pos) => {
              if (n.type.name !== "paragraph") return true;
              if (!imageOnly(n)) return false;
              const r = map.mapResult(pos, 1),
                p = now.doc.nodeAt(r.pos);
              if (
                !r.deleted &&
                p?.type.name === "paragraph" &&
                !p.content.size &&
                now.doc.resolve(r.pos).parent.childCount > 1
              )
                empty.push(r.pos);
              return false;
            });
            if (!empty.length) return null;
            const tr = now.tr;
            for (const pos of empty.sort((a, b) => b - a)) tr.delete(pos, pos + 2);
            return tr;
          },
          props: {
            handleDOMEvents: {
              // the caret alone in an image's source copies nothing by default: saying so before the copy lets it happen
              beforecopy: (view: EditorView, ev: Event) => {
                if (copy() && view.state.selection.empty && selectedImage(view.state)) ev.preventDefault();
                return false;
              },
              copy: (view: EditorView, ev: ClipboardEvent) => {
                const c = copy(),
                  img = c && selectedImage(view.state);
                if (!img) return false;
                // the picture alone (an app given text as well pastes the text); a paste of it back is the Markdown (knownImage)
                ev.preventDefault();
                c(img.src, img.md);
                return true;
              },
            },
            handlePaste: (view: EditorView, ev: ClipboardEvent) => {
              const files =
                ev.clipboardData && !view.state.selection.$from.parent.type.spec.code
                  ? pastedImages(ev.clipboardData)
                  : [];
              if (!files.length) return false;
              ev.preventDefault();
              void insertFiles(editor(), save(), known(), files, view.state.selection.from);
              return true;
            },
            handleDrop: (view: EditorView, ev: DragEvent, _slice, moved: boolean) => {
              const files = moved ? [] : imagesOf(ev.dataTransfer?.files);
              if (!files.length) return false;
              ev.preventDefault();
              const at = view.posAtCoords({ left: ev.clientX, top: ev.clientY })?.pos ?? view.state.selection.from;
              if (view.state.doc.resolve(at).parent.type.spec.code) return false;
              void insertFiles(editor(), save(), known(), files, at);
              return true;
            },
          },
        }),
      ];
    },
  });
}
