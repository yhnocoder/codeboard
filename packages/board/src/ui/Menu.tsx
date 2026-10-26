// 自定义右键菜单、对话框、提示。浏览器自带的右键菜单全部屏蔽。
import { createSignal, For, Show, onCleanup, onMount, createEffect } from "solid-js";
import { Icon } from "./icons";
import { place, virtual } from "@yhnocoder/markdown/ui";
import { useOverlay } from "./overlay";

export type Item =
  | { label: string; kbd?: string; run?: () => void; disabled?: boolean | string; checked?: boolean; danger?: boolean; sub?: Item[]; hint?: string; head?: true }
  | null; // 分隔线。head = 不能点的小标题（共享卡：「… · on 2 boards」）

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
export const below = (el: Element) => { const r = el.getBoundingClientRect(); return [r.left, r.bottom + 4] as const; };
export const openMenuAt = (items: Item[], el: Element) => openMenu(items, ...below(el));
export const closeMenu = () => setMenu(null);
export const menuOpen = () => !!menu();

/** 开着的各级菜单，外层在前：键盘（↑↓ 选、→ 开二级、← / Esc 关二级、↵ 执行）只作用在最里面那一级 */
type Level = { move: (d: 1 | -1) => void; enter: () => void; activate: () => boolean; closeSub: () => void; kbSub: () => boolean };
const levels: Level[] = [];

function MenuList(p: { items: Item[]; x: number; y: number; onClose: () => void; up?: boolean; anchor?: Element; kb?: boolean }) {
  let el!: HTMLDivElement;
  const btns: HTMLButtonElement[] = [];
  const [pos, setPos] = createSignal({ x: p.x, y: p.y, ox: "0px", oy: "0px" });
  const [open, setOpen] = createSignal(false);
  const [subOf, setSubOf] = createSignal<{ i: number; x: number; y: number; el: Element; kb: boolean } | null>(null);
  /** 键盘选中的那一项（.kb，样子和悬停一样）；鼠标一动就交还给悬停 */
  const [kbAt, setKbAt] = createSignal<number | null>(null);
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
      btns[next]?.scrollIntoView({ block: "nearest" });
    },
    enter: () => { const i = kbAt(); if (i !== null && (p.items[i] as Exclude<Item, null>).sub) openSub(i, true); },
    activate: () => { const i = kbAt(); if (i === null) return false; btns[i]?.click(); return true; },
    closeSub: () => { const s = subOf(); setSubOf(null); if (s) setKbAt(s.i); },
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
      const w = el.offsetWidth, h = el.offsetHeight;
      setPos({ x, y, ox: `${Math.max(0, Math.min(w, p.x - x))}px`, oy: `${Math.max(0, Math.min(h, p.y - y))}px` });
      requestAnimationFrame(() => setOpen(true));
    });
    // 用 → 打开的二级菜单：选中第一项
    if (p.kb) level.move(1);
  });
  return (
    <><div ref={el} class="ctx" classList={{ open: open() }} role="menu" style={{ left: `${pos().x}px`, top: `${pos().y}px`, "max-height": `${window.innerHeight - 8}px`, "transform-origin": `${pos().ox} ${pos().oy}` }}
      data-nodrag onContextMenu={(e) => e.preventDefault()} onPointerMove={() => kbAt() !== null && setKbAt(null)}>
      <For each={p.items}>
        {(it, i) =>
          it?.head ? <div class="mh">{it.label}</div> : it ? (
            <button ref={(b) => (btns[i()] = b)} role="menuitem" class={it.danger ? "danger" : ""} classList={{ kb: kbAt() === i(), subopen: subOf()?.i === i() }}
              disabled={!!it.disabled} title={typeof it.disabled === "string" ? it.disabled : it.hint}
              aria-haspopup={it.sub ? "menu" : undefined} aria-expanded={it.sub ? subOf()?.i === i() : undefined}
              onPointerEnter={() => { if (it.sub && !it.disabled) openSub(i(), false); else setSubOf(null); }}
              onClick={() => {
                if (it.disabled) return;
                if (it.sub) return openSub(i(), kbAt() === i());
                p.onClose(); it.run?.();
              }}>
              <span class="ck">{it.checked ? <Icon name="check" size={12} /> : null}</span>
              <span class="lb">{it.label}</span>
              <Show when={it.kbd}><small title={it.kbd}>{it.kbd}</small></Show>
              <Show when={it.sub}><Icon name="chevR" size={12} /></Show>
            </button>
          ) : <hr />
        }
      </For>
    </div>
    <Show when={subOf()} keyed>
      {(s) => <MenuList items={(p.items[s.i] as Exclude<Item, null>).sub!} x={s.x} y={s.y} anchor={s.el} kb={s.kb} onClose={p.onClose} />}
    </Show></>
  );
}

/** 菜单的按键：↑↓ 在最里面一级里选，→ 打开选中项的二级菜单，← 关掉最里面的二级菜单，Esc 先关用 → 打开的二级菜单，悬停开的二级或没有二级时关整个菜单，↵ / 空格执行选中项 */
function menuKeys(e: KeyboardEvent) {
  const deep = levels.at(-1), parent = levels.at(-2);
  if (!deep || e.isComposing) return false;
  switch (e.key) {
    case "ArrowDown": deep.move(1); return true;
    case "ArrowUp": deep.move(-1); return true;
    case "ArrowRight": deep.enter(); return true;
    case "ArrowLeft": parent?.closeSub(); return true;
    case "Escape": if (!parent?.kbSub()) return false; parent.closeSub(); return true;
    case "Enter": case " ": return deep.activate();
  }
  return false;
}

