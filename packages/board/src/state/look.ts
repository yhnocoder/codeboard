// 材质主题（Settings → Theme）里少数要 JS 配合的东西：连线的走法、箭头和端口的形状，源文件的颜色。
// 其余全在 themes.css。切主题时这里只重算一次连线几何，不加每帧的工作。
import { createMemo, createRoot, createSignal } from "solid-js";
import { state } from "./store";
export { fileHash } from "./filehash";

export const look = () => state.host.settings?.theme ?? "warm-ink";

/** clear：直角折线绕到卡外时离卡边多远（route.ts 的 CLEAR），只有路面宽的材质要加大 */
type Shape = { route: "curve" | "elbow"; head: "chevron" | "triangle" | "dot" | "car"; port: "circle" | "square" | "diamond" | "plaza"; clear?: number };
const SHAPES: Record<string, Partial<Shape>> = {
  classic: { head: "triangle" },
  drafting: { route: "elbow", head: "triangle", port: "square" },
  "soft-light": { head: "dot" },
  colorful: { head: "triangle" },
  newspaper: { head: "triangle" },
  poster: { port: "diamond" },
  bamboo: { head: "dot" },
  "ink-wash": { head: "dot" },
  blocks: { head: "dot" },
  // City：路横平竖直；被调用那头停一辆车代替箭头；起点是一块圆形小广场。路沿、中线、路口、车流见 canvas/Links.tsx
  // clear 40：路面中线离卡边 40，路沿（16px）外还空出 32，约两条路宽
  city: { route: "elbow", head: "car", port: "plaza", clear: 40 },
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

/** City 的红绿灯（车流开关）：不存进设置，每次打开白板都是红灯（车不动，没有常驻动画）。绿灯时车沿路开（canvas/Links.tsx 的 Traffic） */
export const [traffic, setTraffic] = createSignal(false);
