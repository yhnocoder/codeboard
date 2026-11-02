// The state an editing session shares with its menus and toolbar, found from the editor
import type { Editor } from "@tiptap/core";
import type { Accessor } from "solid-js";
import type { SaveImage } from "./image";
import type { MenuItem } from "./menu";
import type { MdEditorOpts } from "./types";

// 每个编辑器一份（同一时间只有一个编辑器，但不靠这一点）
export type Ui = {
  menu: Accessor<{ kind: "slash" | "ref" | "emoji"; items: MenuItem[]; i: number } | null>;
  setMenu: (v: { kind: "slash" | "ref" | "emoji"; items: MenuItem[]; i: number } | null) => void;
  /** 工具条里的链接输入框（null = 没打开） */
  link: Accessor<string | null>;
  setLink: (v: string | null) => void;
  /** 查找条开着就关上（Esc） */
  closeFind: () => boolean;
  /** 下一次选中项变了时要不要把它滚进视野（键盘、打字：要；指针移上去、点「more」展开：不要，列表不跳） */
  follow: boolean;
  opts: MdEditorOpts;
};
export const uiOf = new WeakMap<Editor, Ui>();
export const saveImage = (o: MdEditorOpts): SaveImage => o.saveImage ?? ((u) => Promise.resolve(u));
