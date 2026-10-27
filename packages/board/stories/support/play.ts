// play 和 after 里像用户一样操作：等元素、点、悬停、右键、按键、打字。所有小样共用这一份
/** 等到 get 有值（每帧看一次）；等不到就报错，Storybook 的 play / 控制台能看到 */
export async function waitFor<T>(get: () => T | null | undefined | false, what = "the element", ms = 8000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => requestAnimationFrame(r));
  }
}
export const $ = <E extends Element = HTMLElement>(sel: string) => document.querySelector<E>(sel);
/** 等元素出现并且画出来了（卡要先画、量好行位置） */
export const el = <E extends Element = HTMLElement>(sel: string, ms?: number) =>
  waitFor(() => { const e = $<E>(sel); return e?.getClientRects().length ? e : null; }, sel, ms);
export const frames = (n = 2) => new Promise<void>((r) => { const k = () => (n-- <= 0 ? r() : requestAnimationFrame(k)); k(); });
/** 白板画好（卡挂上、量过尺寸）再操作：太早开的菜单会贴在还没摆好的元素上 */
export async function settled(sel = ".card") { await el(sel); await frames(4); }

const resolve = (t: string | Element) => (typeof t === "string" ? el(t) : Promise.resolve(t));
const center = (e: Element) => { const r = e.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };

export async function click(target: string | Element) { (await resolve(target) as HTMLElement).click(); }
/** 悬停：照浏览器的顺序发 over、enter（pointerenter 不冒泡，Solid 直接挂在元素上）；按钮的提示 500ms 后出来 */
export async function hover(target: string | Element) {
  const e = await resolve(target);
  const o = { bubbles: true, ...center(e), pointerType: "mouse" };
  e.dispatchEvent(new PointerEvent("pointerover", o));
  e.dispatchEvent(new PointerEvent("pointerenter", { ...o, bubbles: false }));
}
/** 真的指针事件（白板的手势认 pointerdown / up，不认合成的 click） */
export function pointer(e: Element, type: "pointerdown" | "pointerup" | "pointermove" | "pointerenter" | "pointerover", at?: { x: number; y: number }) {
  const c = center(e);
  const x = at?.x ?? c.clientX, y = at?.y ?? c.clientY;
  e.dispatchEvent(new PointerEvent(type, { bubbles: type !== "pointerenter", clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }));
}
/** 右键：坐标默认在元素中间（菜单从那里开） */
export async function rightClick(target: string | Element, at?: { x: number; y: number }) {
  const e = await resolve(target);
  const p = at ? { clientX: at.x, clientY: at.y } : center(e);
  e.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...p }));
}
/** 右键一条线：落在路径的中点上 */
export async function rightClickLink(id: string) {
  const p = await el<SVGPathElement>(`path.lhit[data-link="${id}"]`);
  const m = p.getPointAtLength(p.getTotalLength() / 2), ctm = p.getScreenCTM()!;
  await rightClick(p, { x: ctm.a * m.x + ctm.c * m.y + ctm.e, y: ctm.b * m.x + ctm.d * m.y + ctm.f });
}
export async function key(k: string, o: KeyboardEventInit = {}) {
  (document.activeElement ?? window).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o }));
  await frames(1);
}
/** 输入框里打字（走 Solid 的 onInput）；commit = 再发 change（设置页的数字框） */
export async function type(target: string | HTMLInputElement, text: string, o: { commit?: boolean } = {}) {
  const i = await resolve(target) as HTMLInputElement;
  i.focus();
  i.value = text;
  i.dispatchEvent(new InputEvent("input", { bubbles: true }));
  if (o.commit) i.dispatchEvent(new Event("change", { bubbles: true }));
  await frames(2);
}
