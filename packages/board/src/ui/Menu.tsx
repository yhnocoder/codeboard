import { createSignal, For, Show, onCleanup, onMount, createEffect, createMemo, on } from "solid-js";
import { Icon } from "./icons";
import { place, virtual, scrollIntoBox } from "@yhnocoder/markdown/ui";
import { useOverlay } from "./overlay";
import { useListNav } from "./hooks";
import { TIP_DELAY } from "../state/timing";

export type Item = {
  label: string;
  kbd?: string;
  run?: () => void;
  disabled?: boolean | string;
  checked?: boolean;
  danger?: boolean;
  sub?: Item[];
  hint?: string;
  head?: true;
  keep?: true;
  inset?: true;
} | null; // 分隔线。head = 不能点的小标题（共享卡：「… · on 2 boards」）。
// keep = 勾选项点了只切换、菜单不关（Convert to SVG 下面的选项）；inset = 缩进一级，表示它属于上面那一项

type MenuState = { items: Item[]; x: number; y: number; n: number; up?: boolean };
const [menu, setMenu] = createSignal<MenuState | null>(null);
let menuN = 0;

/** up：y 是菜单底边（从工具栏往上开） */
export function openMenu(items: Item[], x: number, y: number, o: { up?: boolean } = {}) {
  // 连续的分隔线、首尾分隔线去掉
  const clean: Item[] = [];
  for (const it of items) if (it || (clean.length && clean[clean.length - 1])) clean.push(it);
  while (clean.length && !clean[clean.length - 1]) clean.pop();
  if (!clean.length) return;
  setMenu({ items: clean, x, y, n: ++menuN, up: o.up });
}
/** 元素正下方、左对齐：卡头的 ⋯、版本号之类的按钮弹菜单的位置 */
export const below = (el: Element) => {
  const r = el.getBoundingClientRect();
  return [r.left, r.bottom + 4] as const;
};
export const openMenuAt = (items: Item[], el: Element) => openMenu(items, ...below(el));
const closeMenu = () => setMenu(null);
export const menuOpen = () => !!menu();
/** 按钮自己弹出的菜单是不是还开着：卡头的 ⋯ 平时藏着（styles.css .cmenu），它的菜单开着时鼠标移进菜单也得留着 */
export function ownMenu() {
  const [n, setN] = createSignal(-1);
  return { open: () => menu()?.n === n(), opened: () => setN(menu()?.n ?? -1) };
}

/** 开着的各级菜单，外层在前：键盘（↑↓ 选、→ 开二级、← / Esc 关二级、↵ 执行）只作用在最里面那一级 */
type Level = {
  move: (d: 1 | -1) => void;
  enter: () => void;
  activate: () => boolean;
  closeSub: () => void;
  kbSub: () => boolean;
};
const levels: Level[] = [];

