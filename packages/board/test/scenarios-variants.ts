// v0.2 my changes (wireframe 07): variant tabs on a code card, MINE, the Add Variant menu listing another worktree,
// switching in one frame with the arrow end and sidenote following the code, the variant note, the diff base picker,
// the three-way view, "Only in This Variant" sidenotes, the merged-upstream prompt and Convert.
// Usage: node packages/board/test/run-harness.mjs variants [--light]   screenshots: test-out/harness/variants-*.png (SHOTS_DIR=… copies them)
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type CodeCard, type Segment, type SegView } from "@codeboard/core";
import { open, shot, put, symCard, findSym, viewOf, OUT, type Host } from "./harness";

const light = process.argv.includes("--light");
const wait = (h: Host, ms = 500) => h.page.waitForTimeout(ms);
async function shotPr(h: Host, name: string, away = true) {
  if (away) await h.page.mouse.move(1490, 700);
  await shot(h, name);
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
}
const run = async (name: string, f: (res: Record<string, unknown>) => Promise<boolean>) => {
  const res: Record<string, unknown> = {};
  let ok = false;
  try { ok = await f(res); } catch (e) { console.log("FAIL", name, (e as Error).message.split("\n")[0], JSON.stringify(res)); process.exit(1); }
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(res));
  if (!ok) process.exitCode = 1;
};
const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };

export const VARIANTS: Record<string, () => Promise<void>> = {
  variants: () => run("variants", variants),
};

/** 宿主的样子：另一个 worktree 上改了两行（一行改、一行加），函数整体下移 7 行 */
function edit(s: Segment, how: "wt" | "branch" | "latest"): Segment {
  const t = [...s.text];
  const i = t.findIndex((l) => /scheduled_seqs = \[\]/.test(l));
  if (how === "wt") { t[i] = t[i].replace("[]", "list()  # keep order"); t.splice(i + 1, 0, t[i].replace(/\S.*/, "budget = self.max_num_batched_tokens  # 8192 → 131 TFLOPS")); }
  if (how === "branch") t.splice(1, 0, t[1].replace(/\S.*/, "# fix-spec-bug: all-accepted rows"));
  if (how === "latest") { t[i] = t[i].replace("[]", "deque()"); t[i + 1] = t[i + 1] + "  # upstream tweak"; } // 一行和我的冲突，一行只有上游改了
  const start = s.start + (how === "wt" ? 7 : how === "latest" ? 3 : 0);
  return { ...s, start, end: start + t.length - 1, text: t, version: { kind: "git", commit: how === "latest" ? "4c1d0e9aa" : how === "wt" ? "77aa12bcd" : "e1f2a3b4c" }, ...(how === "wt" ? { src: { kind: "external" as const, root: "/work/vllm-exp" } } : {}) };
}
const plainView = (s: Segment): SegView => viewOf({ ...s, path: "none/x.py" });

