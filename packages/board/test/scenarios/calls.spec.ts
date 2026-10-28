// Calls (wireframes 03, 12, 13): RPC arrows, process tags, message cards, ↩ back to; Start card, step counter, Arrow legend;
// call tree sidebar; Capture Run on a tiny fixture package (no torch / GPU) through the real host and Python.
// Usage: npm run harness -- rpc walkstart calltree runtime [--light]   screenshots: test-out/harness/{rpc,walkstart,legend,calltree,runtime}-*.png
// SHOTS_DIR=… also copies them there.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { emptyBoard, DEFAULT_SETTINGS, type Board, type CodeCard, type SegView, type HostToBoard } from "@codeboard/core";
import { shot, put, symCard as nvCard, findSym, OUT, REPO, type Host } from "../harness";
import { startAnalysis, analysisOf } from "@codeboard/host/analysis";
import { cardForFileSym } from "@codeboard/host/cards";
import { callVars, expand, peek } from "@codeboard/host/resolve";
import { viewsFor } from "@codeboard/host/views";
import { searchPick } from "@codeboard/host/search";
import { resetIndex, startNameIndex, nameIndexReady } from "@codeboard/host/nameindex";
import { captureRun, runApply } from "@codeboard/host/runs";
import { langOf, useWorkspace } from "@codeboard/host/ws";
import { nodeWorkspace } from "@codeboard/host/test/node-workspace";
import { test, open, check, light, verdict, expect, until, idle } from "../fixtures";

async function shotPr(h: Host, name: string) {
  await shot(h, name);
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
}
/** Right-click menu path: each label but the last is a submenu (hover), the last is clicked */
async function menu(h: Host, ...labels: (string | RegExp)[]) {
  for (let i = 0; i < labels.length; i++) {
    const b = h.page.locator(".ctx button", { hasText: labels[i] }).first();
    if (i < labels.length - 1) await b.hover(); else await b.click();
  }
  await idle(h);
}
async function prompt(h: Host, text: string) {
  await h.page.locator(".dialog input").fill(text);
  await h.page.keyboard.press("Enter"); await idle(h);
}
const head = (h: Host, id: string) => h.page.locator(`.card[data-id="${id}"] .chead`).first();
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + s.text.findIndex((t) => re.test(t)); };
const nv = (qual: string) => { const s = findSym(qual); return nvCard(s.f, s.s); };
const callLink = (id: string, from: CodeCard, line: number, to: string, name: string) => ({ id, from: { card: from.id, seg: from.segments[0].id, line }, to: { card: to }, call: { name, col: 0 } });

test("rpc", () => verdict("rpc", rpc));

test("walkstart", () => verdict("walkstart", walkstart));

test("calltree", () => verdict("calltree", calltree));

test("runtime", () => verdict("runtime", runtime));

