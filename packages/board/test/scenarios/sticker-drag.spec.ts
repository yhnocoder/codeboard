// Dragging a sticker on a board with many cards stays cheap: away from every card the board does not ask the browser what is under
// the pointer (document.elementsFromPoint costs milliseconds per move with hundreds of cards); dropped near a card it still binds
//   stickerDragSkipsHitTestAwayFromCards  no elementsFromPoint while the sticker moves over empty board, and dropped over a
//                                         card it is bound to that card
import { emptyBoard, type NoteCard } from "@codeboard/core";
import { put } from "../harness";
import { test, open, check, light, until, idle } from "../fixtures";

test("stickerDragSkipsHitTestAwayFromCards", async () => {
  const b = emptyBoard("b1", "stickers");
  for (let i = 0; i < 40; i++)
    put(
      b,
      { id: `n${i}`, kind: "note", md: `Note ${i}`, look: "note" } as NoteCard,
      40 + (i % 8) * 110,
      40 + Math.floor(i / 8) * 90,
      100,
    );
  b.stickers.push({
    id: "k",
    icon: { pack: "builtin", name: "star" },
    at: { kind: "canvas", x: 1150, y: 650, size: 32 },
  });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1500, h: 950 });
  const pg = h.page;
  await idle(h);
  await pg.evaluate(() => {
    const w = window as unknown as { __hits: number };
    w.__hits = 0;
    const orig = document.elementsFromPoint.bind(document);
    document.elementsFromPoint = (x: number, y: number) => {
      w.__hits++;
      return orig(x, y);
    };
  });
  const hits = () => pg.evaluate(() => (window as unknown as { __hits: number }).__hits);
  const box = (await pg.locator('[data-sticker="k"]').boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await pg.mouse.move(x, y);
  await pg.mouse.down();
  await pg.mouse.move(x + 40, y + 30, { steps: 6 });
  await pg.mouse.move(x + 120, y + 90, { steps: 6 });
  const away = await hits();
  // over the first note: the hit test runs there, and the drop binds the sticker to it
  const n0 = (await pg.locator('.card[data-id="n0"]').boundingBox())!;
  await pg.mouse.move(n0.x + n0.width / 2, n0.y + n0.height / 2, { steps: 12 });
  await pg.mouse.up();
  const at = await until(h, "the sticker is bound to a card", () => {
    const s = h.board().stickers.find((k) => k.id === "k");
    return s?.at.kind === "canvas" && s.at.on && "card" in s.at.on ? s.at.on.card : undefined;
  });
  const near = await hits();
  check("stickerDragSkipsHitTestAwayFromCards", away === 0 && near > 0 && at === "n0", { away, near, at });
  await pg.context().close();
});
