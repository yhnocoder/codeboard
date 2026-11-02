// The pop-up menus typed into the text: / blocks, [[ references, : emoji (TipTap Suggestion, drawn with Solid)
import type { Editor, Range } from "@tiptap/core";
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { NodeSelection, PluginKey, TextSelection, type Plugin } from "@tiptap/pm/state";
import { render } from "solid-js/web";
import { createEffect, For, Show } from "solid-js";
import { kindClass } from "../ui/classes";
import { insertImageUrl } from "./image";
import { revealMeta } from "./inline";
import { setHeading } from "./typora";
import { saveImage, uiOf, type Ui } from "./ui";

/**
 * 菜单的一项。crumb = 标题后面的灰色小字；cls = 样子（brow：别处那一组的组头，child：组里的，more：「N more」）；
 * head / sep = 这一项上面的组名、分隔线（不能选）；expand = 选它不插东西，而是原地多列出几项（菜单不关）
 */
export type MenuItem = {
  title: string;
  hint?: string;
  key: string;
  run: (e: Editor, r: Range) => void;
  ref?: true;
  crumb?: string;
  cls?: "brow" | "child" | "more";
  head?: { text: string; cur?: boolean };
  sep?: true;
  expand?: () => void;
};

export const SLASH: MenuItem[] = [
  {
    title: "Heading 1",
    key: "h1 title",
    hint: "#",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      setHeading(e, 1);
    },
  },
  {
    title: "Heading 2",
    key: "h2 subtitle",
    hint: "##",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      setHeading(e, 2);
    },
  },
  {
    title: "Heading 3",
    key: "h3",
    hint: "###",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      setHeading(e, 3);
    },
  },
  {
    title: "Bullet List",
    key: "ul unordered",
    hint: "-",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: "Numbered List",
    key: "ol ordered",
    hint: "1.",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: "Task List",
    key: "todo checkbox",
    hint: "[ ]",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    title: "Quote",
    key: "blockquote",
    hint: ">",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: "Code Block",
    key: "pre fence",
    hint: "```",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    title: "Math Block",
    key: "latex katex formula equation",
    hint: "$$",
    run: (e, r) => {
      e.chain()
        .focus()
        .deleteRange(r)
        .insertContent({ type: "blockMath", attrs: { latex: "" } })
        .run();
      openMathAt(e, emptyMathNear(e));
    },
  },
  {
    title: "Mermaid Diagram",
    key: "chart graph flowchart",
    run: (e, r) =>
      e
        .chain()
        .focus()
        .deleteRange(r)
        .insertContent({
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: "graph TD\n  A[Start] --> B[End]" }],
        })
        .run(),
  },
  {
    title: "Table",
    key: "grid",
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run(),
  },
  {
    title: "Image",
    key: "picture photo",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      void insertPickedImage(e);
    },
  },
  {
    title: "Details",
    key: "collapsible toggle fold",
    run: (e, r) => e.chain().focus().deleteRange(r).setDetails().run(),
  },
  // 名字是 refs.menu（白板：Link to Card）；没给 refs 时没有这一项
  {
    title: "",
    ref: true,
    key: "ref reference [[",
    hint: "[[",
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent("[[").run(),
  },
  {
    title: "Footnote",
    key: "note reference",
    hint: "[^1]",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      addFootnote(e);
    },
  },
  {
    title: "Divider",
    key: "hr rule line",
    hint: "---",
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
];

function emptyMathNear(e: Editor) {
  const at = e.state.selection.from;
  let best = -1;
  e.state.doc.descendants((n, pos) => {
    if (n.type.name === "blockMath" && !n.attrs.latex && (best < 0 || Math.abs(pos - at) < Math.abs(best - at)))
      best = pos;
  });
  return best;
}
/** Opens a formula block's LaTeX source in place (as in Typora): selecting it opens it (mathblock.ts) */
export function openMathAt(e: Editor, pos: number) {
  const n = e.state.doc.nodeAt(pos);
  if (n?.type.name !== "blockMath") return;
  e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, pos)));
}
/**
 * A footnote: `[^n]` at the caret (n one past the highest number used) and its definition paragraph `[^n]: ` at the end,
 * where the caret goes to write it
 */
