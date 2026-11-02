// 预取：鼠标停在调用上就先问定义、读好目标文件（分析、分词），点下去时只剩建卡；
// 打开白板后在后台给白板上的文件各问一次定义，让语言服务先热起来（第一次点不用等它冷启动）。
import type { Disposable, Segment } from "@codeboard/core";
import { segAnalysis, treeAt } from "./analysis";
import { cardForFileSym } from "./cards";
import { dispatchOf, symAtDef } from "./resolve";
import type { HostContext } from "./context";
import { Prio, sleep } from "./sched";
import { workingPlace } from "./versions";
import { hasLocalFile } from "./source";

type PrefetchReq = { seg: Segment; line: number; col: number; name: string };

export const WARM_DELAY = 1500,
  WARM_GAP = 200;
const WARM_FILES = 6;
/** How long the first file waits for a language service that is still starting */
const WARM_LSP_WAIT = 9000;

/** One host's prefetch: the hover lane and the board-open warm-up */
export class Prefetch implements Disposable {
  // At most 2 hovers ask at a time; only the newest 4 wait (when the mouse sweeps over a row of calls, the older ones are moot)
  private hover: (job: () => Promise<unknown>) => void;
  private warmed = new Map<string, number>(); // 文件 → 上次预热的时间
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private cx: HostContext) {
    this.hover = cx.sched.lane(Prio.Hover, 2, 4);
  }

  /** 悬停在调用上：问定义 → 读目标、做分析和分词（结果只进缓存，不发给白板） */
  prefetchCall(m: PrefetchReq) {
    if (!hasLocalFile(m.seg.src)) return;
    this.hover(() => this.warmCall(m.seg, m.line, m.col, m.name));
  }

  private async warmCall(seg: Segment, line: number, col: number, name: string) {
    const wp = await workingPlace(this.cx, seg);
    if (!wp?.exact) return; // 钉的版本不是工作区内容：expand 也不问语言服务
    const defs = await this.cx.lsp.defs(wp.abs, wp.start + (line - seg.start), col);
    if (defs.length !== 1) return; // 几个定义要用户挑：不预先建
    const t = await symAtDef(this.cx, defs[0], name);
    // 只为把 token / 分析 / 版本缓存热起来，卡本身丢掉；类里的方法 expand 还要问一次转到实现（动态分发），一起问好
    await Promise.all([t && cardForFileSym(this.cx, t.abs, t.sym), dispatchOf(this.cx, defs[0], name)]);
  }

  /** 白板上每个文件（最多几个）挑一个调用问一次定义，一个接一个、在悬停预取之后；alive = 白板还开着 */
  warmBoard(segs: Segment[], open: () => boolean) {
    const alive = () => open() && !this.disposed;
    const picks = segs.filter((s) => s.src.kind !== "free" && s.src.kind !== "github");
    if (!picks.length) return;
    const timer = setTimeout(
      () =>
        void (async () => {
          this.timers.delete(timer);
          const seen = new Set<string>();
          let n = 0;
          for (const seg of picks) {
            if (n >= WARM_FILES || !alive()) break;
            try {
              const wp = await workingPlace(this.cx, seg);
              if (!wp?.exact || seen.has(wp.abs) || Date.now() - (this.warmed.get(wp.abs) ?? 0) < 10 * 60_000) continue;
              seen.add(wp.abs);
              const text = await this.cx.readText(wp.abs);
              if (text === null) continue;
              // 段里的第一个调用（self.xxx() 优先：多半是本仓库的代码，语言服务要把 import 都解析一遍）
              const calls = segAnalysis(seg.lang, text, wp.start, wp.end, treeAt(this.cx, wp.abs)).calls.filter(
                (c) => c.line >= wp.start && c.line <= wp.end && !c.dispatch,
              );
              const c = calls.find((x) => x.recv === "self") ?? calls[0];
              if (!c) continue;
              await this.cx.sched.clear(Prio.Warm); // 让点击和悬停预取先走
              this.warmed.set(wp.abs, Date.now());
              n++;
              const first = n === 1;
              await this.cx.sched.run(Prio.Warm, async () => {
                const t0 = performance.now();
                // 第一个文件：语言服务可能还在启动（先回空），等它真的答上来
                const ask = () => this.cx.lsp.defs(wp.abs, c.line, c.col);
                let d = await ask();
                if (first) d = await this.cx.lsp.ready(d, ask, WARM_LSP_WAIT, alive);
                this.cx.log(
                  "info",
                  `warm ${seg.path}:${c.line} ${c.name} → ${d.length} def(s), ${Math.round(performance.now() - t0)} ms`,
                );
                // 定义是类里的方法：点它时 expand 还要问转到实现（Pylance 第一次要在整个工作区里找子类），也先问掉
                if (d.length === 1) await dispatchOf(this.cx, d[0], c.name);
              });
              await sleep(WARM_GAP);
            } catch {
              /* 预热失败不影响什么 */
            }
          }
        })(),
      WARM_DELAY,
    );
    this.timers.add(timer);
  }

  dispose() {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