function RootMenu(p: { m: MenuState }) {
  useOverlay({ close: closeMenu, inside: (t) => !!t.closest(".ctx"), grab: true, outside: true, blur: true, keys: menuKeys });
  return <MenuList items={p.m.items} x={p.m.x} y={p.m.y} up={p.m.up} onClose={closeMenu} />;
}
export function MenuLayer() {
  return <Show when={menu()} keyed>{(m) => <RootMenu m={m} />}</Show>;
}

// ---------- 对话框：问一次，粗框按钮 = 默认（↵） ----------

type DialogState = { title: string; text?: string; warn?: string; note?: string; options: string[]; def: number; done: (i: number | null) => void; input?: { value: string; placeholder?: string } };
const [dialog, setDialog] = createSignal<DialogState | null>(null);

/** warn = 琥珀色的一行提醒；note = 按钮下面的小字说明 */
export function choose(title: string, options: string[], opts: { text?: string; def?: number; warn?: string; note?: string } = {}): Promise<number | null> {
  return new Promise((done) => setDialog({ title, text: opts.text, warn: opts.warn, note: opts.note, options, def: opts.def ?? 0, done }));
}
export function promptText(title: string, value = "", placeholder = "", ok = "OK"): Promise<string | null> {
  return new Promise((done) => {
    let v = value;
    setDialog({ title, options: [ok, "Cancel"], def: 0, input: { value, placeholder }, done: (i) => done(i === 0 ? v.trim() || null : null) });
    queueMicrotask(() => {
      const inp = document.querySelector<HTMLInputElement>(".dialog input");
      if (inp) { inp.oninput = () => (v = inp.value); inp.focus(); inp.select(); }
    });
  });
}

const finish = (i: number | null) => { const d = dialog(); setDialog(null); d?.done(i); };
function Dialog(p: { d: DialogState }) {
  // Esc = 取消，↵ = 默认按钮（焦点在输入框里也一样）
  useOverlay({ close: () => finish(null), grab: true, modal: true, keys: (e) => e.key === "Enter" && !e.isComposing && (finish(p.d.def), true) });
  if (!p.d.input) queueMicrotask(() => document.querySelector<HTMLButtonElement>(".dialog .def")?.focus({ preventScroll: true }));
  const d = () => p.d;
  return (
        <div class="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) finish(null); }}>
          <div class="dialog" classList={{ wide: d().options.length > 2 }} role="dialog" aria-label={d().title}>
            <div class="dt">{d().title}</div>
            <Show when={d().text}><div class="dx">{d().text}</div></Show>
            <Show when={d().warn}><div class="dw">{d().warn}</div></Show>
            <Show when={d().input}><input type="text" value={d().input!.value} placeholder={d().input!.placeholder} spellcheck={false} /></Show>
            <div class="db">
              <For each={d().options}>{(o, i) => <button class={i() === d().def ? "def" : ""} onClick={() => finish(i())}>{o}</button>}</For>
            </div>
            <Show when={d().note}><div class="dn">{d().note}</div></Show>
          </div>
        </div>
  );
}
export function DialogLayer() {
  return <Show when={dialog()} keyed>{(d) => <Dialog d={d} />}</Show>;
}

// ---------- 按钮提示：停 500ms 出现并带快捷键；之后在按钮间滑动立刻切换；按下即消失 ----------

export function TooltipLayer() {
  const [tip, setTip] = createSignal<{ text: string; kbd?: string; at: HTMLElement } | null>(null);
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
  let el: HTMLDivElement | undefined, timer: number | undefined, warmUntil = 0;
  const show = (b: HTMLElement) => setTip({ text: b.dataset.tip!, kbd: b.dataset.kbd, at: b });
  // 按钮上方居中，放不下翻到下方
  createEffect(() => {
    const t = tip();
    if (!t || !el) return setPos(null);
    void place(el, t.at, "top", { gap: 8, pad: 4 }).then(({ x, y }) => { if (tip() === t) setPos({ x, y }); });
  });
  const hide = () => { clearTimeout(timer); if (tip()) warmUntil = performance.now() + 800; setTip(null); };
  const over = (e: PointerEvent) => {
    if (e.buttons) return; // 按着拖的时候经过按钮不弹提示（拖卡、框选、拖线……）
    const b = (e.target as HTMLElement).closest?.("[data-tip]") as HTMLElement | null;
    if (!b) return;
    clearTimeout(timer);
    if (tip() || performance.now() < warmUntil) show(b); else timer = window.setTimeout(() => show(b), 500);
  };
  const out = (e: PointerEvent) => {
    const b = (e.target as HTMLElement).closest?.("[data-tip]");
    const to = (e.relatedTarget as HTMLElement | null)?.closest?.("[data-tip]");
    if (b && !to) hide();
  };
  const down = () => { hide(); warmUntil = 0; };
  window.addEventListener("pointerover", over);
  window.addEventListener("pointerout", out);
  window.addEventListener("pointerdown", down, true);
  onCleanup(() => { window.removeEventListener("pointerover", over); window.removeEventListener("pointerout", out); window.removeEventListener("pointerdown", down, true); });
  return (
    <Show when={tip()}>
      {(t) => (
        <div ref={el} class="tip" classList={{ show: !!pos() }} style={{ left: `${pos()?.x ?? 0}px`, top: `${pos()?.y ?? 0}px` }}>
          {t().text}<Show when={t().kbd}><kbd>{t().kbd}</kbd></Show>
        </div>
      )}
    </Show>
  );
}
