// 真机试用（nano-vllm、白板放在编辑器旁边）后的体验修正
// Usage: node packages/board/test/run-harness.mjs <scenario>   screenshots: test-out/harness/ux-*.png
import { emptyBoard, type CodeCard } from "@codeboard/core";
import { open, shot, put, symCard, findSym, type Host } from "./harness";

const wait = (h: Host, ms = 600) => h.page.waitForTimeout(ms);
const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };
const run = async (name: string, f: (res: Record<string, unknown>) => Promise<boolean>) => {
  const res: Record<string, unknown> = {};
  let ok = false;
  try { ok = await f(res); } catch (e) { console.log("FAIL", name, (e as Error).message.split("\n")[0], JSON.stringify(res)); process.exit(1); }
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(res));
  if (!ok) process.exitCode = 1;
};

export const UX: Record<string, () => Promise<void>> = {
  "dock-fits-narrow-board": () => run("dock-fits-narrow-board", dockFits),
};

/** 底部工具条：每个宽度都是一行，彼此不重叠，也不出窗口 */
async function dockFits(res: Record<string, unknown>) {
  let ok = true;
  for (const w of [540, 640, 760, 900, 1080, 1400]) {
    const b = emptyBoard("bN", "narrow");
    const c = nv("LLMEngine.step"); put(b, c, 40, 40, 460);
    const h = await open({ board: b, w, h: 700 });
    await wait(h, 400);
    const m = await h.page.evaluate(() => {
      const rs = [...document.querySelectorAll(".over.bbar .pill, .over.dock .pill")].filter((e) => (e as HTMLElement).offsetParent).map((e) => e.getBoundingClientRect());
      return { pills: rs.map((r) => ({ l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) })), vw: innerWidth };
    });
    // 一行：所有的条在同一条水平带上
    const oneRow = Math.max(...m.pills.map((p) => p.t)) < Math.min(...m.pills.map((p) => p.b));
    const overlap = m.pills.some((a, i) => m.pills.some((b, j) => i < j && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b));
    const inside = m.pills.every((p) => p.l >= 8 && p.r <= m.vw - 8);
    res[w] = { pills: m.pills.length, oneRow, overlap, inside };
    if (overlap || !inside || !oneRow) ok = false;
    if (w === 540) {
      // 收起来的按钮在 ⋯ 里：New Web Card 能用，Call Tree 能开
      await h.page.locator('.bbar button[aria-label="More"]').click(); await wait(h, 400);
      res.folded = await h.page.locator(".ctx button").allInnerTexts().then((t) => t.filter((x) => /New Web Card|Call Tree|Arrow Legend|Add a Sticker/.test(x)).length);
      await h.page.locator(".ctx button", { hasText: "Call Tree" }).click(); await wait(h, 400);
      res.tree = await h.page.locator(".cpanel.ctree").count();
      if (res.folded !== 4 || res.tree !== 1) ok = false;
    }
    await shot(h, `ux-dock-${w}`);
    await h.page.context().browser()!.close();
  }
  return ok;
}