function MenuList(p: {
  items: Item[];
  x: number;
  y: number;
  onClose: () => void;
  up?: boolean;
  anchor?: Element;
  kb?: boolean;
}) {
  let el!: HTMLDivElement;
  const btns: HTMLButtonElement[] = [];
  const [pos, setPos] = createSignal({ x: p.x, y: p.y, ox: "0px", oy: "0px" });
  const [open, setOpen] = createSignal(false);
  const [subOf, setSubOf] = createSignal<{ i: number; x: number; y: number; el: Element; kb: boolean } | null>(null);
  /** 键盘选中的那一项（.kb，样子和悬停一样）；鼠标一动就交还给悬停 */
  const [kbAt, setKbAt] = createSignal<number | null>(null);
  /** 点过的 keep 项（勾选状态跟着翻） */
  const [flipped, setFlipped] = createSignal<ReadonlySet<number>>(new Set());
  const checked = (it: Exclude<Item, null>, i: number) => !!it.checked !== flipped().has(i);
  const live = (it: Item) => !!it && !it.head && !it.disabled;
  const openSub = (i: number, kb: boolean) => {
    const b = btns[i];
    if (!b || subOf()?.i === i) return;
    const r = b.getBoundingClientRect();
    setSubOf({ i, x: r.right, y: r.top - 5, el: b, kb });
  };
  const level: Level = {
    move: (d) => {
      const ids = p.items.map((it, i) => (live(it) ? i : -1)).filter((i) => i >= 0);
      if (!ids.length) return;
      const k = ids.indexOf(kbAt() ?? -1);
      const next = ids[k < 0 ? (d > 0 ? 0 : ids.length - 1) : (k + d + ids.length) % ids.length];
      setKbAt(next);
      const b = btns[next];
      if (b) scrollIntoBox(b, "nearest");
    },
    enter: () => {
      const i = kbAt();
      if (i !== null && (p.items[i] as Exclude<Item, null>).sub) openSub(i, true);
    },
    activate: () => {
      const i = kbAt();
      if (i === null) return false;
      btns[i]?.click();
      return true;
    },
    closeSub: () => {
      const s = subOf();
      setSubOf(null);
      if (s) setKbAt(s.i);
    },
    kbSub: () => !!subOf()?.kb,
  };
  levels.push(level);
  onCleanup(() => levels.splice(levels.indexOf(level), 1));
  onMount(() => {
    // 右键菜单从点往右下开（up：从工具栏往上开）；二级菜单贴着父项往右开；放不下翻到另一边，太高就限高滚动
    const at = p.anchor
      ? place(el, p.anchor, "right-start", { gap: { crossAxis: -5 }, pad: 4 })
      : place(el, virtual(p), p.up ? "top-start" : "bottom-start", { pad: 4 });
    void at.then(({ x, y }) => {
      // 从点击的那一点展开（翻上去 / 被推到左边时，原点跟着换到那个角）
      const w = el.offsetWidth,
        h = el.offsetHeight;
      setPos({ x, y, ox: `${Math.max(0, Math.min(w, p.x - x))}px`, oy: `${Math.max(0, Math.min(h, p.y - y))}px` });
      requestAnimationFrame(() => setOpen(true));
    });
    // 用 → 打开的二级菜单：选中第一项
    if (p.kb) level.move(1);
  });
  return (
    <>
      <div
        ref={el}
        class="ctx"
        classList={{ open: open() }}
        role="menu"
        style={{
          left: `${pos().x}px`,
          top: `${pos().y}px`,
          "max-height": `${window.innerHeight - 8}px`,
          "transform-origin": `${pos().ox} ${pos().oy}`,
        }}
        data-nodrag
        onContextMenu={(e) => e.preventDefault()}
        onPointerMove={() => kbAt() !== null && setKbAt(null)}
      >
        <For each={p.items}>
          {(it, i) =>
            it?.head ? (
              <div class="mh">{it.label}</div>
            ) : it ? (
              <button
                ref={(b) => (btns[i()] = b)}
                role={it.keep ? "menuitemcheckbox" : "menuitem"}
                aria-checked={it.keep ? checked(it, i()) : undefined}
                class={it.danger ? "danger" : ""}
                classList={{ kb: kbAt() === i(), subopen: subOf()?.i === i(), inset: !!it.inset }}
                disabled={!!it.disabled}
                title={typeof it.disabled === "string" ? it.disabled : it.hint}
                aria-haspopup={it.sub ? "menu" : undefined}
                aria-expanded={it.sub ? subOf()?.i === i() : undefined}
                onPointerEnter={() => {
                  if (it.sub && !it.disabled) openSub(i(), false);
                  else setSubOf(null);
                }}
                onClick={() => {
                  if (it.disabled) return;
                  if (it.sub) return openSub(i(), kbAt() === i());
                  if (it.keep) {
                    const k = i();
                    setFlipped((f) => {
                      const n = new Set(f);
                      if (!n.delete(k)) n.add(k);
                      return n;
                    });
                    return it.run?.();
                  }
                  p.onClose();
                  it.run?.();
                }}
              >
                <span class="ck">{checked(it, i()) ? <Icon name="check" size={12} /> : null}</span>
                <span class="lb">{it.label}</span>
                <Show when={it.kbd}>
                  <small title={it.kbd}>{it.kbd}</small>
                </Show>
                <Show when={it.sub}>
                  <Icon name="chevR" size={12} />
                </Show>
              </button>
            ) : (
              <hr />
            )
          }
        </For>
      </div>
      <Show when={subOf()} keyed>
        {(s) => (
          <MenuList
            items={(p.items[s.i] as Exclude<Item, null>).sub!}
            x={s.x}
            y={s.y}
            anchor={s.el}
            kb={s.kb}
            onClose={p.onClose}
          />
        )}
      </Show>
    </>
  );
}

