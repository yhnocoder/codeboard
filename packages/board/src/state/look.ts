// 材质主题（Settings → Theme）里少数要 JS 配合的东西：连线的走法、箭头和端口的形状，源文件的颜色。
// 其余全在 themes.css。切主题时这里只重算一次连线几何，不加每帧的工作。
import { createMemo } from "solid-js";
import type { ThemeId } from "@codeboard/core";
import { state } from "./store";
import { rooted, boardSignal } from "./root";
import { FLASH_BRUSH, FLASH_SWEEP, GHOST_DISPERSE } from "./timing";

export const look = () => state.host.settings.theme;

/** clear：直角折线绕到卡外时离卡边多远（route.ts 的 CLEAR），只有路面宽的材质要加大 */
/** band / foot：代码卡显示色带（大标题）/ 底栏（Card.tsx 只在这些主题里建这两块） */
/** stroke：brush = 实线画成毛笔笔画（填充的轮廓，@codeboard/core/canvas 的 brushLine）；taper = 起点粗、往箭头均匀收细的
 *  填充线（taperLine）；虚线、点线照旧描边 */
/** port：线起点卡边上的小记号；none = 平时不画（Ink Wash：毛笔线直接从卡边起笔），失联（lost）时、线被选中或指着时照样画出来（拖起点要看得见它） */
/** paper：卡是一张毛边宣纸（每种卡的尺寸画一张图，state/ink.ts） */
/** sect：brush = Section 的框是四笔枯笔（state/inkframe.ts），标题写在上边留的缺口里 */
/** stamp：新出现的编号像印章落下（CodeHead.tsx 加 .stamp，动画在 themes.css） */
/** ghost / flash：删卡的消失动画、跳到某行的闪动有多长（ms，乘 --t 前；不给 = timing.ts 的 GHOST_OUT / FLASH_MS） */
/** glide：右键菜单悬停的那一行、工具栏正在用的工具下面垫一块会滑动的底（Menu.tsx .mpill、Chrome.tsx .tpill），不给整行上色 */
/** scrollLine：卡头下面平时没有线，代码往下滚了才淡出一条细线（CodeBody.tsx 的 .hdl） */
/** spawn：arrow = 顺着箭头新出来的卡（展开调用、换一个调用）先从起点画出箭头，卡再从箭头那里弹出来（actions/common.ts popAlong） */
type Shape = {
  route: "curve" | "elbow";
  head: "chevron" | "triangle" | "dot" | "dart" | "car";
  port: "circle" | "square" | "diamond" | "plaza" | "none";
  clear?: number;
  band?: boolean;
  foot?: boolean;
  stroke?: "brush" | "taper";
  paper?: "deckle";
  sect?: "brush";
  stamp?: boolean;
  ghost?: number;
  flash?: number;
  glide?: boolean;
  scrollLine?: boolean;
  spawn?: "arrow";
};
const SHAPES: Partial<Record<ThemeId, Partial<Shape>>> = {
  // Warm Ink（默认）：收细的暖墨线和小实心箭头；跳到某行是一道暖色从左扫到右；菜单、工具栏的底会滑；新卡顺着箭头出来
  "warm-ink": { head: "dart", stroke: "taper", flash: FLASH_SWEEP, glide: true, scrollLine: true, spawn: "arrow" },
  classic: { head: "triangle" },
  drafting: { route: "elbow", head: "triangle", port: "square" },
  "soft-light": { head: "dot" },
  colorful: { head: "triangle", band: true, foot: true },
  newspaper: { head: "triangle", band: true },
  poster: { port: "diamond", band: true },
  // Ink Wash：毛笔线、毛边宣纸的卡；删卡时墨往中间收着散掉，跳到某行是一笔朱笔划过
  "ink-wash": {
    head: "dot",
    port: "none",
    stroke: "brush",
    paper: "deckle",
    sect: "brush",
    stamp: true,
    ghost: GHOST_DISPERSE,
    flash: FLASH_BRUSH,
  },
  // City：路横平竖直；被调用那头停一辆车代替箭头；起点是一块圆形小广场。路沿、路口见 canvas/Links.tsx，车、标线和车流见 canvas/Traffic.tsx
  // clear 40：路面中线离卡边 40，路沿（16px）外还空出 32，约两条路宽
  city: { route: "elbow", head: "car", port: "plaza", clear: 40 },
};
export const shape = (): Shape => ({ route: "curve", head: "chevron", port: "circle", ...SHAPES[look()] });

/** 源文件 → 6 种颜色之一（Colorful 的色带、端口用）。按文件在白板上第一次出现的顺序分，不存进白板；超过 6 个文件就轮回 */
const order = rooted(() =>
  createMemo(() => {
    const m = new Map<string, number>();
    for (const c of state.board.cards) {
      const p = c.kind === "code" ? c.segments[0]?.path : undefined;
      if (p && !m.has(p)) m.set(p, m.size % 6);
    }
    return m;
  }),
);
export const fileHue = (path: string | undefined) => (path ? (order().get(path) ?? 0) : 0);

/** City 的红绿灯（车流开关）：不存进设置，每次打开白板都是红灯（车不动，没有常驻动画）。绿灯时车沿路开（canvas/Traffic.tsx） */
export const [traffic, setTraffic] = boardSignal(false);
