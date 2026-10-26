// 画布这一块（箭头、Section、贴纸、旁注、多选、LOD、主题）的小样共用：搭白板的小工具、白板加载后再设的界面状态、假的贴纸包
import { createEffect, createMemo, on, onCleanup, onMount } from "solid-js";
import type { Board, Card, CodeCard, End, Link, Section, StickerPack } from "@codeboard/core";
import { select } from "../../src/state/store";
import { setDragging, setGuides, setSizeHint, setDropTarget, setRubber, setMarquee, setDragLink, setEditing } from "../../src/state/ui";
import { setMovingHome } from "../../src/state/sections";
import { setHoverLink, setHoverCard } from "../../src/state/hover";
import { idle } from "../../src/state/mode";
import { setStickerPick } from "../../src/state/stickers";
import { setTraffic } from "../../src/state/look";
import { loadPacks } from "../../src/stickers/glyphs";
import { Stage, type Globals, type Scene } from "./board";

/** 白板加载以后才能设的状态（加载时 boardSwitched 会把选中的线、贴纸、模式、讲解都清掉） */
export type CScene = Scene & { links?: string[]; sections?: string[]; after?: () => void };

/**
 * Stage 加上：选中的线和 Section、加载后的 after、精确的缩放（zoom 有值时盖过工具栏的 100 / 60 / 30，LOD 的小样要地图档）。
 * after 等两帧再做：卡先量好大小，线的几何才在
 */
export function CanvasStage(p: { scene: () => CScene; globals: Globals; zoom?: () => number | undefined }) {
  const sc = createMemo(p.scene);
  const g = p.globals;
  const globals = {
    get theme() { return g.theme; },
    get scheme() { return g.scheme; },
    get zoom() { const z = p.zoom?.(); return (z ? String(Math.round(z * 100)) : g.zoom) as Globals["zoom"]; },
  };
  let raf = 0;
  createEffect(on(sc, (s) => {
    cancelAnimationFrame(raf);
    reset();
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        if (s.links?.length || s.sections?.length) select({ links: s.links, sections: s.sections }, true);
        s.after?.();
      });
    });
  }));
  onCleanup(() => { cancelAnimationFrame(raf); reset(); });
  return <Stage scene={sc} globals={globals} />;
}

/** 小样设过的、换白板也不清的界面状态：换参数、换小样时清掉，不带到下一个 */
function reset() {
  setDragging(new Set<string>()); setGuides([]); setSizeHint(null); setDropTarget(null); setRubber(null); setMarquee(null); setMovingHome(null);
  setDragLink(null); setHoverLink(null); setHoverCard(null); setEditing(null); setStickerPick(null); setTraffic(false); idle();
}

// ---------- 搭白板 ----------

/** 代码卡里第一行含 word 的那一行（行端） */
export function ln(c: CodeCard, word: string): End {
  const s = c.segments[0];
  const i = s.text.findIndex((t) => t.includes(word));
  if (i < 0) throw new Error(`No line with "${word}" in ${s.scope ?? s.path}`);
  return { card: c.id, seg: s.id, line: s.start + i };
}
export const whole = (c: Card): End => ({ card: c.id });

type LinkExtra = Omit<Partial<Link>, "id" | "from" | "to">;
export function arrow(b: Board, id: string, from: End, to: End, x: LinkExtra = {}): Link {
  const L = { id, from, to, ...x } as Link;
  b.links.push(L);
  return L;
}
/** Section 和它的成员卡（成员按 Place.section，框由成员撑开） */
export function section(b: Board, s: Section, members: string[] = []): Section {
  b.sections.push(s);
  for (const id of members) b.place[id].section = s.id;
  return s;
}

export const SECTION_COLORS = ["none", "sand", "blue", "green", "pink"] as const;
export const LINK_COLORS = ["grey", "orange", "blue", "green"] as const;

// ---------- play ----------

export async function until<T>(what: string, get: () => T | null | undefined, ms = 6000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => requestAnimationFrame(r));
  }
}
export const $ = <E extends Element = HTMLElement>(sel: string) => document.querySelector<E>(sel);
/** pointerenter 不冒泡，Solid 直接挂在元素上：照浏览器的顺序发 over、enter */
export function hover(el: Element) {
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: "mouse" };
  el.dispatchEvent(new PointerEvent("pointerover", o));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...o, bubbles: false }));
}

// ---------- 贴纸包 ----------

// 假宿主（host.ts）对 stickerPacks 回空的；贴纸的小样挂着时换成一个文件夹包（位图、动图）。
// 图在 fixtures/assets/stickers，宿主给的是 data: URL（动图的第一帧要从它解码），所以先取回来转一次
const PACK_FILES: [name: string, file: string, anim?: true][] = [["smile", "smile.png"], ["banner", "banner.png"], ["wink", "wink.gif", true], ["blink", "blink.png", true]];
export const PACK = "Party";
let pack: Promise<StickerPack> | undefined;
const toData = (b: Blob) => new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result as string); r.onerror = fail; r.readAsDataURL(b); });
const packOf = () => (pack ??= Promise.all(PACK_FILES.map(async ([name, file, anim]) => {
  const img = await toData(await (await fetch(`sb-assets/stickers/${file}`)).blob());
  return anim ? { name, img, anim } : { name, img };
})).then((icons) => ({ id: PACK, name: PACK, icons })));

let packsOn = 0;
let hooked = false;
function hookPacks() {
  if (hooked) return;
  hooked = true;
  const sent = window.__cbSent!;
  const push = sent.push;
  sent.push = (...ms: unknown[]) => {
    const rest = ms.filter((m) => {
      const q = m as { type?: string; req?: number };
      if (!packsOn || q.type !== "stickerPacks" || typeof q.req !== "number") return true;
      void packOf().then((p) => window.postMessage({ type: "reply", req: q.req, data: [p] }, "*"));
      return false;
    });
    return rest.length ? push.apply(sent, rest) : sent.length;
  };
}
/** 在组件里调用：挂着的时候宿主有 Party 这个包，卸下时换回没有包（别的小样的选图标面板不多一页） */
export function usePacks() {
  hookPacks();
  packsOn++;
  // 白板加载（换白板）会让还没回的请求都失败（包就成了空的），所以等白板挂好再问
  onMount(() => requestAnimationFrame(() => void loadPacks(true)));
  onCleanup(() => { packsOn--; void loadPacks(true); });
}
