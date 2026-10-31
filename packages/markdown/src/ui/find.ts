// 编辑时的查找 / 替换条：Note 的编辑器（ProseMirror，editor/find.ts）和代码编辑器（CodeMirror，cm/find.ts）共用这一个样子和按键，
// 查、选、换由各自的搜索库做（prosemirror-search、@codemirror/search），这里只管条本身。
// 浮在编辑器右上角，不占排版（进出查找时字不动）；样子借用外面的 .pill（浮条）和 .tbtn（按钮），和选中工具条一样
import { keepKey } from "./editkeys";
import { iconEl, type IconName } from "./icons";

export type FindSpec = { search: string; replace: string; caseSensitive: boolean };

/** 编辑器那一边 */
export type FindTarget = {
  /** 查找条件变了：高亮所有匹配；moved（查找的字变了）时选中从打开查找时的光标往后的第一个 */
  query(q: FindSpec, moved: boolean): void;
  next(): void;
  prev(): void;
  /** 换掉选中的这一个，选中下一个 */
  replace(): void;
  /** 全部换掉：一步（一次撤销撤回） */
  replaceAll(): void;
  /** 选中的是第几个（从 1 起，没选中匹配是 0）、一共几个 */
  count(): { at: number; total: number };
  /** 条关掉以后：去掉高亮，焦点回编辑器 */
  closed(): void;
};

export type FindBarOpts = {
  isMac: boolean;
  /** 焦点离开查找条去了这里时还在编辑（编辑器自己、它的浮层） */
  owns: (n: Node) => boolean;
  /** 焦点从查找条去了编辑器外面：和编辑器失焦一样（保存退出） */
  leave: (ev: FocusEvent) => void;
};

/** ⌘F / Ctrl+F：打开查找；⌥⌘F（Ctrl+Alt+F）或 ⌘H（Ctrl+H）：连替换一起打开。字母按 e.code（⌥ 在 mac 上会改 e.key） */
export function findKey(e: KeyboardEvent): "find" | "replace" | null {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.isComposing) return null;
  if (e.code === "KeyF") return e.altKey ? "replace" : "find";
  if (e.code === "KeyH" && !e.altKey) return "replace";
  return null;
}

/** 选中的字当查找的初值：不跨行、不太长的才用 */
export const seedText = (s: string) => (s && !/\n/.test(s) && s.length <= 200 ? s : undefined);

export class FindBar {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private q: HTMLInputElement;
  private r: HTMLInputElement;
  private n: HTMLElement;
  private caseBtn: HTMLButtonElement;
  private spec: FindSpec = { search: "", replace: "", caseSensitive: false };
  /** 关的时候焦点先回编辑器、再拿掉条：拿掉有焦点的输入框时浏览器会报一次失焦，不能当成离开 */
  private closing = false;

  constructor(
    private t: FindTarget,
    private o: FindBarOpts,
  ) {
    const mod = o.isMac ? "⌘" : "Ctrl+",
      alt = mod === "⌘" ? "⌥" : "Alt+";
    this.el = div("md-find");
    this.el.dataset.nodrag = "";
    this.bar = div("pill md-findbar");
    this.el.append(this.bar);
    const row1 = div("md-findrow"),
      row2 = div("md-findrow md-replrow");
    const tog = button("replace", "Toggle Replace", `${alt}${mod}F`, "md-tog", () =>
      this.showReplace(!this.bar.classList.contains("repl")),
    );
    this.q = input("md-findq", "Find");
    this.n = div("md-findn");
    this.caseBtn = button(null, "Match Case", `${alt}C`, "md-case", () => this.toggleCase());
    this.caseBtn.textContent = "Aa";
    row1.append(
      tog,
      this.q,
      this.n,
      this.caseBtn,
      button("up", "Previous Match", "⇧Enter", "", () => this.go(-1)),
      button("down", "Next Match", "Enter", "", () => this.go(1)),
      button("close", "Close", "Esc", "", () => this.close()),
    );
    this.r = input("md-findr", "Replace");
    const one = button(null, "Replace", "Enter", "md-txt", () => this.replace()),
      all = button(null, "Replace All", `${mod}Enter`, "md-txt", () => this.replaceAll());
    one.textContent = "Replace";
    all.textContent = "All";
    row2.append(div("md-findpad"), this.r, one, all);
    this.bar.append(row1, row2);

    this.q.addEventListener("input", () => {
      this.spec = { ...this.spec, search: this.q.value };
      this.t.query(this.spec, true);
      this.refresh();
    });
    this.r.addEventListener("input", () => {
      this.spec = { ...this.spec, replace: this.r.value };
      this.t.query(this.spec, false);
    });
    this.q.addEventListener("keydown", (e) => this.key(e, false));
    this.r.addEventListener("keydown", (e) => this.key(e, true));
    // 按钮不拿焦点（焦点留在输入框里）；按下不让白板当成拖卡片
    this.bar.addEventListener("mousedown", (e) => {
      if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
    });
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.el.addEventListener("focusout", (e) => {
      const to = e.relatedTarget;
      if (this.closing || (to instanceof Node && (this.el.contains(to) || this.o.owns(to)))) return;
      this.o.leave(e);
    });
  }

