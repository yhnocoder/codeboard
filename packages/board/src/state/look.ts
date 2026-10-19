// 材质主题（Settings → Theme）里少数要 JS 配合的东西：连线的走法、箭头和端口的形状，源文件的颜色。
// 其余全在 themes.css。切主题时这里只重算一次连线几何，不加每帧的工作。
import { createMemo, createSignal } from "solid-js";
import type { ThemeId } from "@codeboard/core";
import { state } from "./store";
import { rooted } from "./root";

export const look = () => state.host.settings.theme;

/** clear：直角折线绕到卡外时离卡边多远（route.ts 的 CLEAR），只有路面宽的材质要加大 */
/** band / foot：代码卡显示色带（大标题）/ 底栏（Card.tsx 只在这些主题里建这两块） */
type Shape = { route: "curve" | "elbow"; head: "chevron" | "triangle" | "dot" | "car"; port: "circle" | "square" | "diamond" | "plaza"; clear?: number; band?: boolean; foot?: boolean };
const SHAPES: Partial<Record<ThemeId, Partial<Shape>>> = {
  classic: { head: "triangle" },
  drafting: { route: "elbow", head: "triangle", port: "square" },
  "soft-light": { head: "dot" },
  colorful: { head: "triangle", band: true, foot: true },
  newspaper: { head: "triangle", band: true },
  poster: { port: "diamond", band: true },
  "ink-wash": { head: "dot" },
  // City：路横平竖直；被调用那头停一辆车代替箭头；起点是一块圆形小广场。路沿、路口见 canvas/Links.tsx，车、标线和车流见 canvas/Traffic.tsx
  // clear 40：路面中线离卡边 40，路沿（16px）外还空出 32，约两条路宽
  city: { route: "elbow", head: "car", port: "plaza", clear: 40 },
};
export const shape = (): Shape => ({ route: "curve", head: "chevron", port: "circle", ...SHAPES[look()] });

/** 源文件 → 6 种颜色之一（Colorful 的色带、端口用）。按文件在白板上第一次出现的顺序分，不存进白板；超过 6 个文件就轮回 */
const order = rooted(() => createMemo(() => {
  const m = new Map<string, number>();
  for (const c of state.board.cards) {
    const p = c.kind === "code" ? c.segments[0]?.path : undefined;
    if (p && !m.has(p)) m.set(p, m.size % 6);
  }
  return m;
}));
export const fileHue = (path: string | undefined) => (path ? order().get(path) ?? 0 : 0);

/** City 的红绿灯（车流开关）：不存进设置，每次打开白板都是红灯（车不动，没有常驻动画）。绿灯时车沿路开（canvas/Traffic.tsx） */
export const [traffic, setTraffic] = createSignal(false);
