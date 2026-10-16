// 自定义右键菜单、对话框、提示。浏览器自带的右键菜单全部屏蔽。
import { createSignal, For, Show, onCleanup, onMount, createEffect } from "solid-js";
import { Icon } from "./icons";

export type Item =
  | { label: string; kbd?: string; run?: () => void; disabled?: boolean | string; checked?: boolean; danger?: boolean; sub?: Item[]; hint?: string }
  | null; // 分隔线

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
export const closeMenu = () => setMenu(null);
export const menuOpen = () => !!menu();

function MenuList(p: { items: Item[]; x: number; y: number; onClose: () => void; sub?: boolean; up?: boolean; alt?: number }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: p.x, y: p.y, ox: "0px", oy: "0px" });
  const [open, setOpen] = createSignal(false);
  const [subOf, setSubOf] = createSignal<{ i: number; x: number; y: number; alt: number } | null>(null);
  onMount(() => {
    // 用 offset 尺寸：打开动画里 scale < 1，getBoundingClientRect 会量小，贴边时伸出窗口几像素
    const r = { width: el.offsetWidth, height: el.offsetHeight };
    const W = window.innerWidth, H = window.innerHeight;
    // 放不下就往上翻；还放不下就限高滚动（最后一项总能看到）
    let y = p.up ? p.y - r.height : p.y;
    if (!p.up && y + r.height > H - 6 && p.y - r.height >= 4) y = p.y - r.height;
    // 二级菜单右边放不下：翻到一级菜单左边（不压在一级菜单上）
    const flip = p.sub && p.alt !== undefined && p.x + r.width > W - 6 && p.alt - r.width + 4 >= 4;
    const x = flip ? p.alt! - r.width + 4 : Math.max(4, Math.min(p.x, W - r.width - 6)), yy = Math.max(4, Math.min(y, H - r.height - 6));
    // 从点击的那一点展开（翻上去 / 被推到左边时，原点跟着换到那个角）
    setPos({ x, y: yy, ox: `${Math.max(0, Math.min(r.width, p.x - x))}px`, oy: `${Math.max(0, Math.min(r.height, (p.up ? p.y : p.y) - yy))}px` });
    requestAnimationFrame(() => setOpen(true));
  });
  return (
    <><div ref={el} class="ctx" classList={{ open: open() }} role="menu" style={{ left: `${pos().x}px`, top: `${pos().y}px`, "max-height": `${window.innerHeight - 8}px`, "transform-origin": `${pos().ox} ${pos().oy}` }}
      onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <For each={p.items}>
        {(it, i) =>
          it ? (
            <button role="menuitem" class={it.danger ? "danger" : ""} disabled={!!it.disabled} title={typeof it.disabled === "string" ? it.disabled : it.hint}
              onPointerEnter={(e) => {
                if (it.sub && !it.disabled) { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); if (subOf()?.i !== i()) setSubOf({ i: i(), x: r.right - 4, y: r.top - 5, alt: pos().x }); }
                else setSubOf(null);
              }}
              onClick={() => { if (it.sub || it.disabled) return; p.onClose(); it.run?.(); }}>
              <span class="ck">{it.checked ? <Icon name="check" size={12} /> : null}</span>
              <span class="lb">{it.label}</span>
              <Show when={it.kbd}><small>{it.kbd}</small></Show>
              <Show when={it.sub}><Icon name="chevR" size={12} /></Show>
            </button>
          ) : <hr />
        }
      </For>
    </div>
    <Show when={subOf()} keyed>
      {(s) => <MenuList items={(p.items[s.i] as Exclude<Item, null>).sub!} x={s.x} y={s.y} alt={s.alt} onClose={p.onClose} sub />}
    </Show></>
  );
}

export function MenuLayer() {
  const onDown = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.(".ctx")) closeMenu(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && menu()) { e.stopPropagation(); closeMenu(); } };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeMenu);
  onCleanup(() => { window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey, true); });
  return (
    <Show when={menu()} keyed>
      {(m) => <MenuList items={m.items} x={m.x} y={m.y} up={m.up} onClose={closeMenu} />}
    </Show>
  );
}

// ---------- 对话框：问一次，粗框按钮 = 默认（↵） ----------

type DialogState = { title: string; text?: string; options: string[]; def: number; done: (i: number | null) => void; input?: { value: string; placeholder?: string } };
const [dialog, setDialog] = createSignal<DialogState | null>(null);

export function choose(title: string, options: string[], opts: { text?: string; def?: number } = {}): Promise<number | null> {
  return new Promise((done) => setDialog({ title, text: opts.text, options, def: opts.def ?? 0, done }));
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
export const dialogOpen = () => !!dialog();

export function DialogLayer() {
  const finish = (i: number | null) => { const d = dialog(); setDialog(null); d?.done(i); };
  createEffect(() => {
    const d = dialog();
    if (!d) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
      else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); finish(d.def); }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
    if (!d.input) queueMicrotask(() => document.querySelector<HTMLButtonElement>(".dialog .def")?.focus({ preventScroll: true }));
  });
  return (
    <Show when={dialog()}>
      {(d) => (
        <div class="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) finish(null); }}>
          <div class="dialog" role="dialog" aria-label={d().title}>
            <div class="dt">{d().title}</div>
            <Show when={d().text}><div class="dx">{d().text}</div></Show>
            <Show when={d().input}><input type="text" value={d().input!.value} placeholder={d().input!.placeholder} spellcheck={false} /></Show>
            <div class="db">
              <For each={d().options}>{(o, i) => <button class={i() === d().def ? "def" : ""} onClick={() => finish(i())}>{o}</button>}</For>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

// ---------- 按钮提示：停 500ms 出现并带快捷键；之后在按钮间滑动立刻切换；按下即消失 ----------

export function TooltipLayer() {
  const [tip, setTip] = createSignal<{ text: string; kbd?: string; x: number; y: number; below: boolean } | null>(null);
  let timer: number | undefined, warmUntil = 0;
  const show = (b: HTMLElement) => {
    const r = b.getBoundingClientRect();
    const below = r.top < 60;
    setTip({ text: b.dataset.tip!, kbd: b.dataset.kbd, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
  };
  const hide = () => { clearTimeout(timer); if (tip()) warmUntil = performance.now() + 800; setTip(null); };
  const over = (e: PointerEvent) => {
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
        <div class="tip show" style={{ left: `${t().x}px`, top: `${t().y}px`, transform: `translate(-50%, ${t().below ? "0" : "-100%"})` }}>
          {t().text}<Show when={t().kbd}><kbd>{t().kbd}</kbd></Show>
        </div>
      )}
    </Show>
  );
}
