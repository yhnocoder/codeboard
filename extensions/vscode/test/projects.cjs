// Copy / Move to Another Project… between two VS Code windows that are open at the same time, one of them a multi-root workspace.
// E2E_ONLY=projects runs only this step (part 2 runs it too).
//
// The step starts its own VS Code, separate from the one run.sh drives: an extension development host does not let a second window
// with the extension in it be opened from the command line (VS Code reuses the development window instead). So this VS Code has the
// extension installed (a link in its extensions dir) and its own short user-data-dir. Then `code <multi-root.code-workspace>` with the
// same user-data-dir does what it does for a user: hands over to the running VS Code, which opens a second window. Two windows, one
// main process, each with its own extension host; the project registry (codeboard.projects) is in the shared global state. Two VS Code
// processes with separate user-data-dirs share nothing, so they cannot see each other's projects.
//
//   S  = the nano-vllm copy (single folder)
//   M  = multi-root.code-workspace: [notes (a small git repo), the nano-vllm copy]: nano-vllm is M's second folder
//   1. In S: a board with LLMEngine.step, Copy to M (listed by its workspace name). M (open the whole time) lists it without a reload,
//      the card shows its code, Open in Editor opens llm_engine.py at def step. nano-vllm is M's second folder: the source is written
//      relative to M's first folder ("../ws"), the same as a card M adds itself. A second copy arrives as "Engine copy (2)"
//   2. In M: a board with notes' admit and nano-vllm's Scheduler.schedule, Move to S. S lists it without a reload; Scheduler.schedule
//      (nano-vllm = S's folder) is repo-relative there, admit (notes, outside S) external; both show their code, admit opens notes/kv.py at
//      line 4; M no longer lists the board and its file is in M's .trash
const { chromium } = require("playwright-core");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { until, soon, idle, track } = require("./wait.cjs");
const { command, qiClosed, openFile, boardFrame, boardFrames, card, text, boardHasKeyboard } = require("./ui.cjs");

const EXT = path.resolve(__dirname, "..");
const CODE = process.env.VSCODE_BIN || process.env.VSCODE_TEST_PATH || "/opt/vscode/code";

/** Click the quick pick row whose label (aria-label up to ", ") contains text; false when there is none within ms (the list is the
 *  command's answer, e.g. the projects to copy to: nothing is typed) */
async function clickRow(p, text, ms = 8000) {
  const rows = p.locator(".quick-input-widget .monaco-list-row");
  const want = text.toLowerCase();
  return soon(async () => {
    const i = await rows.evaluateAll((rs, t) => rs.findIndex((r) => (r.getAttribute("aria-label") ?? "").toLowerCase().split(", ")[0].includes(t)), want);
    return i >= 0 && rows.nth(i).click({ timeout: 1500 }).then(() => true, () => false);
  }, Boolean, ms, 100);
}

// ---------- the board ----------
/** Alt+B on the function at file:line; resolves to the board frame once the card is there (null when it never shows). The board may
 *  be in a background tab (the file opened over it in the same group): look in every board webview, shown or not */
