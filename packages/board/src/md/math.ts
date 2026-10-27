// 公式预设（设置 codeboard.math.preamble）交给 Markdown 包。换了以后已经显示着的 Note、说明跟着重画（包里的静态渲染缓存已经清掉）
import { createSignal } from "solid-js";
import { setMathPreamble } from "@yhnocoder/markdown";

const [rev, setRev] = createSignal(0);
/** 静态 Markdown 的 effect 读它：预设换了重画 */
export const mathRev = rev;
export function applyMathPreamble(src: string) {
  if (setMathPreamble(src)) setRev((n) => n + 1);
}
