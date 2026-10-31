import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { openStickerDir, readPacks } from "../src/stickers";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";

describe("sticker folder", () => {
  it("relative to the workspace root: Open Folder opens <workspace>/<folder> and its packs are loaded", async () => {
    const rel = "e2e-stickers-rel";
    const dir = path.join(WS, rel);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "mypack.json"),
      JSON.stringify({
        prefix: "mypack",
        info: { name: "MyPack" },
        icons: { star: { body: "<path d='M0 0h16v16z'/>" } },
      }),
    );
    const W = nodeWorkspace(),
      opened: string[] = [];
    useWorkspace({
      ...W,
      settings: { ...W.settings, get: <T>(k: string) => (k === "codeboard.stickerFolder" ? rel : undefined) as T },
      ui: {
        ...W.ui,
        openFolder: async (d: string) => {
          opened.push(d);
        },
      },
    });
    try {
      await openStickerDir();
      expect(opened).toEqual([dir]);
      expect((await readPacks()).map((p) => p.name)).toContain("MyPack");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