function addFootnote(e: Editor) {
  let n = 0;
  e.state.doc.descendants((p) => {
    if (p.isTextblock) for (const m of p.textContent.matchAll(/\[\^(\d+)\]/g)) n = Math.max(n, +m[1]);
    return !p.isTextblock;
  });
  const k = n + 1,
    tr = e.state.tr.insertText(`[^${k}]`);
  const def = `[^${k}]: `,
    end = tr.doc.content.size;
  tr.insert(end, e.schema.nodes.paragraph.create(null, e.schema.text(def)));
  tr.setSelection(TextSelection.create(tr.doc, end + 1 + def.length));
  e.view.dispatch(revealMeta(tr).scrollIntoView());
}
async function insertPickedImage(e: Editor) {
  const ui = uiOf.get(e);
  const url = await ui?.opts.pickImage?.();
  if (!url || e.isDestroyed) return;
  await insertImageUrl(e, saveImage(ui!.opts), url, "image.png");
}

export function menuSuggestion(
  editor: Editor,
  kind: "slash" | "ref" | "emoji",
  o: {
    char: string;
    key?: string;
    quiet?: boolean;
    allowSpaces?: boolean;
    allowedPrefixes?: string[] | null;
    items: (q: string) => MenuItem[];
    on?: () => boolean;
    start?: () => void;
  },
): Plugin {
  return Suggestion<MenuItem, MenuItem>({
    editor,
    pluginKey: new PluginKey(`cb-${o.key ?? kind}`),
    char: o.char,
    allowSpaces: o.allowSpaces,
    allowedPrefixes: o.allowedPrefixes,
    items: ({ query }) => o.items(query),
    command: ({ editor, range, props }) => props.run(editor, range),
    // a [[…]] already closed is a reference written in the source, not one being typed
    allow: ({ state, range }) =>
      (o.on?.() ?? true) &&
      !state.doc.resolve(range.from).parent.type.spec.code &&
      !(kind === "ref" && state.doc.textBetween(range.from, range.to).includes("]]")),
    render: () => {
      let box: HTMLDivElement | undefined, unmount: (() => void) | undefined;
      let last: SuggestionProps<MenuItem, MenuItem> | undefined;
      const ui = () => uiOf.get(editor)!;
      const show = (p: SuggestionProps<MenuItem, MenuItem>) => {
        last = p;
        ui().follow = true;
        const cur = ui().menu();
        ui().setMenu(
          p.items.length || (kind === "ref" && !o.quiet)
            ? { kind, items: p.items, i: Math.min(cur?.kind === kind ? cur.i : 0, Math.max(0, p.items.length - 1)) }
            : null,
        );
      };
      // 「N more」：原地多列出几项，选中的还在这一格（换成展开出来的第一项）
      const pick = (it: MenuItem, keys: boolean) => {
        if (!it.expand) return last?.command(it);
        it.expand();
        const m = ui().menu(),
          items = last ? o.items(last.query) : [];
        ui().follow = keys;
        ui().setMenu({ kind, items, i: Math.max(0, Math.min(m?.i ?? 0, items.length - 1)) });
      };
      return {
        onStart: (p) => {
          o.start?.();
          box = document.createElement("div");
          box.className = "mdui-anchor";
          unmount = p.mount(box, {});
          const dispose = render(() => <MenuView ui={ui()} pick={(it) => pick(it, false)} />, box);
          const u0 = unmount;
          unmount = () => {
            dispose();
            u0();
          };
          show(p);
        },
        onUpdate: show,
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          const m = ui().menu();
          if (!m || event.isComposing) return false;
          if (event.key === "Escape") {
            ui().setMenu(null);
            unmount?.();
            unmount = undefined;
            return true;
          }
          if (!m.items.length) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const d = event.key === "ArrowDown" ? 1 : -1;
            ui().follow = true;
            ui().setMenu({ ...m, i: (m.i + d + m.items.length) % m.items.length });
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            pick(m.items[m.i], true);
            return true;
          }
          return false;
        },
        onExit: () => {
          ui().setMenu(null);
          unmount?.();
          unmount = undefined;
        },
      };
    },
  });
}

