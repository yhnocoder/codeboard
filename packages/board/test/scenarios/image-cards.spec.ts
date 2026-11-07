// Image cards follow their image's aspect ratio: no blank bands beside or above the picture, after loading and after a resize.
import * as path from "node:path";
import { OUT, type Host } from "../harness";
import { emptyBoard, migrateBoard, type Board } from "@codeboard/core";
import { test, open, check, light, until, idle } from "../fixtures";
import { watch } from "../watch";

const svg = (w: number, hgt: number, fill: string) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}"><rect width="${w}" height="${hgt}" fill="${fill}"/><circle cx="${w / 2}" cy="${hgt / 2}" r="${Math.min(w, hgt) / 3}" fill="#fff8"/></svg>`,
  );

/** How the picture sits in the card: the img box against the body box, and the box's ratio against the image's own */
const fit = (h: Host, id: string) =>
  h.page.evaluate((id) => {
    const img = document.querySelector<HTMLImageElement>(`.card[data-id="${id}"] .imgb img`)!,
      body = img.parentElement!;
    const a = img.getBoundingClientRect(),
      b = body.getBoundingClientRect();
    return {
      img: { w: a.width, h: a.height },
      body: { w: b.width, h: b.height },
      natural: img.naturalWidth / img.naturalHeight,
      shown: a.width / a.height,
    };
  }, id);
const noBands = (f: Awaited<ReturnType<typeof fit>>) =>
  Math.abs(f.img.w - f.body.w) <= 1 && Math.abs(f.img.h - f.body.h) <= 1 && Math.abs(f.shown - f.natural) < 0.02;

test("imageFollowsAspectRatio", async () => {
  const b: Board = emptyBoard("b1", "images");
  b.cards.push(
    { id: "wide", kind: "image", src: svg(400, 200, "#e8a33d") } as any,
    { id: "tall", kind: "image", src: svg(200, 400, "#3d7be8"), desc: "A caption below the picture" } as any,
  );
  // a stored height that disagrees with the image (older boards, the old corner resize)
  b.place.wide = { x: 60, y: 80, w: 360, h: 360 };
  b.place.tall = { x: 520, y: 80, w: 240, h: 200 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({
    board: { ...migrateBoard(JSON.parse(JSON.stringify({ ...b, version: 6 }))), cam: b.cam },
    light,
    w: 1000,
    h: 800,
  });
  const pg = h.page;
  await until(h, "both images are decoded", () =>
    pg
      .locator(".imgb img")
      .evaluateAll(
        (els) =>
          els.length === 2 &&
          els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0),
      ),
  );
  await idle(h);
  await pg.screenshot({ path: path.join(OUT, "image-29-aspect.png"), clip: { x: 20, y: 40, width: 800, height: 620 } });
  const wide = await fit(h, "wide"),
    tall = await fit(h, "tall");
  check("imageFollowsAspectRatio wide image, no bands", noBands(wide), wide);
  check("imageFollowsAspectRatio tall image with caption, no bands", noBands(tall), tall);
  const desc = await pg.locator('.card[data-id="tall"] .cdesc').evaluate((e) => {
    const r = e.getBoundingClientRect(),
      c = e.closest(".card")!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, card: c.bottom, text: e.textContent };
  });
  check(
    "imageFollowsAspectRatio caption under the picture",
    desc.text === "A caption below the picture" && desc.bottom <= desc.card + 0.5,
    desc,
  );

  // corner resize: the width leads, the height follows the image
  await pg.locator('.card[data-id="wide"]').hover();
  const g = (await pg.locator('.card[data-id="wide"] .grip').boundingBox())!;
  await pg.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await pg.mouse.down();
  for (let i = 1; i <= 10; i++) await pg.mouse.move(g.x + g.width / 2 + i * 8, g.y + g.height / 2 + i * 20);
  // the last move has been applied: the picture is 80 px wider than before
  const during = await until(h, "the card follows the drag", async () => {
    const f = await fit(h, "wide");
    return f.img.w >= wide.img.w + 79 ? f : null;
  });
  await pg.mouse.up();
  await until(h, "the resize is saved", () => h.board().place.wide.w > 360);
  await idle(h);
  const after = await fit(h, "wide");
  await pg.screenshot({
    path: path.join(OUT, "image-29-aspect-resized.png"),
    clip: { x: 20, y: 40, width: 800, height: 620 },
  });
  const p = h.board().place.wide;
  check(
    "imageFollowsAspectRatio resize keeps the ratio",
    noBands(during) && noBands(after) && p.w > 360 && p.h === undefined,
    { during, after, p },
  );
});

