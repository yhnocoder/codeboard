// 自由代码卡的编辑：和显示时一模一样（同一个 .code 排版、行号栏、宿主给的着色），上面盖一个透明的 textarea 接打字。
// 改了的行先按原文显示，宿主的着色回来就换上（一次只问一个，回来时字又变了再问）；当前行有底色。
// Tab / ⇧Tab 缩进（多行一起），回车保持缩进（: { [ ( 结尾多缩一级），⌘/ 切换注释，Esc / ⌘↵ 结束
import { createEffect, createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import { unwrap } from "solid-js/store";
import type { CodeCard, SegView } from "@codeboard/core";
import { state } from "../state/store";
import { ask } from "../host";
import { keepKey } from "../ui/editkeys";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const IND = "    ";
const COMMENT: Record<string, string> = { python: "#", shell: "#", bash: "#", ruby: "#", yaml: "#", toml: "#", r: "#", perl: "#", sql: "--", lua: "--", haskell: "--" };
const commentOf = (lang?: string) => COMMENT[lang ?? ""] ?? "//";

type Hl = { lines: string[]; html: string[] };

export function FreeEdit(p: { card: () => CodeCard; wrap: () => boolean; onBlur: (e: FocusEvent & { currentTarget: HTMLTextAreaElement }) => void; onExit: (text: string) => void }) {
  let exited = false;
  let ta!: HTMLTextAreaElement, src!: HTMLDivElement;
  const seg = () => p.card().segments[0];
  const [text, setText] = createSignal(seg().text.join("\n"));
  const lines = createMemo(() => text().split("\n"));
  const v0: SegView | undefined = state.views[seg().id];
  const [hl, setHl] = createSignal<Hl>({ lines: seg().text.slice(), html: v0?.html.slice() ?? [] });
  const [cur, setCur] = createSignal(0);
  const [ys, setYs] = createSignal<number[] | null>(null);

  // 这一行的着色：同一行号上的原文没变就用；不然按"后面的行没动"往回对一次（插了 / 删了行时下面的行不闪）
  const lineHtml = (i: number) => {
    const t = lines()[i], h = hl();
    if (h.lines[i] === t && h.html[i] !== undefined) return h.html[i];
    const j = i - (lines().length - h.lines.length);
    if (j >= 0 && h.lines[j] === t && h.html[j] !== undefined) return h.html[j];
    return esc(t);
  };

  // 着色问宿主：一次一个，回来时字又变了就再问
  let busy = false, gone = false;
  const rehighlight = async () => {
    if (busy || gone) return;
    busy = true;
    const ls = lines();
    const s = structuredClone(unwrap(seg()));
    s.text = ls; s.end = s.start + ls.length - 1;
    try {
      const v = (await ask("views", { segs: [s] }).catch(() => null)) as Record<string, SegView> | null;
      const got = v?.[s.id];
      if (got && !gone) setHl({ lines: ls, html: got.html });
    } finally { busy = false; }
    if (!gone && lines() !== ls) void rehighlight();
  };

  const syncCur = () => { if (ta) setCur(ta.value.slice(0, ta.selectionStart).split("\n").length - 1); };
  const onSel = () => { if (document.activeElement === ta) syncCur(); };
  onMount(() => {
    document.addEventListener("selectionchange", onSel);
    queueMicrotask(() => { ta.focus({ preventScroll: true }); syncCur(); });
  });
  onCleanup(() => { gone = true; document.removeEventListener("selectionchange", onSel); });
  // 折行时行高不一：按实际的行量位置（不折行时就是 20px 一行）
  createEffect(() => {
    lines();
    if (!p.wrap()) return setYs(null);
    queueMicrotask(() => { if (src) setYs([...src.children].map((e) => (e as HTMLElement).offsetTop)); });
  });
  // 相对 .code（上面有 6px 的 padding），和显示时的行号一样
  // 换了语言：重新着色
  let lang0 = seg().lang;
  createEffect(() => { const l = seg().lang; if (l !== lang0) { lang0 = l; void rehighlight(); } });
  const top = (i: number) => 6 + (ys()?.[i] ?? i * 20);
  const height = (i: number) => { const y = ys(); return y ? (y[i + 1] ?? src?.offsetHeight ?? 20) - y[i] : 20; };

  /** 选中的那几行一起改：fn 拿到这些行，返回新的；用 insertText 改，textarea 自己的撤销还能用 */
  const editLines = (fn: (ls: string[]) => string[]) => {
    const v = ta.value, s0 = ta.selectionStart, e0 = ta.selectionEnd;
    const a = v.lastIndexOf("\n", s0 - 1) + 1;
    const endAt = e0 > s0 && v[e0 - 1] === "\n" ? e0 - 1 : e0;
    const b = v.indexOf("\n", endAt) < 0 ? v.length : v.indexOf("\n", endAt);
    const old = v.slice(a, b), next = fn(old.split("\n")).join("\n");
    if (next === old) return;
    ta.setSelectionRange(a, b);
    document.execCommand("insertText", false, next);
    if (old.includes("\n") || e0 > s0) ta.setSelectionRange(a, a + next.length);
    else { const c = Math.max(a, s0 + next.length - old.length); ta.setSelectionRange(c, c); }
  };
  const onKey = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    keepKey(e);
    const mod = e.metaKey || e.ctrlKey;
    if (e.isComposing) return;
    // Esc / ⌘↵：直接存好退出（不走 blur：blur 时分不清是不是点了这张卡自己的东西）
    if (e.key === "Escape" || (e.key === "Enter" && mod)) { e.preventDefault(); exited = true; p.onExit(ta.value); return; }
    if (e.key === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes("\n");
      if (e.shiftKey) editLines((ls) => ls.map((l) => l.replace(/^(?: {1,4}|\t)/, "")));
      else if (multi) editLines((ls) => ls.map((l) => (l ? IND + l : l)));
      else document.execCommand("insertText", false, IND);
      return;
    }
    if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const v = ta.value, s0 = ta.selectionStart;
      const line = v.slice(v.lastIndexOf("\n", s0 - 1) + 1, s0);
      const ind = /^[ \t]*/.exec(line)![0] + (/[:{[(]\s*$/.test(line) ? IND : "");
      document.execCommand("insertText", false, `\n${ind}`);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && (e.key === "/" || e.code === "Slash")) {
      e.preventDefault();
      const c = commentOf(seg().lang);
      editLines((ls) => {
        const body = ls.filter((l) => l.trim());
        const on = body.length > 0 && body.every((l) => l.trimStart().startsWith(c));
        const ind = Math.min(...body.map((l) => l.length - l.trimStart().length));
        return ls.map((l) => {
          if (!l.trim()) return l;
          if (on) return l.replace(new RegExp(`^(\\s*)${c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")} ?`), "$1");
          return `${l.slice(0, ind)}${c} ${l.slice(ind)}`;
        });
      });
    }
  };

  return (
    <div class="code freecode">
      <div class="gutter">
        <For each={lines()}>{(_, i) => <span class="no" style={{ top: `${top(i())}px` }}>{seg().start + i()}</span>}</For>
      </div>
      <div class="rowbgs"><div class="rowbg cur" style={{ top: `${top(cur())}px`, height: `${height(cur())}px` }} /></div>
      <div ref={src} class="src">
        <For each={lines()}>{(_, i) => <div class="l" innerHTML={lineHtml(i()) || "​"} />}</For>
      </div>
      <textarea ref={ta} class="freeedit" spellcheck={false} value={text()} wrap={p.wrap() ? "soft" : "off"}
        onPointerDown={(e) => e.stopPropagation()}
        onInput={(e) => { setText(e.currentTarget.value); syncCur(); void rehighlight(); }}
        onKeyDown={onKey} onKeyUp={syncCur} onBlur={(e) => { if (!exited) p.onBlur(e); }} />
    </div>
  );
}
