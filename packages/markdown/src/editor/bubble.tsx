// The formatting toolbar over a text selection, with its link and handwritten-note boxes
import { keepKey } from "../ui/editkeys";
import { posToDOMRect, type Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { createEffect, createSignal, onCleanup, Show, type Accessor } from "solid-js";
import { Icon, type IconName } from "./icons";
import { isWrapped, revealMeta, toggleWrap } from "./inline";
import { blockInfo, flat, type Span } from "./spans";
import { linkAt as linkIn, linkText, type LinkAt } from "./links";
import { movingBlocks } from "./moveblocks";
import { escAnnot } from "../schema-marks";
import { autoUpdate } from "@floating-ui/dom";
import { place, virtual } from "../ui/place";
import { TOOLBAR_SETTLE } from "../ui/timing";
import { IS_MAC } from "../ui/platform";
import { kindClass } from "../ui/classes";
import { mdOf } from "./md";
import type { Ui } from "./ui";

const isInside = (e: Editor, t: EventTarget | null) =>
  t instanceof Node && (e.view.dom.contains(t) || !!(t as Element).closest?.(".mdui, .md-bubble"));

export function Bubble(p: { editor: Editor; tick: Accessor<number>; ui: Ui }) {
  let el!: HTMLDivElement;
  const link = p.ui.link,
    setLink = p.ui.setLink;
  const e = p.editor;
  const want = () => {
    p.tick();
    const s = e.state.selection;
    if (s.empty || !(s instanceof TextSelection) || !e.isFocused || p.ui.menu() || movingBlocks(e.state)) return false;
    return !s.$from.parent.type.spec.code && s.$from.parent.inlineContent;
  };
  // 不是一选就出：选区停住 TOOLBAR_SETTLE 后才出（拖选、⇧方向键扩选的途中不闪），按着鼠标时不算停住；
  // 选区一收拢（没选字了）立刻收起。点按钮改格式时选区不动，工具条留着
  const [settled, setSettled] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined,
    last = "",
    down = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => setSettled(!down && want()), TOOLBAR_SETTLE);
  };
  createEffect(() => {
    const ok = want(),
      s = e.state.selection,
      key = `${s.from}:${s.to}`;
    if (!ok) {
      clearTimeout(timer);
      last = "";
      setSettled(false);
      return;
    }
    if (key !== last) {
      last = key;
      setSettled(false);
      arm();
    }
  });
  const press = (ev: PointerEvent) => {
    if (ev.button === 0 && e.view.dom.contains(ev.target as Node)) down = true;
  };
  const release = () => {
    if (!down) return;
    down = false;
    if (want()) {
      setSettled(false);
      arm();
    }
  };
  window.addEventListener("pointerdown", press, true);
  window.addEventListener("pointerup", release, true);
  onCleanup(() => {
    clearTimeout(timer);
    window.removeEventListener("pointerdown", press, true);
    window.removeEventListener("pointerup", release, true);
  });
  // 手写批注的输入框（null = 没打开）：打开时记下选中的那段，打字时标签直接画在字上（不进撤销），回车 / 点开时才算一步
  const [annot, setAnnot] = createSignal<string | null>(null);
  const shown = () => link() !== null || annot() !== null || (settled() && want());
  /** The text the bar is for, on the page */
  const rect = () => {
    let r = posToDOMRect(e.view, e.state.selection.from, e.state.selection.to);
    // 写批注时：工具条让开整个被标的字（连着上面 / 下面画标签的那条轨道），别盖住正在写的标签
    if (annot() !== null) {
      const n = e.view.domAtPos(e.state.selection.from + 1).node,
        a = (n instanceof Element ? n : n.parentElement)?.closest(".md-annot");
      if (a) {
        const b = a.getBoundingClientRect(),
          x = Math.min(r.left, b.left),
          y = Math.min(r.top, b.top);
        r = new DOMRect(x, y, Math.max(r.right, b.right) - x, Math.max(r.bottom, b.bottom) - y);
      }
    }
    return r;
  };
  const placeNow = () => {
    if (!el?.isConnected) return;
    const r = rect();
    // the link box opens under the link, where the eye already is, and leaves the lines above it readable
    void place(
      el,
      virtual({ x: r.left, y: r.top, width: r.width, height: r.height }),
      link() !== null ? "bottom-start" : "top",
      {
        gap: 8,
        pad: 6,
      },
    ).then(({ x, y }) => {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    });
  };
  const pos = () => {
    p.tick();
    if (!shown()) return;
    link();
    annot();
    queueMicrotask(placeNow);
  };
  // data-tip / data-kbd 给用的一方的提示条
  const B = (q: { icon: IconName; tip: string; kbd?: string; on: () => boolean; run: () => void }) => {
    const on = () => (p.tick(), q.on());
    return (
      <button
        class={`${kindClass(p.ui.opts.classes, "button")} md-ib`}
        classList={{ on: on() }}
        aria-pressed={on()}
        aria-label={q.kbd ? `${q.tip} (${q.kbd})` : q.tip}
        data-tip={q.tip}
        data-kbd={q.kbd}
        onClick={q.run}
      >
        <Icon name={q.icon} />
      </button>
    );
  };
  const mod = IS_MAC ? "⌘" : "Ctrl+";
  const shift = mod === "⌘" ? "⇧" : "Shift+";
  let busy = false;
  // Formatting is source: the buttons add or remove markers around the selection (toggleWrap), the pressed state is
  // "the selection is wrapped in them"
  const W = (open: string, close = open) => ({
    on: () => isWrapped(e.state, open, close),
    run: () => {
      toggleWrap(e.state, e.view.dispatch, open, close);
      e.view.focus();
    },
  });
  /** The link the selection is in, if any */
  const linkAt = () => linkIn(e.state);
  /** What the link box is for: the link the selection is in (else the selected text a new link goes on), as the box showed it */
  type LinkFor = { shown: string; l: LinkAt | null; from: number; to: number };
  const linkFor = (shown: string): LinkFor => ({
    shown,
    l: linkAt(),
    from: e.state.selection.from,
    to: e.state.selection.to,
  });
  /** Write the link back: its address (empty: the text stays, unlinked) and, for one being edited, its text */
  const applyLink = (v: string, stay = true, textV?: string) => {
    const shown = link();
    if (shown === null || busy) return;
    busy = true; // focus below fires blur synchronously: do not insert twice
    if (stay) e.view.focus();
    setLink(null);
    busy = false;
    writeLink(linkFor(shown), v, textV);
    if (!stay) e.view.dom.dispatchEvent(new FocusEvent("blur")); // clicked outside: save and leave as usual
  };
  const writeLink = ({ shown, l, from, to }: LinkFor, v: string, textV?: string) => {
    const url = v.trim();
    const href = !url || /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`;
    const st = e.state,
      tr = st.tr;
    if (l) {
      const was = st.doc.textBetween(l.textFrom, l.textTo),
        text = textV?.trim() || was;
      // the box shows the address as read (www.x as http://www.x, a@b as mailto:a@b, a title left out): a link whose fields
      // were not changed keeps its source as written
      const same = url === shown.trim() && text === was;
      // a bare address whose text was not changed stays bare when it can (GFM reads a web address as a link)
      const src = !href
        ? text
        : l.bare && text === was && /^(https?:\/\/|www\.)\S+$/i.test(href)
          ? href
          : `[${linkText(text)}](${href})`;
      if (!same && src !== st.doc.textBetween(l.from, l.to)) tr.insertText(src, l.from, l.to);
    } else if (href) {
      const text = st.doc.textBetween(from, to);
      // nothing selected (⌘K): the address itself; a web address is a link as it is (GFM), others go in <…>
      tr.insertText(
        text ? `[${linkText(text)}](${href})` : /^(https?:\/\/|www\.)\S+$/i.test(href) ? href : `<${href}>`,
        from,
        to,
      );
    }
    if (tr.docChanged) e.view.dispatch(revealMeta(tr));
  };
  let textIn: HTMLInputElement | undefined, urlIn: HTMLInputElement | undefined;
  /** Leaving the link's box for somewhere else: what it holds is written back (not when moving between its own fields) */
  const leaveLink = (ev: FocusEvent) => {
    const shown = link();
    if (shown === null || (ev.relatedTarget instanceof Node && el.contains(ev.relatedTarget))) return;
    if (down && !busy) {
      // a press in the text: the box closes at once, and what it holds is written once the press has put the caret where it
      // was pressed (written now, the change would take the selection back to the link and the press would place nothing)
      const at = linkFor(shown),
        doc = e.state.doc,
        url = urlIn?.value ?? "",
        text = textIn?.value;
      setLink(null);
      addEventListener(
        "pointerup",
        () =>
          setTimeout(() => {
            if (!e.isDestroyed && e.state.doc === doc) writeLink(at, url, text);
          }),
        { once: true, capture: true },
      );
      return;
    }
    applyLink(urlIn?.value ?? "", isInside(e, ev.relatedTarget), textIn?.value);
  };
  const linkKey = (ev: KeyboardEvent) => {
    keepKey(ev, mdOf(e.state).passKeys);
    if (ev.key === "Enter" && !ev.isComposing) {
      ev.preventDefault();
      applyLink(urlIn?.value ?? "", true, textIn?.value);
    }
    if (ev.key === "Escape" && !ev.isComposing) {
      ev.preventDefault();
      e.view.focus();
      setLink(null);
    }
  };
  /** The {text|note} the selection is in, if any */
  const annotAtSel = (): Span | null => {
    const { from, to, $from } = e.state.selection,
      p = $from.parent;
    if (!p.isTextblock) return null;
    const base = $from.start();
    return (
      flat(blockInfo(p.textContent).spans).find(
        (sp) => sp.atom?.type === "annot" && sp.from <= from - base && sp.to >= to - base,
      ) ?? null
    );
  };
  let annotAt: { from: number; to: number; sp: Span | null } | null = null;
  // the note being typed is shown in place as it is typed: those steps stay out of the history, and applying first puts the
  // original text back, so the whole annotation is one undo step
  let live: { from: number; to: number; orig: string } | null = null;
  const openAnnot = () => {
    const { from, to } = e.state.selection,
      sp = annotAtSel();
    annotAt = { from, to, sp };
    live = null;
    setAnnot(sp?.atom?.type === "annot" ? sp.atom.note : "");
  };
  const escText = (t: string) => t.replace(/(?<!\\)[{}|]/g, "\\$&");
  /** The source the annotation range becomes for this note, and the range it replaces */
  const annotEdit = (note: string, st = e.state) => {
    const r = annotAt!,
      base = st.doc.resolve(r.from).start();
    if (r.sp?.atom?.type === "annot") {
      // change the note of the existing one (keeps its colour and side); an empty note takes it off
      const a = r.sp.atom,
        opts = [a.color !== "blue" ? a.color : "", a.below ? "below" : ""].filter(Boolean).join(" ");
      return {
        from: base + r.sp.from,
        to: base + r.sp.to,
        text: note ? `{${a.text}|${escAnnot(note)}${opts ? `|${opts}` : ""}}` : a.text,
        inner: a.text,
      };
    }
    const text = st.doc.textBetween(r.from, r.to);
    return {
      from: r.from,
      to: r.to,
      text: note && r.to > r.from ? `{${escText(text)}|${escAnnot(note)}}` : text,
      inner: escText(text),
    };
  };
  const unpreview = () => {
    if (!live) return;
    const tr = e.state.tr.insertText(live.orig, live.from, live.to).setMeta("addToHistory", false);
    live = null;
    e.view.dispatch(tr);
  };
  const previewAnnot = (v: string) => {
    if (!annotAt || (!annotAt.sp && annotAt.to <= annotAt.from)) return;
    unpreview();
    const ed = annotEdit(v.trim()),
      orig = e.state.doc.textBetween(ed.from, ed.to);
    if (ed.text === orig) return;
    live = { from: ed.from, to: ed.from + ed.text.length, orig };
    e.view.dispatch(e.state.tr.insertText(ed.text, ed.from, ed.to).setMeta("addToHistory", false));
  };
  const applyAnnot = (v: string | null, stay = true) => {
    if (annot() === null || busy || !annotAt) return;
    busy = true;
    if (stay) e.view.focus();
    setAnnot(null);
    busy = false;
    unpreview();
    const note = v?.trim() ?? "";
    if (v !== null) {
      const ed = annotEdit(note),
        tr = e.state.tr;
      if (ed.text !== e.state.doc.textBetween(ed.from, ed.to)) {
        tr.insertText(ed.text, ed.from, ed.to);
        // the annotated words stay selected (the toolbar comes back with the button on)
        const k = ed.text.startsWith("{") ? 1 : 0;
        tr.setSelection(TextSelection.create(tr.doc, ed.from + k, ed.from + k + ed.inner.length));
        e.view.dispatch(tr);
      }
    }
    annotAt = null;
    if (!stay) e.view.dom.dispatchEvent(new FocusEvent("blur")); // clicked outside: save and leave as usual
  };
  return (
    <Show when={shown()}>
      {(pos(), null)}
      <div
        ref={(d) => {
          el = d;
          // over its text as the page under it moves (a board panned or zoomed with the bar open)
          onCleanup(
            autoUpdate({ getBoundingClientRect: rect, contextElement: e.view.dom }, d, placeNow, {
              ancestorScroll: false,
              ancestorResize: false,
              elementResize: false,
            }),
          );
        }}
        class={`${kindClass(p.ui.opts.classes, "bar")} md-bubble`}
        onMouseDown={(ev) => {
          if (!(ev.target as HTMLElement).closest("input")) ev.preventDefault();
        }}
        onPointerDown={(ev) => ev.stopPropagation()}
      >
        <Show
          when={link() !== null || annot() !== null}
          fallback={
            <>
              {B({ icon: "bold", tip: "Bold", kbd: `${mod}B`, ...W("**") })}
              {B({ icon: "italic", tip: "Italic", kbd: `${mod}I`, ...W("*") })}
              {B({ icon: "strike", tip: "Strikethrough", kbd: `${mod}${shift}S`, ...W("~~") })}
              {B({ icon: "highlight", tip: "Highlight", kbd: `${mod}${shift}H`, ...W("==") })}
              {B({ icon: "code", tip: "Inline Code", kbd: `${mod}E`, ...W("`") })}
              <span class="sep" />
              {B({
                icon: "link",
                tip: "Link",
                kbd: `${mod}K`,
                on: () => !!linkAt(),
                run: () => setLink(linkAt()?.url ?? ""),
              })}
              {B({ icon: "math", tip: "Inline Math", ...W("$") })}
              {B({ icon: "annot", tip: "Handwritten Note", on: () => !!annotAtSel(), run: openAnnot })}
            </>
          }
        >
          <Show
            when={annot() !== null}
            fallback={
              <Show
                when={!!linkAt()}
                fallback={
                  <input
                    class="md-linkin"
                    placeholder="Paste or type a link…"
                    value={link() ?? ""}
                    spellcheck={false}
                    ref={(i) => {
                      urlIn = i;
                      textIn = undefined;
                      queueMicrotask(() => {
                        i.focus();
                        i.select();
                      });
                    }}
                    onKeyDown={linkKey}
                    onBlur={leaveLink}
                  />
                }
              >
                <div class="md-linkbox">
                  <input
                    class="md-linkin md-linktext"
                    placeholder="Text"
                    aria-label="Link text"
                    value={(() => {
                      const l = linkAt();
                      return l ? e.state.doc.textBetween(l.textFrom, l.textTo) : "";
                    })()}
                    spellcheck={false}
                    ref={(i) => (textIn = i)}
                    onKeyDown={linkKey}
                    onBlur={leaveLink}
                  />
                  <input
                    class="md-linkin"
                    placeholder="Paste or type a link…"
                    aria-label="Link address"
                    value={link() ?? ""}
                    spellcheck={false}
                    ref={(i) => {
                      urlIn = i;
                      queueMicrotask(() => {
                        i.focus();
                        i.select();
                        // a long address shows from its start (selecting it scrolled the field to its end, "ttps://…")
                        i.scrollLeft = 0;
                      });
                    }}
                    onKeyDown={linkKey}
                    onBlur={leaveLink}
                  />
                  <div class="md-linkacts">
                    <button
                      class={`${kindClass(p.ui.opts.classes, "button")} md-linkbtn`}
                      onClick={() => {
                        const u = urlIn?.value.trim();
                        e.view.focus();
                        setLink(null);
                        if (u) p.ui.opts.openLink?.(u);
                      }}
                    >
                      Open
                    </button>
                    <button
                      class={`${kindClass(p.ui.opts.classes, "button")} md-linkbtn`}
                      onClick={() => applyLink("", true, textIn?.value)}
                    >
                      Remove Link
                    </button>
                  </div>
                </div>
              </Show>
            }
          >
            <input
              class="md-linkin md-annotin"
              placeholder="Write a handwritten note…"
              value={annot() ?? ""}
              spellcheck={false}
              ref={(i) =>
                queueMicrotask(() => {
                  i.focus();
                  i.select();
                })
              }
              onInput={(ev) => {
                setAnnot(ev.currentTarget.value);
                previewAnnot(ev.currentTarget.value);
              }}
              onKeyDown={(ev) => {
                keepKey(ev, mdOf(e.state).passKeys);
                if (ev.key === "Enter" && !ev.isComposing) {
                  ev.preventDefault();
                  applyAnnot(ev.currentTarget.value);
                }
                if (ev.key === "Escape") {
                  ev.preventDefault();
                  applyAnnot(null);
                }
              }}
              onBlur={(ev) => {
                if (annot() !== null) applyAnnot(ev.currentTarget.value, isInside(e, ev.relatedTarget));
              }}
            />
          </Show>
        </Show>
      </div>
    </Show>
  );
}