/** 菜单的按键：↑↓ 在最里面一级里选，→ 打开选中项的二级菜单，← 关掉最里面的二级菜单，Esc 先关用 → 打开的二级菜单，悬停开的二级或没有二级时关整个菜单，↵ / 空格执行选中项 */
function menuKeys(e: KeyboardEvent) {
  const deep = levels.at(-1),
    parent = levels.at(-2);
  if (!deep || e.isComposing) return false;
  switch (e.key) {
    case "ArrowDown":
      deep.move(1);
      return true;
    case "ArrowUp":
      deep.move(-1);
      return true;
    case "ArrowRight":
      deep.enter();
      return true;
    case "ArrowLeft":
      parent?.closeSub();
      return true;
    case "Escape":
      if (!parent?.kbSub()) return false;
      parent.closeSub();
      return true;
    case "Enter":
    case " ":
      return deep.activate();
  }
  return false;
}

function RootMenu(p: { m: MenuState }) {
  useOverlay({
    close: closeMenu,
    inside: (t) => !!t.closest(".ctx"),
    grab: true,
    outside: true,
    blur: true,
    keys: menuKeys,
  });
  return <MenuList items={p.m.items} x={p.m.x} y={p.m.y} up={p.m.up} onClose={closeMenu} />;
}
export function MenuLayer() {
  return (
    <Show when={menu()} keyed>
      {(m) => <RootMenu m={m} />}
    </Show>
  );
}

export type PickRow = { label: string; description?: string; detail?: string };
type DialogState = {
  title: string;
  text?: string;
  warn?: string;
  note?: string;
  options: string[];
  def: number;
  done: (i: number | null) => void;
  input?: { value: string; placeholder?: string; password?: boolean };
  /** A list to choose from (pickOne): done gets the index of the row chosen */
  pick?: PickRow[];
};
const [dialog, setDialog] = createSignal<DialogState | null>(null);

/** 同一时间只有一个对话框：新的盖掉旧的时，旧的那个当作取消（null），等它的不会一直挂着 */
function openDialog(d: DialogState) {
  const old = dialog();
  setDialog(d);
  old?.done(null);
}
/** warn = 琥珀色的一行提醒；note = 按钮下面的小字说明 */
export function choose(
  title: string,
  options: string[],
  opts: { text?: string; def?: number; warn?: string; note?: string } = {},
): Promise<number | null> {
  return new Promise((done) =>
    openDialog({ title, text: opts.text, warn: opts.warn, note: opts.note, options, def: opts.def ?? 0, done }),
  );
}
/** o.text: a line under the title; o.password: the text is a secret (shown as dots) */
export function promptText(
  title: string,
  value = "",
  placeholder = "",
  ok = "OK",
  o: { text?: string; password?: boolean } = {},
): Promise<string | null> {
  return new Promise((done) => {
    let v = value;
    openDialog({
      title,
      text: o.text,
      options: [ok, "Cancel"],
      def: 0,
      input: { value, placeholder, password: o.password },
      done: (i) => done(i === 0 ? v.trim() || null : null),
    });
    queueMicrotask(() => {
      const inp = document.querySelector<HTMLInputElement>(".dialog input");
      if (inp) {
        inp.oninput = () => (v = inp.value);
        inp.focus();
        inp.select();
      }
    });
  });
}
/** One of rows: typing filters them (by label and description), ↑↓ move, ↵ or a click chooses. Resolves to the row's index */
export function pickOne(title: string, rows: PickRow[]): Promise<number | null> {
  return new Promise((done) => openDialog({ title, options: [], def: 0, pick: rows, done }));
}

