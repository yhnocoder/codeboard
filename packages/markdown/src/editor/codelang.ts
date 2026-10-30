import { keepKey } from "../ui/editkeys";
import { place } from "../ui/place";
import { scrollIntoBox } from "../ui/reveal";

/** 一种语言：name 是写进围栏的名字，label 显示的名字，aliases 打这些也算它（不分大小写） */
export type CodeLang = { name: string; label: string; aliases?: string[] };

/** 着色不认得，也列出来 */
const MERMAID: CodeLang = { name: "mermaid", label: "Mermaid" };
const PLAIN: CodeLang = { name: "", label: "Plain text", aliases: ["plain", "text", "plaintext", "none"] };

/** 打的字 → 对得上的语言：名字、显示名、别名开头对上的排前面，包含的其次；没打字时全部 */
export function matchLangs(all: readonly CodeLang[], q: string): CodeLang[] {
  const s = q.trim().toLowerCase();
  if (!s) return [...all];
  const w = (l: CodeLang) => {
    const keys = [l.name, l.label, ...(l.aliases ?? [])].filter(Boolean).map((k) => k.toLowerCase());
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
/** 围栏里的语言显示成什么：认得的用显示名（py 也是 Python），不认得的照写，空是 Plain text */
export function langLabel(all: readonly CodeLang[], lang: string): string {
  const n = langOf(all, lang);
  return n === null ? PLAIN.label : all.find((x) => x.name === n)?.label ?? n;
}

export type LangBoxHost = {
  lang: () => string;
  /** 定下来（null = 纯文字）：一步改文档 */
  set: (lang: string | null) => void;
  /** 回到代码里接着打 */
  back: () => void;
  /** 焦点从列表直接去了编辑器外面：替编辑器发一个 blur（用的一方照常保存退出） */
  left: (to: EventTarget | null) => void;
  langs: () => readonly CodeLang[];
};

const CHEVRON = `<svg class="md-lang-v" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;

export class LangBox {
  readonly label: HTMLButtonElement;
  private name: HTMLSpanElement;
  private box: HTMLDivElement | null = null;
  private q: HTMLInputElement | null = null;
  private items: CodeLang[] = [];
  /** 选中的那一项；-1 = 没有（↵ 照打的字） */
  private i = -1;
  /** 打过字或用 ↑↓ 挑过：点了别处时照挑的定下来；没动过就不改 */
  private touched = false;
  /** 正在拿掉列表（筛选框被拿掉时的那一下 blur 不算离开） */
  private busy = false;

  constructor(private host: LangBoxHost) {
    const b = (this.label = document.createElement("button"));
    b.type = "button";
    b.className = "md-lang";
    b.tabIndex = -1;
    b.contentEditable = "false";
    b.setAttribute("aria-haspopup", "listbox");
    b.setAttribute("aria-expanded", "false");
    b.innerHTML = `<span class="md-lang-nm"></span>${CHEVRON}`;
    this.name = b.firstElementChild as HTMLSpanElement;
    // 按下时焦点不动（还在代码里），点开后交给筛选框
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.preventDefault(); if (this.box) this.leave(); else this.open(); });
    this.sync();
  }

  private all(): CodeLang[] {
    const ls = this.host.langs();
    return ls.some((l) => l.name === MERMAID.name) ? [...ls] : [...ls, MERMAID];
  }

  /** 文档里的语言变了（撤销、别处改的）时调 */
  sync() {
    const n = langLabel(this.all(), this.host.lang());
    this.name.textContent = n;
    this.label.setAttribute("aria-label", `Code language: ${n}`);
  }

  private open() {
    if (this.box) return;
    // 挂在 body 下（不跟着白板缩放）；.mdui-anchor：编辑器把它当作自己的浮层，焦点在这里不算离开
    const b = (this.box = document.createElement("div"));
    b.className = "mdui-anchor md-langbox";
    b.innerHTML = `<div class="ctx md-menu"><input class="md-langq" placeholder="Filter languages" spellcheck="false" autocomplete="off" aria-label="Filter languages"><div class="md-langs" role="listbox"></div></div>`;
    b.addEventListener("mousedown", (e) => { if (e.target !== this.q) e.preventDefault(); }); // 焦点留在筛选框里
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    const q = (this.q = b.querySelector("input")!);
    q.addEventListener("input", () => { this.touched = true; this.filter(true); });
    q.addEventListener("keydown", (e) => this.key(e));
    q.addEventListener("blur", (e) => {
      if (this.busy) return;
      const to = e.relatedTarget;
      if (this.touched) this.commit(false); else this.close();
      if (!(to instanceof Node && this.label.closest(".md-pm")?.contains(to))) this.host.left(to);
    });
    document.body.append(b);
    this.label.setAttribute("aria-expanded", "true");
    this.touched = false;
    this.filter(false);
    // 和别的菜单一样从 .97 放大、淡入（.ctx → .ctx.open 的过渡：先让没打开的样子排一次版）；看得见了才拿得到焦点
    const m = b.firstElementChild as HTMLElement;
    void m.offsetWidth;
    m.classList.add("open");
    q.focus();
  }
  private close() {
    // 筛选框还有焦点时拿掉列表，Chrome 会同步发 blur（拆掉代码块时就是这样）：那一下不是用户离开，不定下来、不替编辑器发 blur，
    // 也不在 remove 里面再 remove 一次
    const b = this.box;
    this.box = this.q = null;
    this.busy = true;
    b?.remove();
    this.busy = false;
    this.i = -1;
    this.label.setAttribute("aria-expanded", "false");
  }

  /** typed：用户打了字（选中第一项）；否则（刚打开）选中现在的语言 */
  private filter(typed: boolean) {
    if (!this.box) return;
    const q = this.q!.value, cur = langOf(this.all(), this.host.lang()) ?? "";
    this.items = matchLangs([...this.all(), PLAIN], typed ? q : "");
    this.i = typed && q.trim() ? (this.items.length ? 0 : -1) : this.items.findIndex((l) => l.name === cur);
    this.draw(cur);
  }
  private draw(cur: string) {
    const list = this.box!.querySelector(".md-langs") as HTMLElement;
    list.replaceChildren(...this.items.map((l, k) => {
      const btn = document.createElement("button");
      btn.className = "md-lo";
      btn.tabIndex = -1;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(l.name === cur));
      btn.innerHTML = `<span class="ck"></span><span class="lb"></span><small></small>`;
      const [ck, lb, sm] = btn.children;
      ck.textContent = l.name === cur ? "✓" : "";
      lb.textContent = l.label;
      sm.textContent = l.name;
      btn.addEventListener("pointerenter", () => { this.i = k; this.mark(); });
      btn.addEventListener("click", () => { this.i = k; this.commit(true); });
      return btn;
    }));
    if (!this.items.length) list.innerHTML = `<div class="md-empty">No known language: Enter keeps what you typed</div>`;
    this.mark();
    void place(this.box!, this.label, "bottom-end", { gap: 4, pad: 6, strategy: "fixed" }).then(({ x, y, placement }) => {
      if (!this.box) return;
      this.box.style.left = `${x}px`;
      this.box.style.top = `${y}px`;
      (this.box.firstElementChild as HTMLElement).style.transformOrigin = placement.startsWith("top") ? "100% 100%" : "100% 0";
    });
  }
  private mark() {
    const bs = this.box?.querySelectorAll(".md-lo");
    bs?.forEach((b, k) => b.classList.toggle("sel", k === this.i));
    const b = bs?.[this.i];
    if (b) scrollIntoBox(b, "nearest");
  }

  private key(e: KeyboardEvent) {
    if (e.isComposing) return keepKey(e);
    const n = this.items.length;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
      e.preventDefault();
      this.touched = true;
      this.i = this.i < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (this.i + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      this.mark();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.commit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.leave();
    }
    keepKey(e);
  }

  /** 定下来：选中的那一项，没有时照筛选框里打的字（空 = 不改）；back：回到代码里 */
  private commit(back: boolean) {
    const it = this.items[this.i], typed = this.q?.value ?? "";
    const all = this.all();
    const lang = it ? (it.name || null) : typed.trim() ? langOf(all, typed) : langOf(all, this.host.lang());
    this.close();
    if (lang !== langOf(all, this.host.lang())) this.host.set(lang); // py 和 python 是同一种：不改
    this.sync();
    if (back) this.leave();
  }
  /** 不改（Esc），回到代码里 */
  private leave() {
    this.close();
    this.host.back();
  }

  destroy() { this.close(); }
}
