// The web side of the Mac app's parity check (apps/macos/parity.mjs runs it): the real board on a copy of a board (PARITY_DIR, the
// storage folder; PARITY_BOARD), per theme (PARITY_THEMES) and appearance, each card in PARITY_CARDS revealed, pictured at rest
// and selected, cropped PAD around the card, with the card's rect on the page beside it (<id>.json) so the tool crops the app's
// picture the same way; the whole page around the first card too (scene). Output: PARITY_OUT/web-<theme>-<light|dark>/…
// Manual (tiers.json): it needs a board and runs for the app, not for the board.
import * as fs from "node:fs";
import * as path from "node:path";
import { readBoardFile } from "@codeboard/core";
import { test, idle, until, hostBoards } from "../fixtures";

const DIR = process.env.PARITY_DIR ?? "",
  BOARD = process.env.PARITY_BOARD ?? "",
  CARDS = (process.env.PARITY_CARDS ?? "").split(",").filter(Boolean),
  OUT = process.env.PARITY_OUT ?? "";
/** The air around a card in its picture (the app's focus puts a card 40 px in: Auto.swift parity) */
const PAD = 40;
const W = 1400,
  H = 1000;

test("parityWeb", async () => {
  test.skip(!DIR || !BOARD || !OUT, "PARITY_DIR, PARITY_BOARD and PARITY_OUT name the board and the output");
  test.setTimeout(600_000);
  // shared cards come from the library through the host; the page gets the boards as saved here, so they are left out
  const load = (id: string) => {
    const { file } = readBoardFile(JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), "utf8")));
    const gone = new Set(file.cards.filter((c) => (c.kind as string) === "shared").map((c) => c.id));
    file.cards = file.cards.filter((c) => !gone.has(c.id));
    for (const id of gone) delete file.place[id];
    file.links = file.links.filter((l) => !gone.has(l.from.card) && !gone.has(l.to.card));
    return file;
  };
  const file = load(BOARD);
  // hostBoards keeps its boards in <storage>/boards: the pictures' assets go beside them (DIR is a copy)
  if (fs.existsSync(path.join(DIR, "assets")) && !fs.existsSync(path.join(DIR, "boards/assets")))
    fs.cpSync(path.join(DIR, "assets"), path.join(DIR, "boards/assets"), { recursive: true });
  // the boards the sub-board cards show, so their maps are drawn (one level: what the pictures show)
  const subs = file.cards.flatMap((c) =>
    c.kind === "board" && fs.existsSync(path.join(DIR, `${c.board}.json`)) ? [load(c.board)] : [],
  );
  for (const theme of (process.env.PARITY_THEMES ?? "warm-ink,ink-wash").split(","))
    for (const light of [true, false]) {
      const out = path.join(OUT, `web-${theme}-${light ? "light" : "dark"}`);
      fs.mkdirSync(out, { recursive: true });
      const run = await hostBoards([{ ...file, cam: { x: 0, y: 0, z: 1 } } as never, ...(subs as never[])], {
        storage: DIR,
        page: { light, w: W, h: H, scale: 2, settings: { theme } as never },
      });
      const h = await run.open(BOARD),
        page = h.page;
      await idle(h);
      // the sub-board frames' maps come from the host after the board is up
      await until(h, "skeletons", async () => !(await page.locator(".sbname").allTextContents()).includes("Loading…"));
      for (const id of CARDS) {
        await h.post({ type: "reveal", card: id } as never);
        await idle(h);
        const el = page.locator(`.card[data-id="${id}"]`);
        await until(h, `${id} drawn`, () => el.count().then((n) => n > 0));
        // reveal selects the card: at rest first
        await page.keyboard.press("Escape");
        await idle(h);
        const box = (await el.boundingBox())!;
        fs.writeFileSync(
          path.join(out, `${id}.json`),
          JSON.stringify({ x: box.x, y: box.y, w: box.width, h: box.height }),
        );
        const clip = { x: Math.max(0, box.x - PAD), y: Math.max(0, box.y - PAD), width: 0, height: 0 };
        clip.width = Math.min(box.width + 2 * PAD, W - clip.x);
        clip.height = Math.min(box.height + 2 * PAD, H - clip.y);
        if (id === CARDS[0]) await page.screenshot({ path: path.join(out, "scene.png") });
        await page.screenshot({ path: path.join(out, `${id}-show.png`), clip });
        await el.click({ position: { x: 8, y: 8 }, force: true });
        // the pointer away: hover affordances (port dots, head buttons) are not the selected look
        await page.mouse.move(W - 4, H - 4);
        await idle(h);
        await page.screenshot({ path: path.join(out, `${id}-sel.png`), clip });
        await page.keyboard.press("Escape");
        await idle(h).catch(() => {});
      }
      await page.context().close();
    }
});