const finish = (i: number | null) => {
  const d = dialog();
  setDialog(null);
  d?.done(i);
};
function PickList(p: {
  rows: PickRow[];
  nav: (k: (e: KeyboardEvent) => boolean, chosen: () => number | undefined) => void;
}) {
  const [q, setQ] = createSignal("");
  const shown = createMemo(() => {
    const t = q().trim().toLowerCase();
    return p.rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !t || `${r.label} ${r.description ?? ""}`.toLowerCase().includes(t));
  });
  const { i, setI, key } = useListNav(() => shown().length);
  createEffect(on(q, () => setI(0), { defer: true }));
  let list!: HTMLDivElement, inp!: HTMLInputElement;
  createEffect(() => {
    i();
    const on = list?.querySelector(".cand.on");
    if (on) scrollIntoBox(on, "nearest");
  });
  p.nav(key, () => shown()[i()]?.i);
  onMount(() => inp.focus());
  return (
    <>
      <input
        ref={inp}
        type="text"
        placeholder="Type to filter"
        spellcheck={false}
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      <div ref={list} class="plist dpick" role="listbox">
        <For each={shown()}>
          {(x, k) => (
            <button
              class="cand"
              classList={{ on: k() === i(), two: !!x.r.detail }}
              role="option"
              aria-selected={k() === i()}
              onPointerMove={(e) => {
                if (e.movementX || e.movementY) setI(k());
              }}
              onClick={() => finish(x.i)}
            >
              <span class="lb">
                {x.r.label}
                <Show when={x.r.detail}>
                  <span class="dd">{x.r.detail}</span>
                </Show>
              </span>
              <Show when={x.r.description}>
                <small>{x.r.description}</small>
              </Show>
            </button>
          )}
        </For>
        <Show when={!shown().length}>
          <div class="empty">No matches</div>
        </Show>
      </div>
    </>
  );
}
function Dialog(p: { d: DialogState }) {
  // Esc = 取消，↵ = 默认按钮（焦点在输入框里也一样）；选列表的对话框：↵ 选高亮的那行，↑↓ 换行
  let navKey: ((e: KeyboardEvent) => boolean) | undefined, chosen: (() => number | undefined) | undefined;
  const keys = (e: KeyboardEvent) => {
    if (!p.d.pick) return e.key === "Enter" && !e.isComposing && (finish(p.d.def), true);
    if (navKey?.(e)) return true;
    if (e.key !== "Enter" || e.isComposing) return false;
    const c = chosen?.();
    if (c !== undefined) finish(c);
    return true;
  };
  useOverlay({ close: () => finish(null), grab: true, modal: true, keys });
  if (!p.d.input && !p.d.pick)
    queueMicrotask(() => document.querySelector<HTMLButtonElement>(".dialog .def")?.focus({ preventScroll: true }));
  // VS Code gives a webview the keyboard in two steps, its host page first and then the board's frame, and Chrome delivers the first
  // one to the webview's process on its own time: a dialog asked for right after (a palette command) can focus its field before that
  // lands, and the landing takes the focus out of the board's frame and clears it. When the frame then gets the keyboard back with
  // nothing in the dialog focused, it goes to the dialog's field (a text field keeps its selection)
  let box!: HTMLDivElement;
  const takeKeyboard = () => {
    if (box.contains(document.activeElement)) return;
    (box.querySelector("input") ?? box.querySelector<HTMLButtonElement>(".def"))?.focus({ preventScroll: true });
  };
  window.addEventListener("focus", takeKeyboard);
  onCleanup(() => window.removeEventListener("focus", takeKeyboard));
  const d = () => p.d;
  return (
    <div
      class="scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) finish(null);
      }}
    >
      <div
        ref={box}
        class="dialog"
        classList={{ wide: d().options.length > 2 || !!d().pick }}
        role="dialog"
        aria-label={d().title}
      >
        <div class="dt">{d().title}</div>
        <Show when={d().text}>
          <div class="dx">{d().text}</div>
        </Show>
        <Show when={d().warn}>
          <div class="dw">{d().warn}</div>
        </Show>
        <Show when={d().input}>
          <input
            type={d().input!.password ? "password" : "text"}
            value={d().input!.value}
            placeholder={d().input!.placeholder}
            spellcheck={false}
          />
        </Show>
        <Show when={d().pick}>
          <PickList
            rows={d().pick!}
            nav={(k, c) => {
              navKey = k;
              chosen = c;
            }}
          />
        </Show>
        <div class="db">
          <Show when={d().pick}>
            <button onClick={() => finish(null)}>Cancel</button>
          </Show>
          <For each={d().options}>
            {(o, i) => (
              <button class={i() === d().def ? "def" : ""} onClick={() => finish(i())}>
                {o}
              </button>
            )}
          </For>
        </div>
        <Show when={d().note}>
          <div class="dn">{d().note}</div>
        </Show>
      </div>
    </div>
  );
}
export function DialogLayer() {
  return (
    <Show when={dialog()} keyed>
      {(d) => <Dialog d={d} />}
    </Show>
  );
}

