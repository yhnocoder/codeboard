// GitHub 的表情短名（gemoji，tools/emoji/gen.mjs 生成）。文件里存 :名字:（和 Typora、GitHub 一样），显示成表情字
import { GEMOJI } from "./emoji-data";

// 编辑器以前就能打出来、GitHub 用别的名字的几个：已经写进笔记里的照样显示
const EXTRA: Record<string, string> = { face_with_monocle: "🧐", t_rex: "🦖", speech: "💬", blue_circle: "🔵", globe: "🌐" };

export const EMOJI: Record<string, string> = { ...GEMOJI, ...EXTRA };
export const EMOJI_NAMES = Object.keys(EMOJI);
