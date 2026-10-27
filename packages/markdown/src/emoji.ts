// GitHub 的表情短名（gemoji，tools/emoji/gen.mjs 生成）。文件里存 :名字:（和 Typora、GitHub 一样），显示成表情字
import { EMOJI } from "./emoji-data";

export { EMOJI };
export const EMOJI_NAMES = Object.keys(EMOJI);