// 按钮提示：停一会儿出现并带快捷键；之后在按钮间滑动立刻切换；按下即消失

export function TooltipLayer() {
  const [tip, setTip] = createSignal<{ text: string; kbd?: string; at: HTMLElement } | null>(null);
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
  let el: HTMLDivElement | undefined,
    timer: number | undefined,
    warmUntil = 0;
  const show = (b: HTMLElement) => setTip({ text: b.dataset.tip!, kbd: b.dataset.kbd, at: b });
  // 按钮上方居中，放不下翻到下方
  createEffect(() => {
    const t = tip();
    if (!t || !el) return setPos(null);
    void place(el, t.at, "top", { gap: 8, pad: 4 }).then(({ x, y }) => {
      if (tip() === t) setPos({ x, y });
    });
  });
  const hide = () => {
    clearTimeout(timer);
    if (tip()) warmUntil = performance.now() + 800;
    setTip(null);
  };
  const over = (e: PointerEvent) => {
    if (e.buttons) return; // 按着拖的时候经过按钮不弹提示（拖卡、框选、拖线……）
    const b = (e.target as HTMLElement).closest?.("[data-tip]") as HTMLElement | null;
    if (!b) return;
    clearTimeout(timer);
    if (tip() || performance.now() < warmUntil) show(b);
    else timer = window.setTimeout(() => show(b), TIP_DELAY);
  };
  const out = (e: PointerEvent) => {
    const b = (e.target as HTMLElement).closest?.("[data-tip]");
    const to = (e.relatedTarget as HTMLElement | null)?.closest?.("[data-tip]");
    if (b && !to) hide();
  };
  const down = () => {
    hide();
    warmUntil = 0;
  };
  window.addEventListener("pointerover", over);
  window.addEventListener("pointerout", out);
  window.addEventListener("pointerdown", down, true);
  onCleanup(() => {
    window.removeEventListener("pointerover", over);
    window.removeEventListener("pointerout", out);
    window.removeEventListener("pointerdown", down, true);
  });
  return (
    <Show when={tip()}>
      {(t) => (
        <div
          ref={el}
          class="tip"
          classList={{ show: !!pos() }}
          style={{ left: `${pos()?.x ?? 0}px`, top: `${pos()?.y ?? 0}px` }}
        >
          {t().text}
          <Show when={t().kbd}>
            <kbd>{t().kbd}</kbd>
          </Show>
        </div>
      )}
    </Show>
  );
}