async function addFunction(p, file, line, title) {
  await openFile(p, file, line);
  await p.keyboard.press("Alt+b");
  const has = async (f) => (await card(f, title).count()) > 0;
  return soon(async () => { for (const f of await boardFrames(p, { visible: false })) if (await has(f)) return f; return null; }, Boolean, 20000, 200);
}
async function renameBoard(p, name) {
  await command(p, "CodeBoard: Rename Board", "Rename board");
  await p.keyboard.press("Control+a"); await p.keyboard.type(name); await p.keyboard.press("Enter"); await qiClosed(p, "the Rename Board input box");
}
const sideRow = (p, name) => p.locator(".part.sidebar .monaco-list-row", { hasText: name });
/** The board's row in the CodeBoard sidebar shows up within ms (the window is never reloaded) */
async function listed(p, name, ms) {
  await command(p, "Focus on Boards View");
  if (await soon(() => sideRow(p, name).count(), Boolean, ms, 200)) return true;
  console.log(`  … sidebar rows: ${JSON.stringify(await p.locator(".part.sidebar .monaco-list-row").allInnerTexts())}`);
  return false;
}
/** Copy / Move the window's target board to the project whose row contains project */
async function transfer(p, move, project, board) {
  await command(p, `CodeBoard: ${move ? "Move" : "Copy"} to Another Project…`, "to which project?");
  if (!(await clickRow(p, project))) return `no project ${project} in the pick list: ${(await p.locator(".quick-input-widget .monaco-list-row").allInnerTexts()).join(" | ")}`;
  if (move) {
    const dlg = p.locator(".monaco-dialog-box");
    if (!(await soon(() => dlg.isVisible(), Boolean, 5000))) return "no Move confirmation";
    await dlg.locator(".monaco-button", { hasText: /^Move$/ }).click();
  }
  const done = p.locator(".notification-list-item-message", { hasText: `${move ? "Moved" : "Copied"} “${board}”` });
  return (await soon(() => done.count(), Boolean, 10000)) ? "" : "no done message";
}
/** Select a card and press Enter (Open in Editor); returns the tab, breadcrumb path and cursor line of the editor that shows file */
async function openCardCode(p, f, title, file) {
  await f.locator("#board").click({ position: { x: 20, y: 200 } }); await p.keyboard.press("Escape");
  await card(f, title).locator(".chead .ctitle").click();
  await until(`${title} is selected and the board has the keyboard`, async () => /\bsel\b/.test(await card(f, title).getAttribute("class")) && await boardHasKeyboard(f));
  await p.keyboard.press("Enter");
  // The code opens beside the board and the keyboard stays on the board: find the group that shows file, then click its tab
  // so the status bar shows that editor's cursor (it is empty while the board has the focus)
  const g = p.locator(".editor-group-container", { has: p.locator(".tab.active", { hasText: file }) }).first();
  const ln = p.locator("#status\\.editor\\.selection");
  if (await soon(() => g.count(), Boolean, 8000, 200)) {
    await g.locator(".tab.active").click();
    await soon(async () => /^Ln \d+/.test((await text(ln)).trim()), Boolean, 5000, 100);
  }
  return { tab: (await text(g.locator(".tab.active"))).trim(), crumbs: (await g.locator(".breadcrumbs-control .monaco-icon-label").allInnerTexts()).join("/"), ln: (await text(ln)).trim() };
}

// ---------- where each window keeps its boards ----------
/** The boards dir of the window whose workspace.json points at uri-ending (a folder or a .code-workspace) */
function boardsDir(ud, ending) {
  const root = path.join(ud, "User", "workspaceStorage");
  for (const h of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    let w; try { w = JSON.parse(fs.readFileSync(path.join(root, h, "workspace.json"), "utf8")); } catch { continue; }
    if (String(w.folder ?? w.workspace ?? "").endsWith(ending)) return path.join(root, h, "yhnocoder.codeboard-vscode", "boards");
  }
  return null;
}
const boardsIn = (dir, sub = "") => { try { return fs.readdirSync(path.join(dir, sub)).filter((n) => n.endsWith(".json")).map((n) => ({ file: n, b: JSON.parse(fs.readFileSync(path.join(dir, sub, n), "utf8")) })); } catch { return []; } };
const segOf = (b, file) => b.cards.flatMap((c) => c.segments ?? []).find((s) => s.path.endsWith(file));
/** How many windows of the VS Code with this user-data-dir have started activating CodeBoard (each window's extension host logs it).
 *  Activating is what records the window's project (extension.ts recordProject) */
const activated = (ud) => {
  const root = path.join(ud, "logs");
  let n = 0;
  for (const s of fs.existsSync(root) ? fs.readdirSync(root) : []) for (const w of fs.readdirSync(path.join(root, s)).filter((x) => /^window\d+$/.test(x))) {
    const log = path.join(root, s, w, "exthost", "exthost.log");
    if (fs.existsSync(log) && /_doActivateExtension yhnocoder\.codeboard-vscode\b/.test(fs.readFileSync(log, "utf8"))) n++;
  }
  return n;
};

