// The editor's extensions: the shared schema's nodes with their editing views, the typed-in menus, keys, the pad paragraph
// at the end, find, Typora-style source editing, placeholder, drag handle and AI completion
import { Extension, InputRule, type AnyExtension, type Editor, type Node as TNode, type Range } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Placeholder } from "@tiptap/extensions";
import DragHandle from "@tiptap/extension-drag-handle";
import { sourceExtensions } from "../schema";
import { refSource } from "../schema-nodes";
import { Ghost } from "./ghost";
import { EMOJI, EMOJI_NAMES } from "../emoji";
import { ParaView, revealMeta } from "./inline";
import { tableEditing } from "./table";
import { CodeBlockView, codeGapClick } from "./codeblock";
import { bandPlugin } from "./band";
import { MathBlockView } from "./mathblock";
import { mathHintsPlugin } from "./mathhints";
import { imageEditing } from "./image";
import { Typora } from "./typora";
import { FindExt } from "./find";
import { menuSuggestion, openMathAt, SLASH, type MenuItem } from "./menu";
import { padAt, padEnd } from "./pad";
import { gapsPlugin } from "./gaps";
import { saveImage, uiOf } from "./ui";
import type { MdEditorOpts, RefGroup, RefItem, RefPick } from "./types";
import type { Md } from "../markdown";
import { mdPlugin } from "./md";
import { markTags } from "../marktag";

