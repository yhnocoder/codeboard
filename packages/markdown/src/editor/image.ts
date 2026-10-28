import type { Editor, Node as TNode } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { imageAttrs } from "../image";
import { holdGhosts } from "../ui/ghost";

/** 存一张图（data: URL、文件名）→ 写进 Markdown 的地址；null = 不插（存不了时用的一方自己提示） */
export type SaveImage = (dataUrl: string, name: string) => Promise<string | null>;

const readUrl = (f: File) => new Promise<string>((ok, bad) => {
  const rd = new FileReader();
  rd.onload = () => ok(String(rd.result));
  rd.onerror = () => bad(rd.error);
  rd.readAsDataURL(f);
});
const imagesOf = (files: FileList | File[] | undefined | null) => [...(files ?? [])].filter((f) => f.type.startsWith("image/"));

/** 剪贴板里有图又有字（从 Excel、网页复制的东西常带一张图）：有字就粘字（交给别的粘贴处理）；网页上复制一张图时 HTML 里只有那张图 */
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

// 编辑器里图包在一层 span.md-img 里（放改宽度的把手）：缩小了的宽度写在这一层上，图占满它。静态显示没有这一层，
// 宽度直接在 <img> 上；两边都是正文宽的百分之几、带 .sized（居中），样式见 markdown.css，进出编辑不跳
const MIN_W = 24; // 最窄（像素）

class ImageView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private grips: HTMLElement[];
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement("span");
    this.dom.className = "md-img";
    this.img = document.createElement("img");
    // 缩小了的图居中：两边各一个把手，拖哪一边都是以中心为准两边一起变
    const grips = [-1, 1].map((side) => {
      const g = document.createElement("span");
      g.className = `md-imgrip ${side < 0 ? "l" : "r"}`;
      g.draggable = false;
      g.setAttribute("data-tip", "Drag to resize · Double-click for full width");
      g.addEventListener("pointerdown", (e) => this.down(e, g, side));
      g.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); this.commit(null); });
      return g;
    });
    this.grips = grips;
    this.dom.append(this.img, ...grips);
    this.set(node);
  }
  private set(n: PMNode) {
    for (const [k, v] of Object.entries(imageAttrs(n.attrs))) {
      if (k === "style" || k === "class") continue;
      if (v == null) this.img.removeAttribute(k); else if (this.img.getAttribute(k) !== v) this.img.setAttribute(k, v);
    }
    this.show(n.attrs.width);
  }
  private show(w: number | null) {
    this.dom.style.width = w ? `${w}%` : "";
    this.dom.classList.toggle("sized", !!w);
  }
  /** 拖把手：按下时量一次（正文宽、图现在的宽），拖动中每帧只写宽度不读排版；放开时写进文档，一次撤销 */
  private down(e: PointerEvent, grip: HTMLElement, side: number) {
    if (e.button !== 0) return;
    // 卡片不跟着拖、ProseMirror 不选字也不拖图、焦点留在编辑器里
    e.preventDefault();
    e.stopPropagation();
    const box = blockOf(this.dom), cs = getComputedStyle(box), r = box.getBoundingClientRect();
    const k = box.offsetWidth ? r.width / box.offsetWidth : 1; // 白板的缩放
    const full = (box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) * k;
    if (!(full > 0)) return;
    const w0 = this.dom.getBoundingClientRect().width, x0 = e.clientX, min = Math.min(100, (MIN_W * k / full) * 100);
    let w: number | null = this.node.attrs.width, frame = 0, moved = false;
    grip.setPointerCapture(e.pointerId);
    this.dom.draggable = false;
    this.dom.classList.add("resizing");
    holdGhosts(true);
    const move = (ev: PointerEvent) => {
      moved ||= ev.clientX !== x0;
      if (!moved) return;
      const p = Math.min(100, Math.max(min, ((w0 + 2 * side * (ev.clientX - x0)) / full) * 100));
      w = p >= 99.5 ? null : Math.round(p);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.show(w); });
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      grip.removeEventListener("lostpointercapture", up);
      cancelAnimationFrame(frame);
      this.dom.draggable = true;
      this.dom.classList.remove("resizing");
      holdGhosts(false);
      if (moved) this.commit(w); else this.show(this.node.attrs.width);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
    grip.addEventListener("lostpointercapture", up);
  }
  private commit(w: number | null) {
    const pos = this.getPos();
    if (pos == null || (this.node.attrs.width ?? null) === w) { this.show(this.node.attrs.width); return; }
    const v = this.view;
    v.dispatch(closeHistory(v.state.tr.setNodeAttribute(pos, "width", w)));
    v.dispatch(closeHistory(v.state.tr)); // 接着打的字是新的一步
  }
  update(n: PMNode) {
    if (n.type !== this.node.type) return false;
    if (n.attrs !== this.node.attrs) this.set(n);
    this.node = n;
    return true;
  }
  stopEvent(e: Event) { return this.grips.some((g) => g.contains(e.target as globalThis.Node)); }
  ignoreMutation() { return true; }
}
/** 百分比宽度算的是哪一个的宽：最近的块级祖先（图可能在链接、加粗这些行内元素里） */
function blockOf(el: HTMLElement): HTMLElement {
  let p = el.parentElement!;
  while (p.parentElement && getComputedStyle(p).display.startsWith("inline")) p = p.parentElement;
  return p;
}

/** save 每次粘贴时才取（编辑器是共用的，选项跟着这一次编辑） */
export function imageEditing(base: TNode, editor: () => Editor, save: () => SaveImage) {
  return base.extend({
    addNodeView: () => ({ node, view, getPos }) => new ImageView(node, view, getPos as () => number | undefined),
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