module.exports = async function projectsStep({ check, OUT, WS, UD, port }) {
  const T0 = Date.now();
  const TMP = path.dirname(UD);
  const PUD = path.join(TMP, "p"); // short: VS Code's IPC socket lives under the user-data-dir
  const NOTES = path.join(TMP, "notes"), MULTI = path.join(TMP, "multi-root.code-workspace");
  const shot = async (p, n) => { const [f] = await boardFrames(p); if (f) await idle(f); await p.screenshot({ path: path.join(OUT, `${n}.png`) }); };
  const kill = () => { try { execFileSync("pkill", ["-f", "--", `--user-data-dir=${PUD}`]); } catch { /* none left */ } };
  kill();
  fs.rmSync(PUD, { recursive: true, force: true }); fs.rmSync(NOTES, { recursive: true, force: true });
  // notes: a small git repo with one function, def admit on line 4
  fs.mkdirSync(NOTES, { recursive: true });
  fs.writeFileSync(path.join(NOTES, "kv.py"), ["# Admission control for a KV cache.", "# (e2e fixture)", "", "def admit(waiting, budget):",
    "    batch = []", "    for req in waiting:", "        if req.tokens > budget:", "            break", "        budget -= req.tokens", "        batch.append(req)", "    return batch", ""].join("\n"));
  const git = (...a) => execFileSync("git", ["-C", NOTES, "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...a], { stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "notes");
  fs.writeFileSync(MULTI, JSON.stringify({ folders: [{ path: NOTES }, { path: WS }] }, null, 1));
  // The extension installed by a link (a second window can't be an extension development host), settings for a quiet window and a DOM modal
  const version = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8")).version;
  fs.mkdirSync(path.join(PUD, "ext"), { recursive: true }); fs.mkdirSync(path.join(PUD, "User"), { recursive: true });
  fs.symlinkSync(EXT, path.join(PUD, "ext", `yhnocoder.codeboard-vscode-${version}`));
  fs.writeFileSync(path.join(PUD, "User", "settings.json"), JSON.stringify({
    "workbench.startupEditor": "none", "window.restoreWindows": "none", "window.dialogStyle": "custom", "workbench.tips.enabled": false,
    "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.ignoreRecommendations": true, "chat.disableAIFeatures": true,
    "editor.minimap.enabled": false, "git.openRepositoryInParentFolders": "never", "workbench.secondarySideBar.defaultVisibility": "hidden",
  }));
  const args = (target) => [CODE, target, `--user-data-dir=${PUD}`, `--extensions-dir=${path.join(PUD, "ext")}`, "--disable-workspace-trust",
    "--skip-welcome", "--skip-release-notes", "--disable-gpu", "--no-sandbox", "--window-size=1280,800", `--remote-debugging-port=${port}`];
  const launch = (target) => {
    const a = args(target);
    return process.env.DISPLAY ? spawn(a[0], a.slice(1), { stdio: "ignore", detached: true }) : spawn("xvfb-run", ["-a", "-s", "-screen 0 1280x800x24", ...a], { stdio: "ignore", detached: true });
  };

  let browser;
  const main = launch(WS);
  try {
    browser = await until("the projects VS Code's debugging port answers", () => chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null), 30000, 200);
    const windows = () => browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().includes("workbench"));
    await until("the projects VS Code's window", () => windows().length, 30000);
    const S = windows()[0];
    await track(S);
    await S.locator(".monaco-workbench .part.editor").waitFor({ timeout: 60000 });
    // A second `code` with the same user-data-dir: hands over to the running VS Code and exits; M opens as a second window
    const cli = launch(MULTI);
    await new Promise((r) => cli.on("exit", r));
    check(await soon(() => windows().length === 2, Boolean, 30000), "a second `code` with the same user-data-dir opens a second window in the running VS Code", windows().length);
    const M = windows().find((p) => p !== S);
    if (!M) return;
    await track(M);
    await M.locator(".monaco-workbench .part.editor").waitFor({ timeout: 60000 });
    // Both windows record themselves on activation (onStartupFinished)
    await until("both windows activate CodeBoard", () => activated(PUD) === 2, 60000, 200);
    console.log(`  … projects: two windows up [${((Date.now() - T0) / 1000).toFixed(0)}s]`);

    // 1. S → M (copy), into a multi-root workspace whose second folder is the source repo
    let f = await addFunction(S, path.join(WS, "nanovllm/engine/llm_engine.py"), 51, "LLMEngine.step");
    check(!!f, "S: Alt+B puts LLMEngine.step on a board");
    if (!f) return;
    await renameBoard(S, "Engine copy");
    await command(M, "Focus on Boards View");
    const err1 = await transfer(S, false, "multi-root", "Engine copy");
    check(!err1, "S: Copy to Another Project… lists the multi-root window by its workspace name and copies the board", err1);
    const seen = await listed(M, "Engine copy", 15000);
    check(seen, "M lists the copied board without a reload");
    if (!seen) {
      await shot(M, "projects-fail-not-listed");
      const reloaded = M.waitForEvent("load", { timeout: 60000 });
      await command(M, "Developer: Reload Window"); await reloaded;
      await M.locator(".monaco-workbench .part.editor").waitFor({ timeout: 60000 });
      check(await listed(M, "Engine copy", 15000), "M lists the copied board after a reload");
    }
    const mDir = boardsDir(PUD, "multi-root.code-workspace"), sDir = boardsDir(PUD, `/${path.basename(WS)}`);
    const copied = boardsIn(mDir).find((x) => x.b.name === "Engine copy");
    const s1 = copied && segOf(copied.b, "llm_engine.py");
    const second = path.relative(NOTES, WS).split(path.sep).join("/");
    check(s1 && s1.src.kind === "repo" && s1.src.repo === second, `M: the copied card's source is repo "${second}" (nano-vllm is M's second folder)`, s1?.src);
    await sideRow(M, "Engine copy").first().click();
    const g = await boardFrame(M);
    check(await soon(() => card(g, "LLMEngine.step").locator(".src", { hasText: "def step(self):" }).count(), Boolean, 15000), "M: the copied card shows its code");
    if (g) {
      const at = await openCardCode(M, g, "LLMEngine.step", "llm_engine.py");
      check(at.tab === "llm_engine.py" && /engine\/llm_engine\.py/.test(at.crumbs) && /^Ln 49\b/.test(at.ln), "M: Open in Editor on the copied card opens engine/llm_engine.py at def step (line 49)", at);
    }
    // Copying it again: the target already has the name, so the second copy is suffixed
    await command(S, "Notifications: Clear All Notifications");
    const err3 = await transfer(S, false, "multi-root", "Engine copy");
    check(!err3 && await listed(M, "Engine copy (2)", 15000), "S: copying the same board again lands as Engine copy (2) in M", err3);
    await shot(M, "projects-1-copied");

    // 2. M → S (move), from the multi-root workspace: one card from each folder
    await command(M, "View: Close All Editors");
    await command(M, "CodeBoard: New Board", "Name of the new board");
    await M.keyboard.press("Control+a"); await M.keyboard.type("Mixed move"); await M.keyboard.press("Enter"); await qiClosed(M, "the New Board input box");
    check(await soon(() => M.locator(".editor-group-container .tab", { hasText: "Mixed move" }).count(), Boolean, 10000), "M: New Board opens the board Mixed move");
    let h = await addFunction(M, path.join(NOTES, "kv.py"), 5, "admit");
    check(!!h, "M: Alt+B puts notes' admit on it");
    if (!h) return;
    h = await addFunction(M, path.join(WS, "nanovllm/engine/scheduler.py"), 30, "Scheduler.schedule");
    check(!!h && await card(h, "admit").count() === 1, "M: Scheduler.schedule from the second folder joins the same board");
    let before;
    await soon(() => (before = boardsIn(mDir).find((x) => x.b.name === "Mixed move")) && segOf(before.b, "scheduler.py"), Boolean, 10000, 200); // saved shortly after the edit
    // The copied card above has to match what M writes itself for its second folder
    const own = segOf(before?.b ?? { cards: [] }, "scheduler.py")?.src;
    check(own?.kind === "repo" && own.repo === second, `M: a card M adds from its second folder has the same source, repo "${second}"`, own);
    await command(S, "Focus on Boards View");
    const err2 = await transfer(M, true, path.basename(WS), "Mixed move");
    check(!err2, "M: Move to Another Project… asks to confirm and moves the board to S", err2);
    check(await listed(S, "Mixed move", 15000), "S lists the moved board without a reload");
    await command(M, "Focus on Boards View");
    check(await soon(async () => !(await sideRow(M, "Mixed move").count()), Boolean, 5000), "M no longer lists the moved board");
    check(before && !boardsIn(mDir).some((x) => x.b.name === "Mixed move") && fs.readdirSync(path.join(mDir, ".trash")).some((n) => n.startsWith(before.b.id)), "M: the moved board's file is in M's .trash", before?.b.id);
    const moved = boardsIn(sDir).find((x) => x.b.name === "Mixed move");
    const sk = moved && segOf(moved.b, "kv.py"), ss = moved && segOf(moved.b, "scheduler.py");
    check(ss && ss.src.kind === "repo" && ss.src.repo === "", "S: Scheduler.schedule (nano-vllm is S's folder) is rewritten repo-relative", ss?.src);
    check(sk && sk.src.kind === "external" && sk.src.root === NOTES, "S: admit (notes is outside S) is rewritten external", sk?.src);
    await sideRow(S, "Mixed move").first().click();
    // S still has Engine copy open in another tab: take the frame that shows the moved board
    f = await until("S shows the moved board", async () => { for (const x of await boardFrames(S)) if (await card(x, "admit").count()) return x; }, 15000, 200);
    check(await soon(async () => await card(f, "admit").locator(".src", { hasText: "def admit(waiting, budget):" }).count() && await card(f, "Scheduler.schedule").locator(".src", { hasText: "def schedule" }).count(), Boolean, 15000), "S: both moved cards show their code");
    const at = await openCardCode(S, f, "admit", "kv.py");
    check(at.tab === "kv.py" && /^Ln 4\b/.test(at.ln), "S: Open in Editor on admit opens notes' kv.py at line 4", at);
    await shot(S, "projects-2-moved");
  } finally {
    await browser?.close();
    try { process.kill(-main.pid, "SIGTERM"); } catch { /* gone */ }
    kill();
    console.log(`  … projects: ${((Date.now() - T0) / 1000).toFixed(0)}s`);
  }
};
