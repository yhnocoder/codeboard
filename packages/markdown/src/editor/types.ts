// The editor's public options and handle, and the [[ reference candidates the caller gives
import type { LspHost } from "../cm/editor";
import type { MdLayout } from "../layout";
import type { StaticTextRange } from "../selmap";
import type { MdClasses } from "../ui/classes";
import type { CodeLang } from "./codelang";
import type { CopyImage, KnownImage, SaveImage } from "./image";
import type { MdBlocks } from "./moveblocks";

export type MdEditorOpts = {
  value: string;
  placeholder?: string;
  /** 结束编辑：改过给新的原文，没改给 null */
  onDone: (v: string | null, layout?: MdLayout | null) => void;
  /** Table column widths, row heights and code wrap of this Markdown (kept by the caller, not in the Markdown; see layout.ts).
   *  onDone gets the new one as its second argument only when it changed (null = all automatic again) */
  layout?: MdLayout | null;
  /** The ⌘/ Markdown source mode turned on or off (the caller shows its toggle pressed) */
  onSourceMode?: (on: boolean) => void;
  /** [[ 引用：候选（kind 显示在右边）、/ 菜单里那一项的名字、没有对得上的候选时的提示。不给就没有 [[ 菜单。
   *  groups = 别处（白板：别的白板）的候选，一组一处，排在本地的后面：组头那一行本身能选（引用那一处），没打字时每组露 3 个、多的收进「N more in 组」；
   *  recent = 没打字时排在最前的最近选过的（group 不给 = 本地的）；here = 有 groups 或 recent 时本地那组的名字；foot = 列表下面的一行字；
   *  picked = 选了一项（记最近选过的） */
  refs?: {
    items: () => RefItem[];
    menu: string;
    empty: string;
    groups?: () => RefGroup[];
    recent?: () => RefPick[];
    here?: string;
    foot?: () => string;
    picked?: (p: RefPick) => void;
    /** The list's highlighted candidate changed (row = its element in the list), or the list closed (null, null): the caller can
     *  show what it points to beside the list */
    showing?: (p: RefPick | null, row: HTMLElement | null) => void;
  };
  /** 存图（粘贴、拖进来、/Image）：回写进 Markdown 的地址，null = 不插（存不了，用的一方自己提示）；不给就把 data: 地址原样写进去 */
  saveImage?: SaveImage;
  pickImage?: () => Promise<string | null>;
  /** ⌘C on an image (the caret in its source, or just its source selected): the caller puts the picture itself on the clipboard
   *  (image/png for other apps; the copy event is cancelled, so no text goes with it). Not given: the Markdown is copied as
   *  text, as any selection */
  copyImage?: CopyImage;
  /** A pasted or dropped picture: the Markdown to insert instead of saving it when the caller knows it (the image it put on the
   *  clipboard with copyImage), null to save it as usual */
  knownImage?: KnownImage;
  openLink?: (url: string) => void;
  /** 灰字补全（宿主没有就不给） */
  complete?: (before: string, after: string) => Promise<string | null>;
  /** 代码块（CodeMirror）：行注释记号（⌘/，默认 //）、语言服务（这种语言没有就给 undefined，块拆掉时调它的 close）、
   *  按下不往外冒（见 CodeEditorOpts.stopPointerDown）、右上角语言框里列出的语言（着色认得的；Mermaid 总在） */
  code?: {
    comment?: (lang: string | undefined) => string | undefined;
    lsp?: (lang: () => string) => LspHost | undefined;
    stopPointerDown?: boolean;
    langs?: readonly CodeLang[];
  };
  /** 块左边的拖动把手（⋮⋮，拖着移动整块）。默认没有 */
  dragHandle?: boolean;
  /**
   * The editor sits where nothing around it should scroll (a card on a canvas that moves by its camera): keeping the caret in
   * view scrolls only the nearest scrolling box around the text, never further ancestors or the page. By default the browser
   * scrolls whatever it needs to
   */
  scrollOwnBox?: boolean;
  /** The page's classes for the editor's menus, floating bars and buttons (MdClasses) */
  classes?: MdClasses;
};
export type MdEditorHandle = {
  value(): string | null;
  /** The layout as it is now (see MdEditorOpts.layout) */
  layout(): MdLayout | null;
  destroy(): void;
  /**
   * Put the caret at the end, next to characters counted as the static render shows them (staticTextRange: before them, or
   * after them with after), or at a point on the page (moved into the text when it is beside it; below the text = the end).
   * False when the characters are not in the document
   */
  placeCaret(at: "end" | { visible: StaticTextRange; after?: boolean } | { x: number; y: number }): boolean;
  /** Select the image drawn at a point on the page (the press that started the editing was on it); false when none is there */
  pickImage(at: { x: number; y: number }): boolean;
  /** Select characters counted as the static render shows them (staticTextRange); false when they are not in the document */
  selectVisible(r: StaticTextRange): boolean;
  /** Press a key as if typed in the editor (its key bindings run); a key nothing handles deletes the selection */
  press(key: "Backspace" | "Delete"): void;
  /**
   * Type text at the selection as if typed on the keyboard, one character at a time (a newline is Enter): key bindings and input
   * rules ("# " starts a heading) run as they do for typing. For keys typed before the editor was mounted
   */
  type(text: string): void;
  /** Switch the whole Note between rich editing and its Markdown source (⌘/) */
  toggleSource(): void;
  /** Whole top-level blocks, for moving them (null in Markdown source mode) */
  blocks(): MdBlocks | null;
};
/**
 * [[ 的一个候选：label = 写进 [[…]] 的（不给就是 title），crumb = 标在标题后面的小字（白板：所在的 Section），
 * target = 跟着写进去的稳定 id（[[label#^target]]，只能是 [\w-]，可以有一个 /）：改了名 refs.resolve 也按它找得到；不给就只写标题
 */
export type RefItem = { id: string; title: string; kind: string; label?: string; crumb?: string; target?: string };
/** 别处的一组候选：title = 那一处的名字，label、target = 引用那一处本身时写进 [[…]] 的（同 RefItem），note = 组头右边的字 */
export type RefGroup = { id: string; title: string; label?: string; target?: string; note?: string; items: RefItem[] };
export type RefPick = { group?: string; id: string };
