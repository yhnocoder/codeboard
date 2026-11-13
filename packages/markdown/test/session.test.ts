// @vitest-environment jsdom
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coreOf, createMarkdown } from "../src/markdown";
import { prepare, takeInst, warmUp, type Sess } from "../src/editor/session";
import type { MdEditorOpts } from "../src/editor/types";

// the typed-in menus are Solid components, which these unit tests do not compile; nothing here opens one
vi.mock("../src/editor/menu", () => ({ SLASH: [], openMathAt: () => {}, menuSuggestion: () => new Plugin({}) }));

const NOTE = "```js\nx\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |";
const classes = { menu: "page-menu", bar: "page-bar", button: "page-btn" };

/** A Note drawn into the kept editor while no session (and so no option) exists, then edited: mountEditor's first steps */
function edit(more: Partial<MdEditorOpts> = {}) {
  // jsdom has neither the CSS Custom Highlight registry (the find plugin clears it) nor ResizeObserver (formula blocks)
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const md = createMarkdown();
  warmUp(md);
  prepare(md, NOTE);
  const { inst, pooled } = takeInst(coreOf(md), false);
  expect(pooled).toBe(true);
  expect(inst.prepared).toBe(NOTE);
  const sess: Sess = {
    o: { value: NOTE, onDone: () => {}, classes, ...more },
    onTx: () => {},
    onFocus: () => {},
    onBlur: () => {},
    finish: () => {},
  };
  inst.sess = sess;
  const host = document.createElement("div");
  document.body.append(host);
  host.append(inst.box);
  return { host, editor: inst.editor };
}
const press = (host: HTMLElement) => {
  let reached = 0;
  host.addEventListener("pointerdown", () => reached++);
  host.querySelector(".md-code .cm-editor")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  return reached;
};

describe("an editor prepared before its session", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a press in a code block from the page when the session asks for it", () => {
    expect(press(edit({ code: { stopPointerDown: true } }).host)).toBe(0);
  });

  it("lets the press through when the session does not", () => {
    expect(press(edit().host)).toBe(1);
  });

  it("gives the code block's language list the page's menu class", () => {
    const { host } = edit();
    host.querySelector(".md-code")!.dispatchEvent(new Event("pointerenter"));
    host.querySelector<HTMLElement>(".md-band-code .md-lang")!.click();
    expect(document.querySelector(".md-langbox .md-menu")!.className).toContain("page-menu");
  });

  it("gives the table band's menu the page's menu class", () => {
    const { host, editor } = edit();
    let cell = 0;
    editor.state.doc.descendants((n, pos) => {
      if (!cell && n.type.name === "tableCell") cell = pos + 2;
    });
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cell)));
    host.querySelector<HTMLElement>(".md-band-table.on [data-act=more]")!.click();
    expect(document.querySelector(".md-bandmenu > div")!.className).toContain("page-menu");
  });
});

describe("AI completion in the editor", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("arms its timer after typing only when the session has a completion", () => {
    vi.useFakeTimers();
    // the timers typing arms (other plugins have theirs, with or without a completion)
    const typing = (more: Partial<MdEditorOpts>) => {
      const { editor } = edit(more);
      editor.view.focus();
      const before = vi.getTimerCount();
      editor.view.dispatch(editor.state.tr.insertText("some words", editor.state.selection.head));
      const armed = vi.getTimerCount() - before;
      vi.clearAllTimers();
      document.body.replaceChildren();
      return armed;
    };
    expect(typing({ complete: async () => null }) - typing({})).toBe(1);
  });
});