/** 选中项上下各留 2.5 行再滚（到列表两头时除外）：往下翻时看得到接下来是什么 */
function keepInView(list: HTMLElement, row: HTMLElement) {
  const h = row.offsetHeight,
    m = h * 2.5,
    y = row.offsetTop;
  if (y - m < list.scrollTop) list.scrollTop = Math.max(0, y - m);
  else if (y + h + m > list.scrollTop + list.clientHeight) list.scrollTop = y + h + m - list.clientHeight;
}

function MenuView(p: { ui: Ui; pick: (it: MenuItem) => void }) {
  return (
    <Show when={p.ui.menu()}>
      {(m) => {
        let list!: HTMLDivElement;
        const foot = () => (m().kind === "ref" ? p.ui.opts.refs?.foot?.() : undefined);
        createEffect(() => {
          const i = m().i;
          void m().items;
          if (!p.ui.follow) return;
          p.ui.follow = false;
          const row = list.querySelectorAll<HTMLElement>(":scope > button")[i];
          if (row) keepInView(list, row);
        });
        // 选中的那行放不下的标题、路径：来回慢慢滑着露出整段（只这一行，别的行照旧省略号）
        createEffect(() => {
          const i = m().i;
          void m().items;
          queueMicrotask(() => {
            for (const el of list.querySelectorAll<HTMLElement>(".slide")) el.classList.remove("slide");
            const row = list.querySelectorAll<HTMLElement>(":scope > button")[i];
            for (const el of row?.querySelectorAll<HTMLElement>(".lb, .bc") ?? []) {
              const over = el.scrollWidth - el.clientWidth;
              if (over < 2) continue;
              el.style.setProperty("--over", `${over}px`);
              el.style.setProperty("--slide", `${Math.max(1.2, over / 45).toFixed(2)}s`);
              el.classList.add("slide");
            }
          });
        });
        return (
          <div
            class={`${kindClass(p.ui.opts.classes, "menu")} open md-pick`}
            classList={{ "md-refs": m().kind === "ref" }}
            role="listbox"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div class="md-list" ref={list}>
              <Show
                when={m().items.length}
                fallback={
                  <div class="md-empty">{m().kind === "ref" ? p.ui.opts.refs?.empty : "No matching block"}</div>
                }
              >
                <For each={m().items}>
                  {(it, i) => (
                    <>
                      <Show when={it.sep}>
                        <div class="md-gsep" />
                      </Show>
                      <Show when={it.head}>
                        {(h) => (
                          <div class="md-gh" classList={{ cur: !!h().cur }}>
                            {h().text}
                          </div>
                        )}
                      </Show>
                      <button
                        role="option"
                        class={it.cls}
                        classList={{ sel: i() === m().i }}
                        onClick={() => p.pick(it)}
                        onPointerEnter={() => p.ui.setMenu({ ...m(), i: i() })}
                      >
                        <span class="lb">
                          <span class="tx">{it.title}</span>
                        </span>
                        <Show when={it.crumb}>
                          <span class="bc">
                            <span class="tx">{it.crumb}</span>
                          </span>
                        </Show>
                        <Show when={it.hint}>
                          <small>{it.hint}</small>
                        </Show>
                      </button>
                    </>
                  )}
                </For>
              </Show>
            </div>
            <Show when={foot()}>
              <div class="md-foot">{foot()}</div>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