async function variants(res: Record<string, unknown>) {
  const b = emptyBoard("bV", "vllm · RejectionSampler");
  const sch = nv("Scheduler.schedule");
  const add = nv("BlockManager.allocate");
  put(b, sch, 60, 80, 600);
  put(b, add, 760, 80, 520);
  const s0 = sch.segments[0];
  const ret = s0.start + s0.text.length - 1;
  const lineOf = (re: RegExp) => s0.start + s0.text.findIndex((t) => re.test(t));
  const callLine = lineOf(/self\.block_manager\.allocate/);
  b.links.push({ id: "l1", from: { card: sch.id, seg: s0.id, line: callLine }, to: { card: add.id }, call: { name: "allocate", col: 0 } });
  b.sidenotes.push({ id: "n1", at: { card: sch.id, seg: s0.id, lines: [ret, ret] }, kind: "text", md: "returns the batch" });
  let latest: Segment | null = null;
  const h = await open({
    board: b, light, w: 1500, h: 950,
    on: async (m, reply) => {
      if (m.type === "variantSources") {
        await reply(m.req!, { worktrees: [{ dir: "/work/vllm-exp", branch: "exp-overlap", label: "../vllm-exp · exp-overlap" }], branches: ["main", "fix-spec-bug", "exp-overlap"], current: "main", pr: "GeeeekExplorer/nano-vllm" });
        return true;
      }
      if (m.type === "addVariant") {
        const how = m.from.kind === "wt" ? "wt" : "branch";
        const segs = m.segs.map((s) => edit(s, how));
        await reply(m.req!, { name: how === "wt" ? "vllm-exp" : (m.from as { ref: string }).ref, from: m.from, segs, views: Object.fromEntries(segs.map((s) => [s.id, plainView(s)])) });
        return true;
      }
      if (m.type === "views") { await reply(m.req!, Object.fromEntries(m.segs.map((s) => [s.id, plainView(s)]))); return true; }
      return false;
    },
  });
  const page = h.page;
  const card = page.locator(`.card[data-id="${sch.id}"]`);
  const sc = () => h.board().cards.find((c) => c.id === sch.id) as CodeCard;

  // 1. 卡片菜单 → Add Variant…：列出另一个 worktree
  await card.locator(".chead").click({ button: "right", position: { x: 120, y: 12 } }); await wait(h, 300);
  await page.locator(".ctx button", { hasText: /^Add Variant…/ }).click(); await wait(h, 500);
  const items = await page.locator(".ctx button").allTextContents();
  res.menu = items;
  const listed = items.some((t) => /Other Worktree.*vllm-exp · exp-overlap/.test(t)) && items.some((t) => /Working Tree \(uncommitted\)/.test(t)) && items.some((t) => /GitHub Pull Request/.test(t));
  await shotPr(h, "variants-1-add-menu", false);
  await page.locator(".ctx button", { hasText: "Other Worktree" }).click(); await wait(h, 1100); // 自动保存 800ms

  // 2. 标签页 + MINE；改过的行有底色和 ~ / +；箭头起点、Sidenote 跟着代码走（函数下移 7 行、上面多一行）
  const tabs = await card.locator(".vtab:not(.vadd)").allTextContents();
  res.tabs = tabs;
  const mine = await card.locator(".chead .mine").count();
  const vmk = await card.locator(".vmk").allTextContents();
  res.vmk = vmk;
  const lk = h.board().links.find((l) => l.id === "l1")!;
  const nt = h.board().sidenotes.find((n) => n.id === "n1")!;
  res.after = { link: lk.from.line, note: nt.at.lines };
  const followed = lk.from.line === callLine + 8 && nt.at.lines?.[0] === ret + 8;
  const summary = await card.locator(".vcmp .vsum").textContent();
  res.summary = summary;
  await card.locator(".vbtn", { hasText: "Note" }).click(); await wait(h, 200);
  await page.keyboard.type("block_N=64 · num_stages=3 → 131 TFLOPS"); await page.keyboard.press("Enter"); await wait(h, 1100);
  const note = sc().variants?.find((v) => v.id === sc().active)?.note;
  res.note = note;
  await shotPr(h, "variants-2-tabs-mine");

  // 3. 「+」再加一个分支；切换：点标签到画面换好在一帧左右
  await card.locator(".vtab.vadd").click(); await wait(h, 400);
  await page.locator(".ctx button", { hasText: /^Branch or Commit…/ }).hover(); await wait(h, 400);
  await page.locator(".ctx button", { hasText: /^fix-spec-bug/ }).click(); await wait(h, 800);
  const nTabs = await card.locator(".vtab:not(.vadd)").count();
  const t = await page.evaluate(async (id) => {
    const el = document.querySelector(`.card[data-id="${id}"] .vtab.up`) as HTMLElement;
    const t0 = performance.now();
    el.click();
    await new Promise((r) => requestAnimationFrame(() => r(0)));
    const t1 = performance.now();
    const ok = !document.querySelector(`.card[data-id="${id}"] .chead .mine`) && document.querySelector(`.card[data-id="${id}"] .vtab.up.on`) !== null;
    return { ms: Math.round(t1 - t0), ok };
  }, sch.id);
  res.switch = t;
  await wait(h, 1100);
  const back = h.board().links.find((l) => l.id === "l1")!.from.line === callLine && h.board().sidenotes.find((n) => n.id === "n1")!.at.lines?.[0] === ret;
  res.back = { back, link: h.board().links.find((l) => l.id === "l1")!.from.line, note: h.board().sidenotes.find((n) => n.id === "n1")!.at.lines, callLine, ret };

  // 4. 回到 worktree 那个；宿主送来上游最新：对比基准选 Upstream Latest
  await card.locator(".vtab", { hasText: "vllm-exp" }).click(); await wait(h, 1100);
  latest = edit(s0, "latest");
  await h.post({ type: "variants", cards: { [sch.id]: { latest: { label: "main 4c1d0e9", segs: [latest], views: { [latest.id]: plainView(latest) } }, behind: { [sc().active!]: 3 } } } }); await wait(h, 300);
  await card.locator(".vsel").click(); await wait(h, 400);
  const baseItems = await page.locator(".ctx button").allTextContents();
  res.base = baseItems;
  await shotPr(h, "variants-3-base-picker", false);
  await page.locator(".ctx button", { hasText: /Upstream Latest/ }).click(); await wait(h, 400);
  const baseLabel = await card.locator(".vsel").textContent();
  const behind = await card.locator(".vcmp .vbeh").textContent().catch(() => "");
  res.behind = behind;

  // 5. 三方对照
  await card.locator(".vbtn", { hasText: "Three-way" }).click(); await wait(h, 600);
  const cols = await page.locator(".pop.k-three .tcol .th").allTextContents();
  const changedRows = await page.locator(".pop.k-three .tl.k-mine, .pop.k-three .tl.k-add").count();
  const theirs = await page.locator(".pop.k-three .tl.k-theirs").count();
  const both = await page.locator(".pop.k-three .tl.k-both").count();
  const head3 = await page.locator(".pop.k-three .lastc").textContent();
  // 原版那一栏是上游的代码（不是我的）
  const baseRow = await page.locator(".pop.k-three .tcol").first().locator(".tl").nth(1).textContent();
  res.three = { cols, changedRows, theirs, both, head3, baseRow };
  await shotPr(h, "variants-4-three-way");
  await page.keyboard.press("Escape"); await page.locator(".pop.k-three .ph .ib").click().catch(() => {}); await wait(h, 300);

  // 6. 「只在这个 Variant」的 Sidenote
  await card.locator(".mk").first().click(); await wait(h, 500);
  await page.locator(".pop.k-notes .tbtn", { hasText: "Only in This Variant" }).click(); await wait(h, 1100);
  const vOnly = h.board().sidenotes.find((n) => n.id === "n1")?.variant === sc().active;
  await page.locator(".pop.k-notes .ph .ib").click().catch(() => {}); await wait(h, 200);
  await card.locator(".vtab.up").click(); await wait(h, 400);
  const hidden = (await card.locator(".mk").count()) === 0;
  await card.locator(".vtab", { hasText: "vllm-exp" }).click(); await wait(h, 400);
  const shownAgain = (await card.locator(".mk").count()) === 1;
  res.vOnly = { vOnly, hidden, shownAgain };

  // 7. 合进上游：提示转回普通卡，Convert
  await h.post({ type: "variants", cards: { [sch.id]: { merged: { [sc().active!]: "main 4c1d0e9" }, latest: { label: "main 4c1d0e9", segs: [latest], views: { [latest.id]: plainView(latest) } } } } }); await wait(h, 500);
  const toast = await page.locator(".toast").textContent().catch(() => "");
  res.toast = toast;
  await shotPr(h, "variants-5-merged");
  await page.locator(".toast button", { hasText: "Convert" }).click(); await wait(h, 1100);
  const conv = sc();
  const converted = !conv.variants && !conv.active && conv.segments[0].start === latest.start && (conv.segments[0].version as { commit: string }).commit === "4c1d0e9aa";
  const convLink = h.board().links.find((l) => l.id === "l1")!.from.line;
  res.converted = { converted, convLink, tabs: await card.locator(".vtab").count() };

  const ok = listed && tabs.length === 2 && /Upstream · bb823b3/.test(tabs[0]) && /vllm-exp · worktree · exp-overlap/.test(tabs[1]) && mine === 1 && vmk.includes("~") && vmk.includes("+") && followed
    && /1 changed · 1 added/.test(summary ?? "") && note === "block_N=64 · num_stages=3 → 131 TFLOPS"
    && nTabs === 3 && t.ok && t.ms < 40 && back
    && baseItems.some((x) => /Upstream Latest · main 4c1d0e9/.test(x)) && /Upstream latest main 4c1d0e9/.test(baseLabel ?? "") && behind === "3 behind"
    && cols.length === 3 && /Base/.test(cols[0]) && /Mine/.test(cols[1]) && /Upstream latest/.test(cols[2]) && changedRows >= 1 && theirs >= 1 && both === 3 && /^1 line changed on both sides/.test(head3 ?? "") && /scheduled_seqs = \[\]/.test(baseRow ?? "")
    && vOnly && hidden && shownAgain
    && /merged into main/.test(toast ?? "") && converted && convLink === callLine + 3 && res.converted && (res.converted as { tabs: number }).tabs === 0;
  await page.context().browser()!.close();
  return ok;
}
