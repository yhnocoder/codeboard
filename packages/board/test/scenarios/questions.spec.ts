import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type CodeCard, type Sidenote } from "@codeboard/core";
import { shot, put, symCard, findSym, OUT, type Host } from "../harness";
import { test, open, check, light, verdict, until, idle, hostBoards } from "../fixtures";
import type { Page } from "@playwright/test";

async function shotPr(h: Host, name: string) {
  await shot(h, name);
  const d = process.env.SHOTS_DIR;
  if (d) {
    fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`));
  }
}
/** The exported snapshot page has settled: no finite animation running and the camera still for 3 frames */
const still = (v: Page) =>
  v
    .waitForFunction(
      () => {
        const w = window as unknown as { __still?: { n: number; t: string } },
          q = (w.__still ??= { n: 0, t: "" });
        const t = (document.querySelector(".world") as HTMLElement | null)?.style.transform ?? "";
        const busy =
          document
            .getAnimations()
            .some((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime)) ||
          t !== q.t;
        q.t = t;
        q.n = busy ? 0 : q.n + 1;
        return q.n >= 3;
      },
      undefined,
      { polling: "raf" },
    )
    .then(() =>
      v.evaluate(() => {
        delete (window as unknown as { __still?: unknown }).__still;
      }),
    );
const nv = (qual: string) => {
  const s = findSym(qual);
  return symCard(s.f, s.s);
};
const lineOf = (c: CodeCard, re: RegExp) => {
  const s = c.segments[0];
  return s.start + s.text.findIndex((t) => re.test(t));
};
/** A question sidenote on one line of a code card, its line a Highlight as adding it there makes it */
const lineQuestion = (id: string, c: CodeCard, re: RegExp, md: string, q: Record<string, unknown> = {}): Sidenote => {
  const s = c.segments[0],
    l = lineOf(c, re);
  (s.hl ??= []).push([l, l]);
  return { id, kind: "text", md, at: { card: c.id, seg: s.id, lines: [l, l] }, q: { at: 1, ...q } } as Sidenote;
};

test("questions", () => verdict("questions", questions));

// Going to a question far away from the question list: its popup opens once the camera has arrived, also when the flight is slow
// (slow motion makes it several seconds), so it sits next to its badge and not where the badge was mid-flight; a question already in
// view opens at once; the host showing it (a row on another board's list) does the same
test("questionOpensAfterFlight", async () => {
  const b = emptyBoard("bF", "flight");
  const near = nv("Scheduler.schedule"),
    far = nv("BlockManager.allocate");
  put(b, near, 60, 80, 640);
  put(b, far, 5200, 3400, 640);
  b.sidenotes.push(lineQuestion("kF", far, /compute_hash/, "far away question"));
  b.cam = { x: 0, y: 0, z: 1 };
  const run = await hostBoards([b], {
    page: { light, w: 1400, h: 900, settings: { tune: { animSpeed: 40 } } as never },
  });
  const h = await run.open(b.id);
  const pg = h.page;
  const POP = '.pop .slip[data-note="kF"]';
  /** The world's transform when the question's popup appeared */
  const watchPop = () =>
    pg.evaluate((sel) => {
      const w = window as unknown as { __popAt?: string | null };
      w.__popAt = null;
      const world = () => (document.querySelector(".world") as HTMLElement).style.transform;
      const mo = new MutationObserver(() => {
        if (document.querySelector(sel)) {
          w.__popAt = world();
          mo.disconnect();
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      return world();
    }, POP);
  const popAt = () => pg.evaluate(() => (window as unknown as { __popAt?: string | null }).__popAt);
  const world = () => pg.evaluate(() => (document.querySelector(".world") as HTMLElement).style.transform);
  const nextToBadge = () =>
    pg.evaluate((id) => {
      const p = document.querySelector(".pop.k-highlight")!.getBoundingClientRect(),
        s = document.querySelector(`.card[data-id="${id}"] .hxm`)!.getBoundingClientRect();
      return (
        Math.min(
          Math.abs(p.left - s.right),
          Math.abs(p.right - s.left),
          Math.abs(p.top - s.bottom),
          Math.abs(p.bottom - s.top),
        ) < 40
      );
    }, far.id);
  const fromList = async () => {
    await pg.locator(".qlist-btn").click();
    await pg.locator('.qlist-row[data-q="kF"]').waitFor();
    await idle(h);
    await pg.locator('.qlist-row[data-q="kF"]').click();
  };
  // from the question list: the camera flies to the far card
  const before = await watchPop();
  await fromList();
  await pg.locator(POP).waitFor({ timeout: 15000 });
  await idle(h, 15000);
  const list = { before, popAt: await popAt(), after: await world(), next: await nextToBadge() };
  await shot(h, "questions-after-flight");
  // the question is in view now: its row again opens it without moving the camera
  await pg.keyboard.press("Escape");
  await idle(h);
  const inPlace = await watchPop();
  await fromList();
  await pg.locator(POP).waitFor();
  const inView = { before: inPlace, popAt: await popAt() };
  // the host shows it (a row on another board's list), after panning far away from it
  await pg.keyboard.press("Escape");
  await idle(h);
  await pg.mouse.move(700, 450);
  await pg.mouse.wheel(-6000, -4000);
  await idle(h);
  const home = await watchPop();
  await run.tell({ type: "openBoard", id: b.id, question: "kF" });
  await pg.locator(POP).waitFor({ timeout: 15000 });
  await idle(h, 15000);
  const host = { before: home, popAt: await popAt(), after: await world(), next: await nextToBadge() };
  const r = { list, inView, host };
  check("questionOpensAfterFlight-list", list.before !== list.after && list.popAt === list.after && list.next, r);
  check("questionOpensAfterFlight-inView", inView.popAt === inView.before, r);
  check("questionOpensAfterFlight-host", host.before !== host.after && host.popAt === host.after && host.next, r);
  await h.page.context().close();
});

test("export", () => verdict("export", exportScenario));

test("settingsPage", () => verdict("settingsPage", settings));

/** Right-click a code line's number and pick a line-menu item */
async function lineMenu(h: Host, card: string, line: number, label: string) {
  const page = h.page;
  const l = page.locator(`.card[data-id="${card}"] .gutter .no`, { hasText: new RegExp(`^${line}$`) }).first();
  await l.click({ button: "right" });
  await page.locator(".ctx:not(.closing) button", { has: page.locator(`.lb:text-is("${label}")`) }).click();
}

/** A question asked on a line (the ? in the sidenote input), answered, resolved and reopened, its answer edited away; the question
 *  list with this board's, every board's (grouped) and the resolved ones; a row on another board; the welcome back hint */
async function questions(res: Record<string, unknown>) {
  const b = emptyBoard("bQ", "nano-vllm · Scheduler");
  const alloc = nv("BlockManager.allocate");
  put(b, alloc, 60, 80, 640);
  // the project's other boards, in the host's storage: two open questions on ModelRunner, a resolved one on DeepEP
  const mr = emptyBoard("bMR", "nano-vllm · ModelRunner");
  const cap = nv("ModelRunner.capture_cudagraph"),
    pre = nv("ModelRunner.prepare_prefill");
  put(mr, cap, 60, 80, 640);
  put(mr, pre, 760, 80, 640);
  mr.sidenotes.push(
    lineQuestion("k1", cap, /def capture_cudagraph/, "CUDA graph 为什么只在 decode 用？", { at: 10 }),
    lineQuestion("k2", pre, /cu_seqlens_q/, "prepare_prefill 里 cu_seqlens 是什么 shape？", { at: 20 }),
  );
  const ep = emptyBoard("bEP", "DeepEP");
  ep.cards.push({ id: "c3", kind: "note", md: "**intranode::dispatch**", look: "note" });
  ep.place.c3 = { x: 60, y: 80, w: 360 };
  ep.sidenotes.push({
    id: "k3",
    kind: "text",
    md: "sm_id % 2 决定 sender，为什么？",
    at: { card: "c3" },
    q: { at: 5, done: true },
  });
  const run = await hostBoards([b, mr, ep], { page: { light, w: 1500, h: 900 } });
  const h = await run.open(b.id),
    page = h.page;
  await page.keyboard.press("Shift+Digit1");
  await idle(h);
  const L1 = lineOf(alloc, /compute_hash/);
  const pop = page.locator(".pop.k-highlight");
  const qn = () => h.board().sidenotes.find((n) => n.kind === "text" && n.q);
  const q = () => {
    const n = qn();
    return n?.kind === "text" ? n.q : undefined;
  };
  res.noList = await page.locator(".qlist-btn").count();
  // 1. Right-click a line → Add Sidenote, the ? in its input makes it a question; ↵ asks it: the input folds to its +, question mode off
  await lineMenu(h, alloc.id, L1, "Add Sidenote");
  await pop.locator(".ncomp .md-pm:focus").waitFor();
  await pop.locator('.ncomp-ask[aria-label="Question"]').click();
  await page.keyboard.type("为什么 hash 要把前一块的 h 也算进去？");
  await shotPr(h, "questions-1-ask");
  await page.keyboard.press("Enter");
  await until(h, "the question is saved", () => qn());
  await idle(h);
  const n = qn()!;
  res.asked = { at: n.at, md: n.kind === "text" && n.md, q: !!q() };
  res.folded = { composer: await pop.locator(".ncomp").count(), add: await pop.locator(".tray .add").count() };
  await pop.locator(".tray .add").click();
  res.askOff = await pop.locator('.ncomp-ask[aria-label="Question"]').getAttribute("aria-pressed");
  await page.keyboard.press("Escape");
  await idle(h);
  res.badge = await page.locator(`.card[data-id="${alloc.id}"] .hxm.ask`).textContent();
  res.listCount = await page.locator(".qlist-btn .qlist-n").textContent();
  // 2. Answer it in the reply row
  const slip = page.locator(`.slip[data-note="${n.id}"]`);
  await slip.locator(".reply").click();
  await slip.locator(".ans-in .md-pm:focus").waitFor();
  await page.keyboard.type("整条前缀一起认：见 block_manager");
  await page.keyboard.press("Enter");
  await until(h, "the answer is saved", () => q()?.answers?.length === 1);
  await idle(h);
  await shotPr(h, "questions-2-answered");
  // 3. Resolve: a grey ✓, no reply row, no ? on the line; the ✓ again reopens it
  await slip.hover();
  await slip.locator('.qbody [aria-label="Resolve"]').click();
  await until(h, "the question is resolved", () => q()?.done);
  await idle(h);
  res.resolved = {
    mark: await slip.locator(".qm").getAttribute("aria-label"),
    reply: await slip.locator(".reply").count(),
    ask: await page.locator(`.card[data-id="${alloc.id}"] .hxm.ask`).count(),
    list: await page.locator(".qlist-btn").count(),
  };
  await slip.hover();
  await slip.locator('.qbody [aria-label="Reopen"]').click();
  await until(h, "the question is open again", () => q() && !q()!.done);
  await idle(h);
  res.reopened = { reply: await slip.locator(".reply").count(), ask: await page.locator(".hxm.ask").count() };
  // 4. The answer edited in place: written empty it goes
  const ans = slip.locator(".ans").first();
  await ans.hover();
  await ans.locator('[aria-label="Edit Answer"]').click();
  await ans.locator(".md-pm:focus").waitFor();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await until(h, "the emptied answer is deleted", () => !q()?.answers?.length);
  await idle(h);
  await page.keyboard.press("Escape");
  await idle(h);
  // 5. The question list: this board's; emptied field, every board's, grouped; the resolved ones too
  await page.locator(".qlist-btn").click();
  await page.locator(".qlist-row").first().waitFor();
  await idle(h); // the other boards come with the host's reply
  res.field = await page.locator('.qlist-pick input[aria-label="Board"]').inputValue();
  res.mine = await page.locator(".qlist-row").count();
  await page.locator(".qlist-clear").click();
  await idle(h);
  res.groups = await page.locator(".qlist-group").allTextContents();
  res.allOpen = await page.locator(".qlist-row").count();
  res.order = await page.locator(".qlist-row .qlist-l").allTextContents();
  res.where = await page.locator('.qlist-row[data-q="k2"] .qlist-w').textContent();
  await shotPr(h, "questions-3-list");
  await page.locator('.qlist-pop [aria-label="Show Resolved"]').click();
  await idle(h);
  res.withResolved = await page.locator(".qlist-row").count();
  res.groupsResolved = await page.locator(".qlist-group").allTextContents();
  // 6. A row on another board: the host opens that board at the question
  await page.locator('.qlist-row[data-q="k2"]').click();
  await until(h, "the row asks the host to open its board", () => h.sent.some((m) => m.type === "openBoard"));
  res.openBoard = h.sent.filter((m) => m.type === "openBoard").at(-1);
  res.listClosed = await page.locator(".qlist-pop").count();
  // 7. Welcome back: the host says this board was last opened 5 days ago
  const opened = run.host.hub.globalState.get<Record<string, number>>("codeboard.opened") ?? {};
  await run.host.hub.globalState.set("codeboard.opened", { ...opened, bQ: Date.now() - 5 * 864e5 - 6e4 });
  await page.reload();
  await page.locator(".welcome").waitFor();
  await idle(h);
  res.welcome = await page.locator(".welcome").textContent();
  await shotPr(h, "questions-4-welcome");
  await page.locator(".welcome button", { hasText: "Show" }).click();
  await idle(h);
  res.welcomeList = await page.locator(".qlist-pop").count();
  const asked = res.asked as { at: { lines?: number[] }; md: string; q: boolean };
  const ok =
    res.noList === 0 &&
    asked.q &&
    asked.md.startsWith("为什么 hash") &&
    JSON.stringify(asked.at.lines) === JSON.stringify([L1, L1]) &&
    JSON.stringify(res.folded) === '{"composer":0,"add":1}' &&
    res.askOff === "false" &&
    res.badge === "?" &&
    res.listCount === "1" &&
    JSON.stringify(res.resolved) === '{"mark":"Resolved","reply":0,"ask":0,"list":0}' &&
    JSON.stringify(res.reopened) === '{"reply":1,"ask":1}' &&
    res.field === "nano-vllm · Scheduler" &&
    res.mine === 1 &&
    JSON.stringify(res.groups) === JSON.stringify(["nano-vllm · Scheduler", "nano-vllm · ModelRunner"]) &&
    res.allOpen === 3 &&
    JSON.stringify((res.order as string[]).slice(1)) ===
      JSON.stringify(["prepare_prefill 里 cu_seqlens 是什么 shape？", "CUDA graph 为什么只在 decode 用？"]) &&
    String(res.where).includes("model_runner.py:") &&
    res.withResolved === 4 &&
    (res.groupsResolved as string[]).includes("DeepEP") &&
    (res.openBoard as { id?: string; question?: string })?.id === "bMR" &&
    (res.openBoard as { question?: string }).question === "k2" &&
    res.listClosed === 0 &&
    String(res.welcome).includes("5 days ago") &&
    String(res.welcome).includes("1 open question") &&
    res.welcomeList === 1;
  await page.context().close();
  return !!ok;
}

/** nano-vllm Scheduler board: schedule (Start) → can_allocate, allocate (calls); can_allocate → Note; Section; sidenotes; a question */
function schedBoard() {
  const b = emptyBoard("bSch", "Scheduler");
  const sch = nv("Scheduler.schedule"),
    can = nv("BlockManager.can_allocate"),
    alloc = nv("BlockManager.allocate");
  put(b, sch, 60, 80, 640);
  put(b, can, 780, 80, 600);
  put(b, alloc, 780, 640, 600);
  b.place[sch.id].start = true;
  const note = {
    id: "nPC",
    kind: "note" as const,
    md: "## prefix caching\n\n`block_manager.can_allocate` 只认整条前缀：cost $O(n)$ per seq, see __init__.",
    look: "note",
  };
  b.cards.push(note);
  b.place[note.id] = { x: 1460, y: 80, w: 380 };
  b.sections.push({ id: "secPC", title: "Prefix caching", x: 1430, y: 30, w: 440, h: 360 });
  b.place[note.id].section = "secPC";
  const s0 = sch.segments[0];
  b.links.push(
    {
      id: "lCan",
      from: { card: sch.id, seg: s0.id, line: lineOf(sch, /can_allocate\(/) },
      to: { card: can.id },
      call: { name: "can_allocate", col: 0 },
    },
    {
      id: "lAlloc",
      from: { card: sch.id, seg: s0.id, line: lineOf(sch, /\.allocate\(/) },
      to: { card: alloc.id },
      call: { name: "allocate", col: 0 },
    },
    { id: "lSee", from: { card: can.id }, to: { card: note.id }, label: "why" },
  );
  s0.hl = [[lineOf(sch, /# prefill/), lineOf(sch, /# prefill/)]];
  b.sidenotes.push({
    id: "snA",
    kind: "text",
    at: { card: sch.id, seg: s0.id, lines: [lineOf(sch, /# prefill/), lineOf(sch, /# prefill/)] },
    md: "先 prefill 再 decode",
  });
  b.sidenotes.push({
    id: "snPriv",
    kind: "text",
    at: { card: sch.id },
    md: "PRIVATE draft: ask Linda",
    boardOnly: true,
  });
  b.sidenotes.push(lineQuestion("kQ", can, /compute_hash/, "为什么 hash 要把前一块的 h 也算进去？"));
  return { b, ids: { sch: sch.id, can: can.id, alloc: alloc.id, note: note.id } };
}

async function exportScenario(res: Record<string, unknown>) {
  const { b, ids } = schedBoard();
  const files: Record<string, string> = {};
  const run = await hostBoards([b], {
    page: {
      light,
      w: 1500,
      h: 900,
      // GitHub permalinks need the repository's origin on GitHub, which a checkout here may not have: the links come from here
      on: async (m, reply) => {
        if (m.type !== "permalinks") return false;
        await reply(
          m.req!,
          Object.fromEntries(
            m.segs
              .filter((s) => s.src.kind === "repo")
              .map((s) => [
                s.id,
                `https://github.com/GeeeekExplorer/nano-vllm/blob/bb823b3c0ffee/${s.path}#L${s.start}-L${s.end}`,
              ]),
          ),
        );
        return true;
      },
    },
  });
  // the editor's Save dialog: into test-out/; its "Exported …" notice comes once the file is written
  let saving = "";
  run.ws.ui = {
    ...run.ws.ui,
    saveDialog: async (o) => (saving = path.join(OUT, `export-${process.pid}-${path.basename(o.defaultPath)}`)),
    info: async (text) => {
      if (text.startsWith("Exported ")) files[path.extname(saving).slice(1)] = saving;
      return undefined;
    },
  };
  const h = await run.open(b.id),
    page = h.page;
  await page.keyboard.press("Shift+Digit1");
  await idle(h);
  // 1. ⋯ → Export…: format, scope (Walkthrough A from the Start card), include, look, file
  await page.locator('.bbar [aria-label="More"]').click();
  await page.locator(".ctx:not(.closing) button", { hasText: "Export…" }).click();
  await page.locator(".xdlg").waitFor();
  await idle(h);
  res.dialog = await page.locator(".xdlg").count();
  await page.locator(".xdlg .seg button", { hasText: "Walkthrough A" }).click();
  await idle(h);
  res.defaults = await page
    .locator(".xdlg input[type=checkbox]")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked));
  await shotPr(h, "export-1-dialog");
  // 2. HTML snapshot of walkthrough A
  const t0 = Date.now();
  await page.locator(".xdlg button.def").click();
  await until(h, "the HTML snapshot is written", () => files.html, 20000);
  res.htmlMs = Date.now() - t0;
  // files.html 在 reply() 关对话框之前就有了：等它关掉（关不掉的话 5 秒后照样记下 1）
  await page
    .locator(".xdlg")
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
  res.closed = await page.locator(".xdlg").count();
  const html = fs.readFileSync(files.html, "utf8");
  res.htmlKB = Math.round(html.length / 1024);
  res.cbres = (html.match(/cbres:/g) ?? []).length;
  res.fontData = (html.match(/url\("data:font\/woff2;base64,/g) ?? []).length;
  res.noScriptSrc = !/<script[^>]+src=/.test(html);
  res.privateInHtml = html.includes("PRIVATE draft");
  // 3. Markdown of the whole board with questions
  await page.locator('.bbar [aria-label="More"]').click();
  await page.locator(".ctx:not(.closing) button", { hasText: "Export…" }).click();
  await page.locator(".xdlg").waitFor();
  await idle(h);
  await page.locator(".xdlg .seg button", { hasText: "Markdown" }).click();
  await page.locator(".xdlg .seg button", { hasText: "Whole Board" }).click();
  await page.locator(".xdlg label", { hasText: "Questions" }).locator("input").check();
  await idle(h);
  await page.locator(".xdlg button.def").click();
  await until(h, "the Markdown is written", () => files.md, 10000);
  const md = fs.readFileSync(files.md, "utf8");
  res.md = {
    order: [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
    permalink: md.includes(
      "[permalink](https://github.com/GeeeekExplorer/nano-vllm/blob/bb823b3c0ffee/nanovllm/engine/scheduler.py#L",
    ),
    fence: md.includes("```python\ndef schedule(self)"),
    arrow: md.includes("→ BlockManager.can_allocate · from line"),
    sidenote: md.includes("> 先 prefill 再 decode"),
    question: md.includes("- [ ] **Question** (line"),
    escaped: md.includes("\\_"),
    priv: md.includes("PRIVATE"),
  };
  // 4. Open the snapshot in Chromium: renders offline (no network), pans, zooms, walks, shows sidenotes on hover; nothing is editable
  const v = await page.context().browser()!.newPage();
  await v.setViewportSize({ width: 1400, height: 860 });
  const net: string[] = [];
  v.on("request", (r) => {
    if (!/^(file|data|blob):/.test(r.url())) net.push(r.url());
  });
  const errs: string[] = [];
  v.on("pageerror", (e) => errs.push(e.message));
  await v.goto(`file://${files.html}`);
  await v.waitForFunction(() => document.querySelector(".world .card[data-id]") && document.fonts.status === "loaded");
  await still(v);
  res.view = await v.evaluate(() => ({
    cards: [...document.querySelectorAll(".world .card[data-id]")].map((c) => (c as HTMLElement).dataset.id),
    lines: document.querySelectorAll(".world .card .src .l").length,
    links: document.querySelectorAll(".world [data-lk]").length,
    look: document.documentElement.dataset.look,
    editable: document.querySelectorAll("[contenteditable]").length,
    fontsOk: [...document.fonts].filter((f) => f.status === "loaded").length,
    walk: !(document.querySelector(".xv-walk") as HTMLElement).hidden,
  }));
  const tf = () => v.evaluate(() => (document.querySelector(".world") as HTMLElement).style.transform);
  const t1 = await tf();
  await v.mouse.move(200, 700);
  await v.mouse.down();
  await v.mouse.move(120, 640, { steps: 4 });
  await v.mouse.up();
  const t2 = await tf();
  await v.mouse.move(700, 430);
  await v.keyboard.down("Control");
  await v.mouse.wheel(0, -200);
  await v.keyboard.up("Control");
  await still(v);
  const t3 = await tf();
  res.pan = t1 !== t2;
  res.zoom = t2 !== t3;
  await v.locator(".xv-wt").click();
  await v.locator('.xv-walk [data-w="next"]').click();
  await still(v);
  res.walkStep = await v.locator(".xv-walk .cnt").textContent();
  res.cur = await v.evaluate(() => (document.querySelector(".xv-cur") as HTMLElement | null)?.dataset.id);
  await v.locator('.xv-walk [data-w="prev"]').click();
  await still(v);
  const mk = v.locator(`.card[data-id="${ids.sch}"] .gutter .hxm`).first();
  await mk.hover();
  await v.locator(".xv-tip").waitFor();
  res.tip = await v.locator(".xv-tip").textContent();
  res.net = net;
  res.errs = errs;
  await v.screenshot({ path: path.join(OUT, "export-2-html.png") });
  if (process.env.SHOTS_DIR)
    fs.copyFileSync(path.join(OUT, "export-2-html.png"), path.join(process.env.SHOTS_DIR, "export-2-html.png"));
  // 5. The Markdown sample, shown as text
  await v.setContent(
    `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fbfaf7"><pre style="margin:0;padding:20px 28px;font:12.5px/1.55 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:#2b2b2b">${md.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre></body>`,
  );
  await v.setViewportSize({ width: 1000, height: 1300 });
  await v.screenshot({ path: path.join(OUT, "export-3-markdown.png") });
  if (process.env.SHOTS_DIR)
    fs.copyFileSync(path.join(OUT, "export-3-markdown.png"), path.join(process.env.SHOTS_DIR, "export-3-markdown.png"));
  const view = res.view as {
    cards: string[];
    lines: number;
    links: number;
    editable: number;
    fontsOk: number;
    walk: boolean;
    look: string;
  };
  const m = res.md as Record<string, unknown>;
  const ok =
    res.dialog === 1 &&
    JSON.stringify(res.defaults) === "[false,false]" &&
    res.closed === 0 &&
    res.cbres === 0 &&
    (res.fontData as number) > 0 &&
    res.noScriptSrc &&
    !res.privateInHtml &&
    JSON.stringify(view.cards.sort()) === JSON.stringify([ids.sch, ids.can, ids.alloc, ids.note].sort()) &&
    view.lines > 40 &&
    view.links >= 3 &&
    view.editable === 0 &&
    view.fontsOk > 0 &&
    view.walk &&
    view.look === "warm-ink" &&
    res.pan &&
    res.zoom &&
    res.walkStep === "2 / 4" &&
    res.cur === ids.can &&
    String(res.tip).includes("先 prefill 再 decode") &&
    !(res.net as string[]).length &&
    !(res.errs as string[]).length &&
    JSON.stringify(m.order) ===
      JSON.stringify([
        "A · Scheduler.schedule",
        "A · BlockManager.can_allocate",
        "A · BlockManager.allocate",
        "prefix caching",
      ]) &&
    m.permalink &&
    m.fence &&
    m.arrow &&
    m.sidenote &&
    m.question &&
    !m.escaped &&
    !m.priv;
  await page.context().close();
  return !!ok;
}

async function settings(res: Record<string, unknown>) {
  const { b } = schedBoard();
  const h = await open({ board: b, light, w: 1400, h: 1000 }),
    page = h.page;
  await page.keyboard.press("Meta+Comma").catch(() => undefined);
  await idle(h);
  if (!(await page.locator(".settings").count())) {
    await page.locator('.bbar [aria-label="More"]').click();
    await page.locator(".ctx:not(.closing) button", { hasText: "Settings…" }).click();
  }
  await page.locator(".settings").waitFor();
  await idle(h);
  await page.locator('.settings [data-sec="shared"]').evaluate((el) => el.scrollIntoView({ block: "start" }));
  await idle(h);
  res.secs = await page.locator(".settings .st-sec h3").allTextContents();
  await page.locator('.settings [data-sec="shared"] .st-chip', { hasText: "Title Only" }).click();
  await page.locator('.settings [data-sec="questions"] .st-chip', { hasText: "Always" }).click();
  await page.locator('.settings [data-sec="export"] .st-chip', { hasText: "Walkthrough" }).click();
  await page.locator('.settings [data-sec="export"] .st-chip', { hasText: /^On$/ }).first().click();
  await until(h, "the four settings are sent", () => h.sent.filter((m) => m.type === "setSetting").length >= 4);
  await idle(h);
  await shotPr(h, "settings-1-v02");
  res.set = h.sent
    .filter((m) => m.type === "setSetting")
    .map((m) => `${(m as { key: string }).key}=${JSON.stringify((m as { value: unknown }).value)}`);
  const ok =
    ["Boards", "Questions", "Export"].every((t) => (res.secs as string[]).includes(t)) &&
    JSON.stringify(res.set) ===
      JSON.stringify(['subPreview="title"', 'welcomeBack="always"', 'exportScope="walk"', "exportQuestions=true"]);
  await page.context().close();
  return ok;
}
