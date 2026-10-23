// 代码编辑器（CodeMirror，@codeboard/markdown/code-editor）单独打包，第一次编辑代码前才要；白板打开后空闲时先悄悄加载好。
// 这里还有编辑器要的宿主能力：语言服务（补全、悬停、签名）、灰字补全、着色。
import type { Segment, SegView, LspItem, LspSignature } from "@codeboard/core";
import { unwrap } from "solid-js/store";
import { state } from "../state/store";
import { ask, send } from "../host";
import { renderMd } from "@codeboard/markdown";
import type { LspHost, GhostHost, LspItem as EditorLspItem, LspSignature as EditorLspSignature } from "@codeboard/markdown/code-editor";

type Mod = typeof import("@codeboard/markdown/code-editor");
let mod: Promise<Mod> | undefined, ready: Mod | undefined;
export const loadCm = () => (mod ??= import("@codeboard/markdown/code-editor").then((m) => (ready = m)).catch((e) => { mod = undefined; throw e; }));
/** 已经加载好了就直接拿（同一帧里挂上，不等 Promise） */
export const cmNow = () => ready;

/** 白板打开后空闲时预加载（编辑器包加载完之后） */
export function preloadCm() {
  const ric = (window as any).requestIdleCallback as ((cb: (d: IdleDeadline) => void) => void) | undefined;
  const go = () => void loadCm().catch(() => undefined);
  setTimeout(() => (ric ? ric((d) => (d.timeRemaining() > 20 ? go() : setTimeout(go, 500))) : go()), 4000);
}

/** 放在哪段代码旁边（Python 的 import 按它的目录找）：和这张卡连着线的本地代码，其次是白板上同语言的本地代码 */
export function nearSeg(card: string, lang: string): Pick<Segment, "src" | "path" | "version"> | undefined {
  const b = state.board;
  const local = (s: Segment) => s.src.kind === "repo" || s.src.kind === "external";
  const segsOf = (id: string) => { const c = b.cards.find((x) => x.id === id); return c && c.kind === "code" ? c.segments.filter(local) : []; };
  const linked = b.links.flatMap((l) => (l.from.card === card ? [l.to.card] : l.to.card === card ? [l.from.card] : []));
  const pick = (ss: Segment[]) => ss.find((s) => s.lang === lang) ?? ss[0];
  const s = pick(linked.flatMap(segsOf)) ?? b.cards.flatMap((c) => (c.kind === "code" ? c.segments.filter((x) => local(x) && x.lang === lang) : []))[0];
  // 白板的状态是 Solid 的 store（代理对象）：发给宿主前拷成普通对象（postMessage 拷不了代理）
  return s && { src: { ...unwrap(s.src) }, path: s.path, version: { ...unwrap(s.version) } };
}

// 宿主发来的补全、签名（core 的类型）原样交给编辑器（@codeboard/markdown 的类型）：两边要能互相赋值，哪边改了这里编译不过
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type LspTypesAgree = [Assert<Same<LspItem, EditorLspItem>>, Assert<Same<LspSignature, EditorLspSignature>>];

/** 语言服务：id = 这段编辑中的代码（宿主给它一个虚拟文档）；编辑器拆掉时 close 关掉它 */
export function lspHost(id: string, lang: () => string, near?: () => Pick<Segment, "src" | "path" | "version"> | undefined): LspHost {
  let opened = false;
  const open = (text: string) => { opened = true; send({ type: "codeDoc", id, lang: lang(), text, near: near?.() }); };
  return {
    sync: (text) => open(text),
    complete: (text, line, col, trigger) => { if (!opened) open(text); return ask("lspComplete", { id, text, line, col, trigger }); },
    hover: (text, line, col) => { if (!opened) open(text); return ask("lspHover", { id, text, line, col }); },
    signature: (text, line, col, trigger) => { if (!opened) open(text); return ask("lspSignature", { id, text, line, col, trigger }); },
    md: (src) => renderMd(src),
    close: () => send({ type: "codeDocClose", id }),
  };
}

/** 灰字补全（宿主能做 AI 续写时） */
export const ghostHost = (): GhostHost | undefined => (state.host.complete ? { complete: (before, after) => ask("complete", { before, after }).catch(() => null) } : undefined);

/** 着色问宿主（和代码卡同一套 views）：seg 换成这段文字，给整段的 HTML（每行之间一个 \n） */
export async function hostHighlight(seg: Segment, text: string): Promise<string | null> {
  const ls = text.split("\n");
  const s: Segment = { ...structuredClone(unwrap(seg)), text: ls, end: seg.start + ls.length - 1 };
  const v = (await ask("views", { segs: [s] }).catch(() => null)) as Record<string, SegView> | null;
  return v?.[s.id]?.html.join("\n") ?? null;
}
/** Note 里的代码块当一段手写代码问着色 */
export const noteHighlight = (text: string, lang: string) =>
  hostHighlight({ id: "note-code", src: { kind: "free" }, path: "", lang, start: 1, end: 1, text: [], version: { kind: "none" } }, text);
