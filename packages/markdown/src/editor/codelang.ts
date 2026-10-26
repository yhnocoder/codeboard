// Note 代码块右下角的语言框（照 Typora #68）：编辑时光标在这一块里、或鼠标停在块上时淡淡地显示语言；点进去打字，下面列出对得上的
// 语言（用的一方给的、着色认得的那些，再加 Mermaid）。↑↓ 选、↵ / 点一下定下来（一步，进撤销），Esc 不改，清空 = 纯文字。
// 失焦（点了别处）时照打的字定下来，和链接框一样。改了马上换着色，写回成 ```语言
import { keepKey } from "../ui/editkeys";
import { place } from "../ui/place";

/** 一种语言：name 是写进围栏的名字，label 显示的名字，aliases 打这些也算它（不分大小写） */
export type CodeLang = { name: string; label: string; aliases?: string[] };

/** Note 里的 Mermaid 图（diagram.ts）：着色不认得，也列出来 */
const MERMAID: CodeLang = { name: "mermaid", label: "Mermaid" };

/** 打的字 → 对得上的语言：名字、显示名、别名开头对上的排前面，包含的其次；没打字时全部 */
export function matchLangs(all: readonly CodeLang[], q: string): CodeLang[] {
  const s = q.trim().toLowerCase();
  if (!s) return [...all];
  const w = (l: CodeLang) => {
    const keys = [l.name, l.label, ...(l.aliases ?? [])].map((k) => k.toLowerCase());
    return keys.some((k) => k === s) ? 4 : keys.some((k) => k.startsWith(s)) ? 3 : keys.some((k) => k.includes(s)) ? 2 : 0;
  };
  return all.map((l) => ({ l, w: w(l) })).filter((x) => x.w).sort((a, b) => b.w - a.w).map((x) => x.l);
}
/** 打的字定下来的语言：是某种语言的名字、显示名、别名时用它的名字，别的照打的写（围栏的语言是一个词）；空 = 纯文字 */
export function langOf(all: readonly CodeLang[], typed: string): string | null {
  const s = typed.trim().split(/\s+/)[0] ?? "";
  if (!s) return null;
  const l = s.toLowerCase();
  return all.find((x) => [x.name, x.label, ...(x.aliases ?? [])].some((k) => k.toLowerCase() === l))?.name ?? s;
}

export type LangBoxHost = {
  /** 现在的语言 */
  lang: () => string;
  /** 定下来（null = 纯文字）：一步改文档 */
  set: (lang: string | null) => void;
  /** 回到代码里接着打 */
  back: () => void;
  /** 焦点从框直接去了编辑器外面：替编辑器发一个 blur（用的一方照常保存退出） */
  left: (to: EventTarget | null) => void;
  langs: () => readonly CodeLang[];
};

export class LangBox {
  readonly input: HTMLInputElement;
  private box: HTMLDivElement | null = null;
  private items: CodeLang[] = [];
  /** 选中的那一项；-1 = 没选（↵ 照打的字） */
  private i = -1;
  /** 正在定下来 / 取消（拿走焦点时的那一下 blur 不再定一次） */
  private busy = false;

  constructor(private host: LangBoxHost) {
    const i = (this.input = document.createElement("input"));
    i.className = "md-lang";
    i.spellcheck = false;
    i.placeholder = "Language";
    i.setAttribute("aria-label", "Code language");
    i.value = host.lang();
    i.addEventListener("pointerdown", (e) => e.stopPropagation());
    i.addEventListener("focus", () => { i.select(); this.open(); });
    i.addEventListener("input", () => this.filter(true));
    i.addEventListener("keydown", (e) => this.key(e));
    i.addEventListener("blur", (e) => {
      if (this.busy) return;
      this.commit(i.value, false);
      if (!(e.relatedTarget instanceof Node && this.input.closest(".md-pm")?.contains(e.relatedTarget))) host.left(e.relatedTarget);
    });
  }

  private all(): CodeLang[] {
    const ls = this.host.langs();
    return ls.some((l) => l.name === MERMAID.name) ? [...ls] : [...ls, MERMAID];
  }

  /** 文档里的语言变了（撤销、别处改的）：没在打字时跟着换 */
  sync() { if (document.activeElement !== this.input) this.input.value = this.host.lang(); }

  private open() {
    if (this.box) return;
    // 挂在 body 下（不跟着白板缩放）；.mdui-anchor：编辑器把它当作自己的浮层，点它不算离开
    const b = (this.box = document.createElement("div"));
    b.className = "mdui-anchor md-langbox";
    b.innerHTML = `<div class="ctx open md-menu" role="listbox"></div>`;
    b.addEventListener("mousedown", (e) => e.preventDefault()); // 焦点留在输入框里
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.append(b);
    this.filter(false);
  }
  private close() { this.box?.remove(); this.box = null; this.i = -1; }

  /** typed：用户打了字（选中第一项）；否则（刚打开）先不选，↵ 就是照框里的字 */
  private filter(typed: boolean) {
    if (!this.box) return;
    const q = this.input.value;
    this.items = matchLangs(this.all(), typed ? q : "");
    this.i = typed && q.trim() && this.items.length ? 0 : this.items.findIndex((l) => !typed && l.name === langOf(this.all(), q));
    this.draw();
  }
  private draw() {
    const list = this.box!.firstElementChild as HTMLElement;
    list.replaceChildren(...this.items.map((l, k) => {
      const btn = document.createElement("button");
      btn.setAttribute("role", "option");
      if (k === this.i) btn.classList.add("sel");
      btn.innerHTML = `<span class="lb"></span><small></small>`;
      btn.firstElementChild!.textContent = l.label;
      btn.lastElementChild!.textContent = l.name;
      btn.addEventListener("pointerenter", () => { this.i = k; this.mark(); });
      btn.addEventListener("click", () => this.commit(l.name, true));
      return btn;
    }));
    if (!this.items.length) list.innerHTML = `<div class="md-empty">No known language: Enter keeps what you typed</div>`;
    this.mark();
    void place(this.box!, this.input, "bottom-end", { gap: 4, pad: 6, strategy: "fixed" }).then(({ x, y }) => { if (this.box) { this.box.style.left = `${x}px`; this.box.style.top = `${y}px`; } });
  }
  private mark() {
    const bs = this.box?.querySelectorAll("button");
    bs?.forEach((b, k) => b.classList.toggle("sel", k === this.i));
    bs?.[this.i]?.scrollIntoView({ block: "nearest" });
  }

  private key(e: KeyboardEvent) {
    if (e.isComposing) return keepKey(e);
    const n = this.items.length;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
      e.preventDefault();
      this.i = this.i < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (this.i + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      this.mark();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.commit(this.i >= 0 && this.items[this.i] ? this.items[this.i].name : this.input.value, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.leave();
    }
    keepKey(e);
  }

  /** 定下来；back：回到代码里 */
  private commit(typed: string, back: boolean) {
    const lang = langOf(this.all(), typed);
    this.close();
    if (lang !== langOf(this.all(), this.host.lang())) this.host.set(lang); // py 和 python 是同一种：不改
    this.input.value = lang ?? "";
    if (back) this.leave();
  }
  /** 不改（Esc），回到代码里 */
  private leave() {
    this.close();
    this.input.value = this.host.lang();
    this.busy = true;
    this.host.back();
    this.busy = false;
  }

  destroy() { this.close(); }
}