/** nano-vllm: step → call ⇢ (RPC shm "run", rank 0 → rank 1…N) → loop → run; run ↩ back to step */
function nanoRpcBoard(): { b: Board; ids: Record<string, string> } {
  const b = emptyBoard("bRpc", "nano-vllm · ranks");
  const step = nv("LLMEngine.step"), call = nv("ModelRunner.call"), loop = nv("ModelRunner.loop"), runc = nv("ModelRunner.run");
  put(b, step, 60, 80, 540); put(b, call, 700, 80, 500); put(b, loop, 1460, 80, 480); put(b, runc, 1460, 560, 520);
  b.links.push(
    callLink("lStep", step, lineOf(step, /model_runner\.call\(/), call.id, "call"),
    { id: "lRpc", from: { card: call.id, seg: call.segments[0].id, line: lineOf(call, /self\.write_shm\(/) }, to: { card: loop.id } },
    { ...callLink("lLoop", loop, lineOf(loop, /self\.call\(/), runc.id, "run"), call: { name: "run", col: 0, ev: { kind: "manual" as const } } },
    { id: "lBack", from: { card: runc.id }, to: { card: step.id } },
  );
  return { b, ids: { step: step.id, call: call.id, loop: loop.id, run: runc.id } };
}

async function rpc(res: Record<string, unknown>) {
  const { b, ids } = nanoRpcBoard();
  const h = await open({ board: b, light, w: 1700, h: 1000 }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  // 1. Arrow menu → Mark as RPC… → mechanism / message / fan-out in the popover
  const lab = page.locator('.lhit[data-link="lRpc"]').first();
  await lab.click({ button: "right", force: true });
  await menu(h, "Mark as RPC…");
  res.pop = await page.locator(".pop.k-rpc").count();
  await page.locator(".pop.k-rpc select").first().selectOption("shm");
  await page.locator(".pop.k-rpc input.fld.mono").fill("run"); await page.locator(".pop.k-rpc input.fld.mono").press("Enter");
  await page.locator(".pop.k-rpc select").nth(1).selectOption("all");
  await until(h, "the RPC mark is saved", () => h.board().links.find((l) => l.id === "lRpc")?.rpc?.fan === "all");
  res.mark = h.board().links.find((l) => l.id === "lRpc")?.rpc;
  res.label = await page.locator('.vchips[data-link="lRpc"] .rpcl').textContent().catch(() => "");
  res.dashdot = await page.locator('.link[data-lk="lRpc"] path.edge.rpc').count();
  // same call-graph mark across the RPC arrow
  res.marks = await Promise.all([ids.step, ids.call, ids.loop, ids.run].map((id) => page.locator(`.card[data-id="${id}"] .chead .step`).first().textContent().catch(() => "")));
  // 2. Process tags (free text) and a lighter thread / stream tag
  for (const [id, t, light2] of [[ids.call, "rank 0", false], [ids.loop, "rank 1…N", false], [ids.run, "rank 1…N", false], [ids.run, "CUDA stream 0", true]] as const) {
    await head(h, id).click({ button: "right", position: { x: 200, y: 12 } });
    await menu(h, /^Edit/, light2 ? "Thread / Stream Tag…" : "Process Tag…");
    await prompt(h, t);
  }
  await until(h, "the tags are saved", () => (h.board().cards.find((c) => c.id === ids.run)?.procs?.length ?? 0) === 2);
  res.procs = await page.locator(".chead .proc").allTextContents();
  res.lightTag = await page.locator(".chead .proc.light").count();
  // 3. ↩ back to: run → step (Walkthrough stops there)
  await page.locator('.lhit[data-link="lBack"]').first().click({ button: "right", force: true });
  await menu(h, "↩ Back to Start");
  await until(h, "the back arrow is saved", () => h.board().links.find((l) => l.id === "lBack")?.back);
  res.back = await page.locator('.vchips[data-link="lBack"] .vbt.back').textContent().catch(() => "");
  // open the RPC popover again for the screenshot
  await page.locator('.vchips[data-link="lRpc"] .rpcl').click();
  await page.locator(".pop.k-rpc").waitFor();
  await shotPr(h, "rpc-1-arrow-tags");
  // 4. Insert message card: call → ["run"] → loop, both RPC; the walk goes through it and stops at ↩
  await page.locator(".pop.k-rpc label.chk input").first().check();
  await until(h, "the message card is saved", () => h.board().cards.some((c) => c.kind === "note" && c.msg));
  const msg = h.board().cards.find((c) => c.kind === "note" && c.msg);
  const legs = h.board().links.filter((l) => l.rpc);
  res.msgCard = msg?.kind === "note" ? msg.md : undefined;
  res.legs = legs.map((l) => `${l.from.card === msg?.id ? "msg" : l.from.card === ids.call ? "call" : "?"}→${l.to.card === msg?.id ? "msg" : l.to.card === ids.loop ? "loop" : "?"}`).sort();
  await idle(h);
  res.msgMark = await page.locator(`.card[data-id="${msg?.id}"] .msgb .step`).textContent().catch((e) => String(e).slice(0, 200));
  await page.keyboard.press("Escape"); await idle(h);
  await page.locator(`.card[data-id="${msg?.id}"] .mk2`).click();
  await shotPr(h, "rpc-2-message-card");
  await page.locator(`.card[data-id="${ids.step}"] .chead`).click({ position: { x: 200, y: 12 } });
  await page.keyboard.press("p");
  await page.locator(".present .cnt").waitFor(); await idle(h);
  res.walk = await page.locator(".present .cnt").textContent().catch(() => "");
  await page.keyboard.press("Escape"); await idle(h);
  // 5. Unchecking it merges the two legs back into one arrow and removes the message card (one undo step)
  const leg = h.board().links.find((l) => l.rpc && l.to.card === msg?.id)!;
  await page.locator(`.vchips[data-link="${leg.id}"] .rpcl`).click();
  await page.locator(".pop.k-rpc label.chk input").first().uncheck();
  await until(h, "the message card is removed", () => !h.board().cards.some((c) => c.id === msg?.id)); await idle(h);
  res.merged = !h.board().cards.some((c) => c.id === msg?.id) && h.board().links.filter((l) => l.rpc && !l.back).map((l) => `${l.from.card === ids.call ? "call" : "?"}→${l.to.card === ids.loop ? "loop" : "?"}`).join();
  await page.keyboard.press("Escape"); await idle(h);
  const ok = res.merged === "call→loop" && res.pop === 1 && (res.mark as { mech?: string; msg?: string; fan?: string })?.mech === "shm" && (res.mark as { msg?: string }).msg === "run" && res.label === 'RPC · shm · "run" · one → all ranks'
    && res.dashdot === 1 && new Set(res.marks as string[]).size === 1 && (res.marks as string[])[0] === "A"
    && JSON.stringify(res.procs) === JSON.stringify(["rank 0", "rank 1…N", "rank 1…N", "CUDA stream 0"]) && res.lightTag === 1
    && res.back === "↩ back to A" && res.msgCard === "run" && JSON.stringify(res.legs) === JSON.stringify(["call→msg", "msg→loop"]) && res.msgMark === "A"
    && res.walk === "1 / 5";
  await page.context().close();
  return ok;
}

/** Start card: Walkthrough with nothing selected starts there; step counter 2 / 4 and badges; Arrow legend panel (rename) */
async function walkstart(res: Record<string, unknown>) {
  const b = emptyBoard("bWalk", "nano-vllm · step");
  const step = nv("LLMEngine.step"), sched = nv("Scheduler.schedule"), alloc = nv("BlockManager.allocate"), call = nv("ModelRunner.call");
  put(b, step, 60, 120, 560); put(b, sched, 700, 120, 560); put(b, alloc, 1340, 120, 480); put(b, call, 700, 760, 520);
  b.links.push(
    callLink("l1", step, lineOf(step, /scheduler\.schedule\(/), sched.id, "schedule"),
    callLink("l2", sched, lineOf(sched, /block_manager\.allocate\(/), alloc.id, "allocate"),
    callLink("l3", step, lineOf(step, /model_runner\.call\(/), call.id, "call"),
    { id: "l4", from: { card: call.id }, to: { card: step.id } }, // a cycle back: visited cards are not walked again
  );
  // the newest card first in creation order, so the default (first root) would not be step
  b.born = { [call.id]: 0, [step.id]: 1, [sched.id]: 2, [alloc.id]: 3 }; b.seq = 4;
  const h = await open({ board: b, light, w: 1600, h: 1000 }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  await head(h, step.id).click({ button: "right", position: { x: 200, y: 12 } });
  await menu(h, "Call Graph", "Start Card");
  await until(h, "the Start card is saved", () => h.board().place[step.id]?.start);
  res.startTag = await page.locator(`.card[data-id="${step.id}"] .startt`).count();
  await page.mouse.click(800, 990); // empty canvas: nothing selected
  await page.keyboard.press("p");
  await page.locator(".present .ptitle").waitFor(); await idle(h);
  res.first = await page.locator(".present .ptitle").textContent().catch(() => "");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".present .cnt")).toHaveText(/^2 \//); await idle(h);
  res.cnt = await page.locator(".present .cnt").textContent().catch(() => "");
  res.badges = await page.locator(".wsteps .wstep").allTextContents();
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  await page.locator('button[aria-label="Zoom Out"]').click(); await page.mouse.move(800, 900);
  await shotPr(h, "walkstart-1-step-counter");
  await page.keyboard.press("Escape"); await idle(h);
  res.badgesAfter = await page.locator(".wsteps .wstep").count();
  res.stored = JSON.stringify(h.board()).includes("wstep") || "walk" in (h.board() as object);
  // Arrow legend: dock toggle, five built-in names, rename one
  await page.locator('button[aria-label="Arrow Legend"]').click();
  await page.locator(".cpanel.legend .lgname").first().waitFor();
  res.legend = await page.locator(".cpanel.legend .lgname").allTextContents();
  await page.locator('.cpanel.legend .lgrow[data-k="see"]').dblclick();
  await prompt(h, "Related");
  await until(h, "the renamed legend entry is saved", () => h.board().legend?.see === "Related");
  res.renamed = h.board().legend;
  // Style ▸ in the arrow menu uses the legend's names
  await page.locator('.lhit[data-link="l4"]').first().click({ button: "right", force: true });
  await page.locator(".ctx button", { hasText: /^Style/ }).first().hover();
  await expect(page.locator(".ctx.open")).toHaveCount(2);
  res.styleMenu = await page.locator(".ctx.open").last().locator("button").allTextContents().catch(() => []);
  await page.keyboard.press("Escape"); await idle(h);
  await page.mouse.click(800, 990);
  await shotPr(h, "legend-1-panel");
  const ok = res.startTag === 1 && /LLMEngine\.step/.test(String(res.first)) && res.cnt === "2 / 4" && JSON.stringify(res.badges) === JSON.stringify(["1", "2", "3", "4"].filter((x) => (res.badges as string[]).includes(x))) && (res.badges as string[]).length === 4
    && res.badgesAfter === 0 && !res.stored
    && JSON.stringify(res.legend) === JSON.stringify(["Call", "RPC", "Observed", "Generated from", "See also"]) && (res.renamed as { see?: string })?.see === "Related" && (res.styleMenu as string[]).some((t) => /Related/.test(t));
  await page.context().close();
  return ok;
}

/** Call tree sidebar: from Start (or the selection), indented, a card with two callers shows twice (↑ above), click flies to the card */
async function calltree(res: Record<string, unknown>) {
  const { b, ids } = nanoRpcBoard();
  b.links.find((l) => l.id === "lRpc")!.rpc = { mech: "shm", msg: "run", fan: "all" };
  b.links.find((l) => l.id === "lBack")!.back = true;
  const sched = nv("Scheduler.schedule"), alloc = nv("BlockManager.allocate");
  const step = b.cards.find((c) => c.id === ids.step) as CodeCard;
  put(b, sched, 60, 760, 520); put(b, alloc, 700, 760, 480);
  b.links.push(callLink("t1", step, lineOf(step, /scheduler\.schedule\(/), sched.id, "schedule"), callLink("t2", sched, lineOf(sched, /block_manager\.allocate\(/), alloc.id, "allocate"));
  b.links.push({ ...callLink("t3", b.cards.find((c) => c.id === ids.run) as CodeCard, lineOf(b.cards.find((c) => c.id === ids.run) as CodeCard, /prepare_|run_model/), alloc.id, "allocate"), call: { name: "allocate", col: 0, ev: { kind: "manual" as const } } });
  b.place[ids.step].start = true;
  const h = await open({ board: b, light, w: 1700, h: 1000 }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  await page.locator('button[aria-label="Call Tree"]').click();
  await page.locator(".cpanel.ctree .ctrow").first().waitFor();
  res.from = await page.locator(".cpanel.ctree .cph small").textContent().catch(() => "");
  res.rows = await page.locator(".cpanel.ctree .ctrow").evaluateAll((els) => els.map((e) => `${Math.round((parseFloat((e as HTMLElement).style.paddingLeft) - 8) / 14)}:${e.querySelector(".ctt")?.textContent}${e.classList.contains("again") ? " ↑" : ""}${e.querySelector(".ctrpc") ? " RPC" : ""}`));
  await page.locator(".cpanel.ctree .ctrow", { hasText: "BlockManager.allocate" }).first().click(); await idle(h);
  res.sel = await page.locator(".card.sel .ctitle").first().textContent().catch(() => "");
  // a selected card in the graph becomes the root
  res.fromSel = await page.locator(".cpanel.ctree .cph small").textContent().catch(() => "");
  await page.mouse.click(1200, 990);
  await shotPr(h, "calltree-1-sidebar");
  const want = ["0:LLMEngine.step", "1:Scheduler.schedule", "2:BlockManager.allocate", "1:ModelRunner.call", "2:ModelRunner.loop RPC", "3:ModelRunner.run", "4:BlockManager.allocate ↑"];
  const ok = /from Start/.test(String(res.from)) && JSON.stringify(res.rows) === JSON.stringify(want) && res.sel === "BlockManager.allocate" && /selected/.test(String(res.fromSel));
  await page.context().close();
  return ok;
}

/** Capture Run on test fixtures/runtime (toyllm: no torch, no GPU) with the real host + python3, then apply it to a board */
async function runtime(res: Record<string, unknown>) {
  const FIX = fs.mkdtempSync("/tmp/codeboard-runtime-");
  fs.cpSync(path.join(REPO, "packages/host/test/fixtures/runtime"), FIX, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: FIX });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: FIX });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"], { cwd: FIX });
  useWorkspace(nodeWorkspace(FIX));
  await startAnalysis();
  resetIndex(); startNameIndex(); await nameIndexReady();
  const card = async (rel: string, qual: string) => {
    const abs = path.join(FIX, rel);
    const sym = analysisOf(langOf(abs), fs.readFileSync(abs, "utf8")).symbols.find((s) => s.qual === qual)!;
    return (await cardForFileSym(abs, sym))!.card as CodeCard;
  };
  const B = emptyBoard("bRun", "toyllm · step");
  const step = await card("toyllm/engine.py", "LLMEngine.step"), sched = await card("toyllm/scheduler.py", "Scheduler.schedule");
  const mcall = await card("toyllm/model_runner.py", "ModelRunner.call"), mrun = await card("toyllm/model_runner.py", "ModelRunner.run");
  put(B, step, 60, 100, 600); put(B, sched, 760, 60, 520); put(B, mcall, 760, 520, 520); put(B, mrun, 1480, 520, 520);
  B.links.push(
    callLink("r1", step, lineOf(step, /scheduler\.schedule\(/), sched.id, "schedule"),
    { ...callLink("r2", step, lineOf(step, /model_runner\.call\(/), mcall.id, "call"), call: { name: "call", col: 0, vars: [{ a: '"run"', b: "method_name" }] } },
    { ...callLink("r3", mcall, lineOf(mcall, /return method\(/), mrun.id, "method"), call: { name: "method", col: 0, ev: { kind: "manual" as const } } },
  );
  const views: Record<string, SegView> = await viewsFor(B.cards.flatMap((c) => (c.kind === "code" ? c.segments : [])));
  const h = await open({
    board: B, light, w: 1700, h: 1000,
    on: async (m, reply) => {
      switch (m.type) {
        case "ready": return true;
        case "expand": await reply(m.req, await expand(m)); return true;
        case "peek": await reply(m.req, await peek(m)); return true;
        case "views": await reply(m.req, await viewsFor(m.segs)); return true;
        case "callVars": await reply(m.req, await callVars(m)); return true;
        case "searchPick": await reply(m.req, await searchPick(m.item)); return true;
        case "prefetch": return true;
        default: return false;
      }
    },
  });
  const init: HostToBoard = { type: "init", board: B, boards: [{ id: B.id, name: B.name, cards: B.cards.length }], views, stale: {}, host: { isMac: true, assetBase: "", target: true, settings: { ...DEFAULT_SETTINGS } } };
  await h.post(init); await idle(h);
  const page = h.page;
  // 1. Capture: python3 runs the entry once with the tracer from a temp dir (nothing written into the fixture)
  const before = fs.readdirSync(FIX).sort().join(",");
  const rec = await captureRun({ cmd: "run.py 2", cwd: FIX, scope: [FIX], pkgs: [] });
  res.exit = rec.exit; res.sites = rec.calls.length; res.commit = !!rec.commit;
  res.untouched = fs.readdirSync(FIX).sort().join(",") === before;
  const tens = rec.calls.find((c) => c.to.qual === "ModelRunner.sample")?.samples[0]?.args[0];
  res.tensor = tens?.[1];
  // 2. Apply: matching Call arrows turn Observed with the actual values; the rest are listed
  await h.post({ type: "run", apply: await runApply(rec) });
  await until(h, "the run's Observed arrows are saved", () => h.board().links.filter((l) => l.call?.ev?.kind === "observed").length === 3); await idle(h);
  res.observed = h.board().links.filter((l) => l.call?.ev?.kind === "observed").map((l) => `${l.id}:${l.call!.ev!.count}${l.call!.ev!.base ? `:${l.call!.ev!.base}` : ""}`);
  res.tags = await page.locator(".ev-tag.observed").count();
  res.tip = await page.locator('.vchips[data-link="r3"] .ev-tag.observed').getAttribute("data-tip");
  res.vals = await page.locator('.vchips[data-link="r3"] .vrun .vrow').allTextContents();
  res.argVal = await page.locator('.vchips[data-link="r2"] .vbox .vv').first().textContent().catch(() => "");
  await page.locator('.vchips[data-link="r3"] .vsb[aria-label="Next call"]').click(); await idle(h);
  res.stepped = await page.locator('.vchips[data-link="r3"] .vstep span').textContent().catch(() => "");
  res.misses = await page.locator(".cpanel.runp .rrow").count();
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  await page.mouse.move(5, 5);
  await shotPr(h, "runtime-1-values");
  // 3. The panel: calls with no arrow; Add from a line that is on the board → card + Call arrow, already Observed
  const row = page.locator(".cpanel.runp .rrow", { hasText: "Scheduler.postprocess" }).first();
  res.rowText = await row.textContent().catch(() => "");
  await shotPr(h, "runtime-2-uncaptured");
  await row.locator(".radd").click();
  await until(h, "the added card is saved", () => h.board().cards.some((c) => c.kind === "code" && c.segments[0]?.symbol?.qual === "Scheduler.postprocess")); await idle(h);
  const pp = h.board().cards.find((c) => c.kind === "code" && c.segments[0]?.symbol?.qual === "Scheduler.postprocess");
  const pl = h.board().links.find((l) => l.to.card === pp?.id);
  res.added = pl?.call?.ev?.kind === "observed" && pl.from.card === step.id;
  res.missesAfter = await page.locator(".cpanel.runp .rrow").count();
  await page.locator('button[aria-label="Close Run Panel"]').click(); await idle(h);
  await page.locator('button[aria-label="Fit to Window"]').click(); await page.mouse.move(800, 900);
  await shotPr(h, "runtime-3-added");
  const ok = res.exit === 0 && (res.sites as number) >= 8 && res.commit && res.untouched && res.tensor === "Tensor[10, 64] float16"
    && JSON.stringify((res.observed as string[]).sort()) === JSON.stringify(["r1:2", "r2:2", "r3:2:manual"]) && res.tags === 3 && /Manual/.test(String(res.tip)) && /run\.py 2/.test(String(res.tip))
    && (res.vals as string[]).some((v) => /seqs.*list · len 2/.test(v)) && (res.vals as string[]).some((v) => /is_prefill.*True/.test(v)) && res.argVal === "'run'"
    && res.stepped === "call 2 / 2" && (res.misses as number) >= 5 && res.added && (res.missesAfter as number) === (res.misses as number) - 1;
  await page.context().close();
  return ok;
}