  get open() {
    return this.el.isConnected;
  }

  /** 打开（已经开着就再选中查找框）：seed 是选中的字 */
  show(replace: boolean, seed?: string) {
    if (seed !== undefined && seed !== this.q.value) {
      this.q.value = seed;
      this.spec = { ...this.spec, search: seed };
    }
    if (replace) this.showReplace(true);
    this.t.query(this.spec, true);
    this.refresh();
    const f = replace ? this.r : this.q;
    f.focus({ preventScroll: true });
    f.select();
  }

  /** 编辑器里的字、选区变了：重算第几个 / 几个 */
  refresh() {
    const { at, total } = this.spec.search ? this.t.count() : { at: 0, total: -1 };
    const text = total < 0 ? "" : total ? `${at || "?"}/${total}` : "No results";
    // 没变不写（打字时每一步都会来一两次）
    if (this.n.textContent !== text) this.n.textContent = text;
    this.n.classList.toggle("none", total === 0);
  }

  close() {
    if (!this.open) return;
    this.closing = true;
    try {
      this.t.closed();
      this.el.remove();
    } finally {
      this.closing = false;
    }
  }

  private go(d: 1 | -1) {
    if (this.spec.search) {
      if (d > 0) this.t.next();
      else this.t.prev();
      this.refresh();
    }
  }
  private replace() {
    if (this.spec.search) {
      this.t.replace();
      this.refresh();
    }
  }
  private replaceAll() {
    if (this.spec.search) {
      this.t.replaceAll();
      this.refresh();
    }
  }
  private toggleCase() {
    this.spec = { ...this.spec, caseSensitive: !this.spec.caseSensitive };
    this.caseBtn.classList.toggle("on", this.spec.caseSensitive);
    this.caseBtn.setAttribute("aria-pressed", String(this.spec.caseSensitive));
    this.t.query(this.spec, true);
    this.refresh();
  }
  private showReplace(on: boolean) {
    this.bar.classList.toggle("repl", on);
    if (on) {
      this.r.focus({ preventScroll: true });
      this.r.select();
    } else this.q.focus({ preventScroll: true });
  }

  private key(e: KeyboardEvent, inReplace: boolean) {
    const mod = e.metaKey || e.ctrlKey,
      k = findKey(e);
    if (e.isComposing || e.key === "Process") {
      keepKey(e);
      return;
    }
    if (k) {
      e.preventDefault();
      if (k === "replace") this.showReplace(true);
      else {
        this.q.focus();
        this.q.select();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "Enter" && inReplace) {
      e.preventDefault();
      if (mod) this.replaceAll();
      else this.replace();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.go(e.shiftKey ? -1 : 1);
    } else if (e.altKey && !mod && e.code === "KeyC") {
      e.preventDefault();
      this.toggleCase();
    }
    keepKey(e);
  }
}

const div = (cls: string) => {
  const d = document.createElement("div");
  d.className = cls;
  return d;
};
function input(cls: string, ph: string) {
  const i = document.createElement("input");
  i.className = cls;
  i.placeholder = ph;
  i.spellcheck = false;
  i.setAttribute("aria-label", ph);
  return i;
}
/** data-tip / data-kbd 给用的一方的提示条（和选中工具条一样） */
function button(icon: IconName | null, tip: string, kbd: string, cls: string, run: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `tbtn${icon ? " md-ib" : ""}${cls ? ` ${cls}` : ""}`;
  b.dataset.tip = tip;
  b.dataset.kbd = kbd;
  b.setAttribute("aria-label", `${tip} (${kbd})`);
  if (icon) b.append(iconEl(icon));
  b.addEventListener("click", run);
  return b;
}
