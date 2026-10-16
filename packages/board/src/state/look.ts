// 材质主题（Settings → Theme）里少数要 JS 配合的东西：连线的走法、箭头和端口的形状，源文件的颜色。
// 其余全在 themes.css。切主题时这里只重算一次连线几何，不加每帧的工作。
import { createMemo, createRoot } from "solid-js";
import { state } from "./store";

/** 代码卡存的高度按 Warm Ink 的卡头算；别的主题卡头 / 底栏更高，多出来的部分（--hx）显示时加上、存的时候减掉，换主题后能看到的行数不变 */
export const chromeExtra = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hx")) || 0;
export const look = () => state.host.settings?.theme ?? "warm-ink";

type Shape = { route: "curve" | "elbow"; head: "chevron" | "triangle" | "dot"; port: "circle" | "square" | "diamond" };
const SHAPES: Record<string, Partial<Shape>> = {
  classic: { head: "triangle" },
  drafting: { route: "elbow", head: "triangle", port: "square" },
  "soft-light": { head: "dot" },
  colorful: { head: "triangle" },
  newspaper: { head: "triangle" },
  poster: { port: "diamond" },
};
export const shape = (): Shape => ({ route: "curve", head: "chevron", port: "circle", ...SHAPES[look()] });

/** 源文件 → 6 种颜色之一（Colorful 的色带、端口用）。按文件在白板上第一次出现的顺序分，不存进白板；超过 6 个文件就轮回 */
const order = createRoot(() => createMemo(() => {
  const m = new Map<string, number>();
  for (const c of state.board.cards) {
    const p = c.kind === "code" ? c.segments[0]?.path : undefined;
    if (p && !m.has(p)) m.set(p, m.size % 6);
  }
  return m;
}));
export const fileHue = (path: string | undefined) => (path ? order().get(path) ?? 0 : 0);
