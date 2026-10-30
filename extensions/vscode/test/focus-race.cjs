// Click the board, then quickly click into a text editor or open Quick Open, within the board's 1 s keep-the-keyboard window:
// the focus must end where the user put it
const fs = require("fs");
module.exports = async (page, t) => {
  const N = +(process.env.RACE_N || 40);
  await t.openFile(page, `${t.WS}/nanovllm/engine/scheduler.py`, 20);
  const f = await t.newBoard(page, "focus race");
  const spot = await t.emptySpot(f);
  const delays = [0, 20, 50, 100, 200, 400, 700];
  const log = [];
  const inEditor = () => page.evaluate(() => !!document.activeElement?.closest(".monaco-editor") && document.hasFocus() && !document.activeElement?.closest(".quick-input-widget"));
  const inQuick = () => page.evaluate(() => !!document.activeElement?.closest(".quick-input-widget") && document.hasFocus());
  for (let i = 0; i < N; i++) {
    const mode = i % 2 ? "quickopen" : "editor", d = delays[i % delays.length];
    await t.clickBoard(f, { position: spot });
    if (d) await t.hold(d, "the user's gap between clicking the board and going elsewhere");
    if (mode === "editor") await page.locator(".editor-group-container .monaco-editor .view-lines").first().click({ position: { x: 60, y: 30 } });
    else await page.keyboard.press("Control+p");
    const at0 = mode === "editor" ? await inEditor() : await t.soon(inQuick, (v) => v, 3000);
    await t.hold(1300, "past CLICK_KEEPS_KEYS: the board must not take the keyboard back meanwhile");
    const at1 = mode === "editor" ? await inEditor() : await inQuick();
    const board = await f.evaluate(() => (window.frameElement?.ownerDocument ?? document).hasFocus()).catch(() => null);
    log.push({ i, mode, d, at0, at1, board });
    if (!at1) console.log("  LOST", JSON.stringify(log[log.length - 1]));
    if (mode === "quickopen") { await page.keyboard.press("Escape"); await t.qiClosed(page, "Quick Open"); }
  }
  fs.writeFileSync(`${t.OUT}/focus-race.json`, JSON.stringify(log, null, 1));
  const lost = log.filter((r) => !r.at1);
  t.check(lost.length === 0, `focus race: the keyboard stays where the user put it (${N} runs)`, lost);
};