/**
 * Deleting an Image card, watched frame by frame (watch.ts), with and without a background, by the Delete key and from its
 * context menu, light and dark, in Warm Ink (imageDeleteWatched) and Ink Wash (imageDeleteInkWashWatched): it goes as its theme's ghost goes (fades, or disperses), and nothing
 * flashes on the way. The ghost (state/ghost.ts) has its picture loaded the moment it is put on the page: a copy of the <img>
 * loaded it again, async, and the first frames showed the ghost without its picture, the image blinking out and back as it
 * started to go (Linda 11-07). Headless Chromium waits for images to decode before it captures a frame, so the frames
 * cannot show that blink (as with #151); the ghost's pictures are checked as they are inserted instead
 */
for (const [scenario, theme] of [
  ["imageDeleteWatched", "warm-ink"],
  ["imageDeleteInkWashWatched", "ink-wash"],
])
  test(scenario, async () => {
    for (const lit of [true, false]) {
      const b: Board = emptyBoard("b1", "images");
      const ids = ["plain", "framed", "plainMenu", "framedMenu"];
      ids.forEach((id, i) => {
        b.cards.push({
          id,
          kind: "image",
          src: svg(320, 200, ["#e8a33d", "#3d7be8", "#5aa96b", "#c4577a"][i]),
          ...(id.startsWith("framed") ? { bg: true } : {}),
        } as never);
        b.place[id] = { x: 60 + (i % 2) * 420, y: 80 + Math.floor(i / 2) * 320, w: 320 };
      });
      b.cards.push({ id: "n1", kind: "note", look: "note", md: "## Stays\nwords" } as never);
      b.place.n1 = { x: 900, y: 80, w: 240 };
      b.cam = { x: 0, y: 0, z: 1 };
      const h = await open({ board: b, light: lit, w: 1300, h: 760, settings: { theme } as never });
      const pg = h.page;
      await until(h, "the images are decoded", () =>
        pg
          .locator(".imgb img")
          .evaluateAll((els) =>
            els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0),
          ),
      );
      await idle(h);
      // each ghost as it is inserted: whether its pictures are there to paint in that frame
      await pg.evaluate(() => {
        const w = window as unknown as { __ghosts: boolean[] };
        w.__ghosts = [];
        new MutationObserver((ms) => {
          for (const m of ms)
            for (const n of m.addedNodes)
              if (n instanceof HTMLElement && n.classList.contains("ghost-out"))
                w.__ghosts.push([...n.querySelectorAll("img")].every((i) => i.complete && i.naturalWidth > 0));
        }).observe(document.body, { childList: true, subtree: true });
      });
      const name = `${scenario} ${lit ? "light" : "dark"}`;
      const gone = async (id: string, how: string) => {
        await until(h, `${id} is deleted`, () => !h.board().cards.some((c) => c.id === id));
        await idle(h);
        const ghosts = await pg.evaluate(() => (window as unknown as { __ghosts: boolean[] }).__ghosts.splice(0));
        check(
          `${name} ${id} ${how}: the ghost has its picture from its first frame`,
          ghosts.length === 1 && ghosts[0],
          ghosts,
        );
      };
      for (const id of ["plain", "framed"]) {
        await pg.locator(`.card[data-id="${id}"] .imgb`).click();
        await idle(h);
        await watch(h, `${name} ${id} key`, { frames: 24 }, () => pg.keyboard.press("Delete"));
        await gone(id, "key");
      }
      for (const id of ["plainMenu", "framedMenu"]) {
        await pg.locator(`.card[data-id="${id}"] .imgb`).click({ button: "right" });
        await idle(h);
        await watch(h, `${name} ${id} menu`, { frames: 24, ignore: [".ctx"] }, () =>
          pg
            .locator(".ctx:not(.closing) button", { hasText: /^Delete/ })
            .first()
            .click(),
        );
        await gone(id, "menu");
      }
      await h.close();
    }
  });