export function editorExtensions(
  md: Md,
  o: MdEditorOpts,
  ed: () => Editor,
  handle: HTMLElement | null,
  exit: () => void,
): AnyExtension[] {
  const base = sourceExtensions.flatMap((x): AnyExtension | AnyExtension[] =>
    x.name === "blockMath"
      ? (x as TNode).extend({
          addNodeView:
            () =>
            ({ node, view, getPos }) =>
              new MathBlockView(node, view, getPos as () => number | undefined),
        })
      : x.name === "paragraph"
        ? imageEditing(
            (x as TNode).extend({
              addNodeView:
                () =>
                ({ node, view, getPos }) =>
                  new ParaView(node, view, getPos as () => number | undefined),
            }),
            ed,
            () => saveImage(o),
            () => o.copyImage,
            () => o.knownImage,
          )
        : x.name === "codeBlock"
          ? (x as TNode).extend({
              addProseMirrorPlugins: () => [codeGapClick(), bandPlugin()],
              addNodeView:
                () =>
                ({ node, view, getPos }) =>
                  new CodeBlockView(node, view, getPos as () => number | undefined, {
                    editor: ed,
                    exit: () => {
                      if (!uiOf.get(ed())?.closeFind()) exit();
                    },
                    complete: () => o.complete,
                    comment: (l) => o.code?.comment?.(l),
                    lsp: (l) => o.code?.lsp?.(l),
                    stopPointerDown: () => !!o.code?.stopPointerDown,
                    langs: () => o.code?.langs ?? [],
                    classes: () => o.classes,
                  }),
            })
          : x.name === "table"
            ? tableEditing(x as TNode, () => o.classes)
            : x,
  );
  const Slash = Extension.create({
    name: "cbSlash",
    addProseMirrorPlugins() {
      return [
        menuSuggestion(this.editor, "slash", {
          char: "/",
          items: (q) => {
            const s = q.toLowerCase(),
              refs = o.refs;
            const all = SLASH.flatMap((it) => (!it.ref ? [it] : refs ? [{ ...it, title: refs.menu }] : []));
            return all.filter((it) => !s || it.title.toLowerCase().includes(s) || it.key.includes(s));
          },
        }),
      ];
    },
  });
  // 引用卡片：[[、全角的【【（中文输入法下不用切半角）和 @ 都打开同一个卡片列表
  const refItems = (close: string) => {
    // 这一次打开的列表里展开了的组（「N more」）
    const open = new Set<string>();
    const insert = (label: string, target: string | undefined, pick: RefPick) => (e: Editor, r: Range) => {
      // 自动配对补上的 ]]（pairs.ts）或手打的 】】 也一起换掉
      const to =
        close &&
        e.state.doc.textBetween(r.to, Math.min(r.to + close.length, e.state.doc.content.size), "", "￼") === close
          ? r.to + close.length
          : r.to;
      e.chain()
        .focus()
        .insertContentAt({ from: r.from, to }, `${refSource(label, target)} `)
        .run();
      o.refs?.picked?.(pick);
    };
    const row = (c: RefItem, g?: RefGroup, more: Partial<MenuItem> = {}): MenuItem => ({
      title: c.title,
      hint: c.kind,
      key: `${g?.id ?? ""}/${c.id}`,
      run: insert(c.label ?? c.title, c.target, { group: g?.id, id: c.id }),
      ...more,
    });
    const self = (g: RefGroup): RefItem => ({
      id: g.id,
      title: g.title,
      kind: "whiteboard",
      label: g.label ?? g.title,
      target: g.target,
    });
    const where = (c: RefItem, g?: RefGroup) => (g ? [g.title, c.crumb].filter(Boolean).join(" › ") : undefined);
    const items = (q: string): MenuItem[] => {
      const s = q
        .replace(/[\]】]+$/, "")
        .trim()
        .toLowerCase();
      const here = o.refs?.items() ?? [],
        groups = o.refs?.groups?.() ?? [];
      const hit = (t: string) => {
        const l = t.toLowerCase();
        return !s ? 1 : l.startsWith(s) ? 3 : l.includes(s) ? 2 : 0;
      };
      if (s) {
        const mine = here
          .map((c) => ({ c, w: hit(c.title) }))
          .filter((x) => x.w)
          .sort((a, b) => b.w - a.w)
          .slice(0, 30)
          .map(({ c }) => row(c));
        // 别处的：标题对上的在前；只对上了所在的地方（组名、crumb）的排在后面
        const far: { m: MenuItem; w: number }[] = [];
        for (const g of groups) {
          const gw = hit(g.title);
          if (gw) far.push({ m: row(self(g), g), w: gw });
          for (const c of g.items) {
            const w = hit(c.title) || (hit(`${g.title} ${c.crumb ?? ""}`) && 1);
            if (w) far.push({ m: row(c, g, { crumb: where(c, g) }), w });
          }
        }
        const other = far
          .sort((a, b) => b.w - a.w)
          .slice(0, 30)
          .map((x) => x.m);
        if (mine.length && other.length) other[0] = { ...other[0], sep: true };
        return [...mine, ...other];
      }
      const out: MenuItem[] = [],
        seen = new Set<string>();
      for (const r of o.refs?.recent?.() ?? []) {
        const g = r.group ? groups.find((x) => x.id === r.group) : undefined;
        if (r.group && !g) continue;
        const c = !g ? here.find((x) => x.id === r.id) : r.id === g.id ? self(g) : g.items.find((x) => x.id === r.id);
        if (!c) continue;
        seen.add(`${r.group ?? ""}/${r.id}`);
        out.push(row(c, g, { crumb: where(c, g), head: out.length ? undefined : { text: "Recent" } }));
      }
      const titled = !!(groups.length || out.length);
      here
        .filter((c) => !seen.has(`/${c.id}`))
        .slice(0, 30)
        .forEach((c, i) =>
          out.push(row(c, undefined, i || !titled ? {} : { head: { text: o.refs?.here ?? "Here", cur: true } })),
        );
      for (const g of groups) {
        const rest = g.items.filter((c) => !seen.has(`${g.id}/${c.id}`));
        out.push(row(self(g), g, { cls: "brow", hint: g.note }));
        const lim = open.has(g.id) ? rest.length : 3;
        for (const c of rest.slice(0, lim)) out.push(row(c, g, { cls: "child", crumb: c.crumb }));
        if (rest.length > lim)
          out.push({
            title: `${rest.length - lim} more in ${g.title}`,
            key: `${g.id}/+`,
            cls: "more",
            run: () => undefined,
            expand: () => open.add(g.id),
          });
      }
      return out;
    };
    return { items, start: () => open.clear() };
  };
  const Ref = Extension.create({
    name: "cbRef",
    addProseMirrorPlugins() {
      const on = () => !!o.refs;
      return [
        menuSuggestion(this.editor, "ref", {
          char: "[[",
          allowSpaces: true,
          allowedPrefixes: null,
          on,
          ...refItems("]]"),
        }),
        menuSuggestion(this.editor, "ref", {
          char: "【【",
          key: "ref-cjk",
          allowSpaces: true,
          allowedPrefixes: null,
          on,
          ...refItems("】】"),
        }),
        // @ 在正文里也常见（邮箱、@某人）：没有对上的卡就不弹空列表
        menuSuggestion(this.editor, "ref", {
          char: "@",
          key: "ref-at",
          quiet: true,
          allowSpaces: true,
          allowedPrefixes: null,
          on,
          ...refItems(""),
        }),
      ];
    },
  });
  const Emo = Extension.create({
    name: "cbEmoji",
    addProseMirrorPlugins() {
      return [
        menuSuggestion(this.editor, "emoji", {
          char: ":",
          items: (q) => {
            const s = q.toLowerCase();
            if (s.length < 2 || !/^[a-z0-9_+-]+$/.test(s)) return [];
            const w = (n: string) => (n.startsWith(s) ? 3 : n.includes(`_${s}`) ? 2 : n.includes(s) ? 1 : 0);
            return EMOJI_NAMES.map((n) => ({ n, w: w(n) }))
              .filter((x) => x.w)
              .sort((a, b) => b.w - a.w || a.n.length - b.n.length)
              .slice(0, 30)
              .map(({ n }) => ({
                title: `${EMOJI[n]}  ${n}`,
                key: n,
                run: (e: Editor, r: Range) => {
                  e.chain().focus().insertContentAt(r, `:${n}:`).run();
                },
              }));
          },
        }),
      ];
    },
  });
  const Rules = Extension.create({
    name: "cbRules",
    addInputRules: () => [
      // the > that closes a typed <mark>x</mark>: it becomes ==x== (one undo gives back the tag as typed)
      new InputRule({
        find: /<mark>[^<>\n]*<\/mark>$/i,
        handler: ({ state, range, match }) => {
          const $f = state.doc.resolve(range.from),
            p = $f.parent,
            head = p.textBetween(0, $f.parentOffset, undefined, "\ufffc"),
            tail = p.textBetween(state.doc.resolve(range.to).parentOffset, p.content.size, undefined, "\ufffc");
          // after a ` not closed yet, the tag is most likely being typed into an inline code span
          if (openTick(head)) return null;
          const done = markTags(head + match[0] + tail);
          if (!done.startsWith(head) || !done.endsWith(tail) || done.length < head.length + tail.length) return null;
          const mid = done.slice(head.length, done.length - tail.length);
          if (mid === match[0]) return null;
          state.tr.insertText(mid, range.from, range.to);
          return undefined;
        },
      }),
    ],
    addKeyboardShortcuts() {
      return {
        // Shift+↵: a line break inside the paragraph or cell, written as <br> (the source shows it); a heading is one line
        "Shift-Enter": () => {
          const { $from } = this.editor.state.selection;
          if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
          if ($from.parent.attrs.level) return true;
          this.editor.view.dispatch(revealMeta(this.editor.state.tr.insertText("<br>")).scrollIntoView());
          return true;
        },
      };
    },
  });
  // 优先级最低，菜单、灰字、列表、表格先拿：Esc 保存退出；Tab 在别处没用时什么都不做（不能让浏览器把焦点移出编辑器）
  const Last = Extension.create({
    name: "cbLast",
    priority: 1,
    addKeyboardShortcuts() {
      return {
        Escape: () => {
          exit();
          return true;
        },
        Tab: () => true,
        "Shift-Tab": () => true,
      };
    },
  });
  // 正文最后总有一个能打字的地方（Typora 一样）：最后一块是代码、公式、表格这类时，后面垫一个空段落，方向键、点击走得出去。
  // 还空着时标成 .md-pad（markdown.css：不占高度，进出编辑时卡片一样高）
  const Tail = Extension.create({
    name: "cbTail",
    addProseMirrorPlugins: () => [
      new Plugin({
        appendTransaction: (trs, _old, st) => {
          const tr = st.tr;
          return trs.some((t) => t.docChanged) && padEnd(tr) ? tr : null;
        },
        props: {
          decorations: (st) => {
            const at = padAt(st.doc);
            if (at === null) return null;
            const end = at + st.doc.nodeAt(at)!.nodeSize,
              { $head } = st.selection;
            const inside = st.selection.empty && $head.pos > at && $head.pos < end;
            // the block before it ends the Note's content (markdown.css: no bottom margin); a class, not a sibling :has() rule,
            // which would restyle every block of the Note on each change
            const prev = st.doc.resolve(at).nodeBefore,
              ds = [Decoration.node(at, end, { class: inside ? "md-pad at" : "md-pad" })];
            if (prev) ds.push(Decoration.node(at - prev.nodeSize, at, { class: "md-prepad" }));
            return DecorationSet.create(st.doc, ds);
          },
        },
      }),
    ],
  });
  const Gaps = Extension.create({ name: "cbGaps", addProseMirrorPlugins: () => [gapsPlugin()] });
  // 行内公式的补全、预览：抢在列表、灰字、Esc 退出前面拿 ↑↓ 回车 Tab Esc
  const MathHintsExt = Extension.create({
    name: "cbMathHints",
    priority: 300,
    addProseMirrorPlugins: () => [mathHintsPlugin(md.math)],
  });
  return [
    // first: every node view and widget reads its instance from the state (md.ts)
    Extension.create({ name: "cbMd", priority: 1000, addProseMirrorPlugins: () => [mdPlugin(md)] }),
    // ⌘↵ 要抢在换行（hardBreak 也绑了 Mod-Enter）前面
    Extension.create({
      name: "cbSave",
      priority: 200,
      addKeyboardShortcuts() {
        return {
          "Mod-Enter": () => {
            exit();
            return true;
          },
        };
      },
    }),
    MathHintsExt,
    ...base,
    Slash,
    Ref,
    Emo,
    Rules,
    Last,
    Tail,
    Gaps,
    FindExt(() => uiOf.get(ed())?.closeFind() ?? false),
    Typora.configure({
      openMath: openMathAt,
      openLink: (e) => uiOf.get(e)?.setLink(e.getAttributes("link").href ?? ""),
      classes: () => o.classes,
    }),
    Placeholder.configure({ placeholder: () => o.placeholder ?? "Type / for blocks", showOnlyCurrent: true }),
    ...(handle
      ? [
          DragHandle.configure({
            render: () => handle,
            computePositionConfig: { placement: "left-start", strategy: "fixed" },
          }),
        ]
      : []),
    Ghost.configure({ complete: () => o.complete }),
  ];
}

/** text ends inside a run of backticks no later run of the same length closes */
function openTick(text: string): boolean {
  const runs = [...text.matchAll(/`+/g)].map((m) => m[0].length);
  for (let i = 0; i < runs.length; i++) {
    const j = runs.indexOf(runs[i], i + 1);
    if (j < 0) return true;
    i = j;
  }
  return false;
}
