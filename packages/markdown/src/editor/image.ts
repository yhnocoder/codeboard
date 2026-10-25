// 编辑器里的图片：节点视图（和静态显示同一份 <img> 属性：一样大，切换时不跳）、粘贴截图、拖进图片文件。
// 图交给用的一方存（MdEditorOpts.saveImage：白板交给宿主存成 assets/ 里的文件），回来的地址写进 Markdown（![](地址)）；
// 回 null 就不插（存不了：不是图、太大，用的一方自己提示）。几张图一起插，算撤销栈里单独的一步
import type { Editor, Node as TNode } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { imageAttrs } from "../image";

/** 存一张图（data: URL、文件名）→ 写进 Markdown 的地址；null = 不插 */
export type SaveImage = (dataUrl: string, name: string) => Promise<string | null>;

const readUrl = (f: File) => new Promise<string>((ok, bad) => {
  const rd = new FileReader();
  rd.onload = () => ok(String(rd.result));
  rd.onerror = () => bad(rd.error);
  rd.readAsDataURL(f);
});
const imagesOf = (files: FileList | File[] | undefined | null) => [...(files ?? [])].filter((f) => f.type.startsWith("image/"));

/** 剪贴板里有图又有字（从 Excel、网页复制的东西常带一张图）：字不是空的就粘字（交给别的粘贴处理）；网页上复制一张图时 HTML 里只有那张图 */
function pastedImages(cd: DataTransfer): File[] {
  const files = imagesOf(cd.files).length ? imagesOf(cd.files) : [...cd.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => !!f);
  if (!files.length) return [];
  const text = cd.getData("text/plain").trim(), html = cd.getData("text/html");
  const htmlText = html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "");
  return !text || (html && !htmlText) ? files : [];
}

/** 存好以后插在 at（文档在这期间变过就插在光标处）；撤销时一步拿掉 */
async function insertFiles(editor: Editor, save: SaveImage, files: File[], at: number) {
  const doc0 = editor.state.doc;
  const srcs = await Promise.all(files.map((f) => readUrl(f).then((u) => save(u, f.name || "pasted.png")).catch(() => null)));
  const content = srcs.filter((s): s is string => !!s).map((src) => ({ type: "image", attrs: { src, alt: "" } }));
  if (!content.length || editor.isDestroyed) return;
  const pos = editor.state.doc === doc0 ? Math.min(at, editor.state.doc.content.size) : editor.state.selection.from;
  editor.chain().focus().command(({ tr }) => { closeHistory(tr); return true; }).insertContentAt(pos, content).run();
  editor.view.dispatch(closeHistory(editor.state.tr)); // 接着打的字是新的一步
}

/** 从文件选的、或者别的地方来的 data: URL 插在光标处 */
export function insertImageUrl(editor: Editor, save: SaveImage, dataUrl: string, name: string) {
  return save(dataUrl, name).then((src) => {
    if (!src || editor.isDestroyed) return;
    editor.chain().focus().command(({ tr }) => { closeHistory(tr); return true; }).insertContent({ type: "image", attrs: { src, alt: "" } }).run();
    editor.view.dispatch(closeHistory(editor.state.tr));
  });
}

class ImageView {
  dom: HTMLImageElement;
  constructor(private node: PMNode) {
    this.dom = document.createElement("img");
    this.set(node);
  }
  private set(n: PMNode) {
    for (const [k, v] of Object.entries(imageAttrs(n.attrs))) { if (v == null) this.dom.removeAttribute(k); else if (this.dom.getAttribute(k) !== v) this.dom.setAttribute(k, v); }
  }
  update(n: PMNode) {
    if (n.type !== this.node.type) return false;
    if (n.attrs !== this.node.attrs) this.set(n);
    this.node = n;
    return true;
  }
  ignoreMutation() { return true; }
}

/** schema 里的图片节点加上编辑时的东西。save 每次粘贴时才取（编辑器是共用的，选项跟着这一次编辑） */
export function imageEditing(base: TNode, editor: () => Editor, save: () => SaveImage) {
  return base.extend({
    addNodeView: () => ({ node }) => new ImageView(node),
    addProseMirrorPlugins() {
      return [...(this.parent?.() ?? []), new Plugin({
        key: new PluginKey("cbImage"),
        props: {
          handlePaste: (view: EditorView, ev: ClipboardEvent) => {
            const files = ev.clipboardData && !view.state.selection.$from.parent.type.spec.code ? pastedImages(ev.clipboardData) : [];
            if (!files.length) return false; // 代码块里照原样粘字
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
