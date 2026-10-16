// 预取：鼠标停在调用上就先问定义、读好目标文件（分析、分词），点下去时只剩建卡；
// 打开白板后在后台给白板上的文件各问一次定义，让语言服务先热起来（第一次点不用等它冷启动）。
import type { Segment } from "@codeboard/core";
import { analysisOf } from "./analysis";
import { cardForFileSym } from "./cards";
import { lspDefs, symAtDef } from "./resolve";
import { workingPlace } from "./versions";
import { log } from "./log";
import { readText } from "./ws";

type PrefetchReq = { seg: Segment; line: number; col: number; name: string };

const MAX_RUN = 2; // 同时最多几个预取
const MAX_WAIT = 4; // 排队的只留最新的几个（鼠标扫过一串调用时，旧的没用了）
let running = 0;
const queue: (() => Promise<void>)[] = [];

function pump() {
  while (running < MAX_RUN && queue.length) {
    const job = queue.shift()!;
    running++;
    void job().catch(() => undefined).finally(() => { running--; pump(); });
  }
}

/** 悬停在调用上：问定义 → 读目标、做分析和分词（结果只进缓存，不发给白板） */
export function prefetchCall(m: PrefetchReq) {
  if (m.seg.src.kind === "free" || m.seg.src.kind === "github") return;
  queue.unshift(() => warmCall(m.seg, m.line, m.col, m.name));
  if (queue.length > MAX_WAIT) queue.length = MAX_WAIT;
  pump();
}

async function warmCall(seg: Segment, line: number, col: number, name: string) {
  const wp = await workingPlace(seg);
  if (!wp?.exact) return; // 钉的版本不是工作区内容：expand 也不问语言服务
  const defs = await lspDefs(wp.abs, wp.start + (line - seg.start), col);
  if (defs.length !== 1) return; // 几个定义要用户挑：不预先建
  const t = await symAtDef(defs[0], name);
  if (t) await cardForFileSym(t.abs, t.sym); // 只为把 token / 分析 / 版本缓存热起来，卡本身丢掉
}

// ---------- 打开白板：后台预热语言服务 ----------

const WARM_DELAY = 1500, WARM_FILES = 6, WARM_GAP = 200, WARM_RETRY = 6;
const warmed = new Map<string, number>(); // 文件 → 上次预热的时间
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 白板上每个文件（最多几个）挑一个调用问一次定义，一个接一个、在悬停预取之后；alive = 白板还开着 */
export function warmBoard(segs: Segment[], alive: () => boolean) {
  const picks = segs.filter((s) => s.src.kind !== "free" && s.src.kind !== "github");
  if (!picks.length) return;
  setTimeout(() => void (async () => {
    const seen = new Set<string>();
    let n = 0;
    for (const seg of picks) {
      if (n >= WARM_FILES || !alive()) break;
      try {
        const wp = await workingPlace(seg);
        if (!wp?.exact || seen.has(wp.abs) || Date.now() - (warmed.get(wp.abs) ?? 0) < 10 * 60_000) continue;
        seen.add(wp.abs);
        const text = await readText(wp.abs);
        if (text === null) continue;
        // 段里的第一个调用（self.xxx() 优先：多半是本仓库的代码，语言服务要把 import 都解析一遍）
        const calls = analysisOf(seg.lang, text).calls.filter((c) => c.line >= wp.start && c.line <= wp.end && !c.dispatch);
        const c = calls.find((x) => x.recv === "self") ?? calls[0];
        if (!c) continue;
        while (running) await sleep(100); // 让悬停预取先走
        warmed.set(wp.abs, Date.now());
        n++;
        const t0 = performance.now();
        // 第一个文件：语言服务可能还在启动（先回空），隔一会儿再问几次，直到它真的答上来
        let d = await lspDefs(wp.abs, c.line, c.col);
        for (let k = 0; n === 1 && !d.length && k < WARM_RETRY && alive(); k++) { await sleep(1500); d = await lspDefs(wp.abs, c.line, c.col); }
        log("info", `warm ${seg.path}:${c.line} ${c.name} → ${d.length} def(s), ${Math.round(performance.now() - t0)} ms`);
        await sleep(WARM_GAP);
      } catch { /* 预热失败不影响什么 */ }
    }
  })(), WARM_DELAY);
}
