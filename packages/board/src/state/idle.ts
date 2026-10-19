// 空闲时一点一点做的准备工作（比如概览档的代码灰条）。每次空闲最多做 PER 件：
// 每件的代价落在下一帧的样式计算里（不在回调里），一次做太多那一帧就会卡
const PER = 8;
const queue: (() => void)[] = [];
let on = false;
const later = (f: () => void) => (typeof requestIdleCallback === "function" ? requestIdleCallback(f, { timeout: 2000 }) : setTimeout(f, 50));
function run() {
  for (let i = 0; i < PER && queue.length; i++) queue.shift()!();
  if (queue.length) later(run); else on = false;
}
/** 浏览器空闲时跑 fn（按加入的顺序） */
export function whenIdle(fn: () => void) {
  queue.push(fn);
  if (!on) { on = true; later(run); }
}
