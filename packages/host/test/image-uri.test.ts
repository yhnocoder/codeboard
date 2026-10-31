// An image file dropped on the board as a URI only (VS Code's Explorer, an OS drop without File objects): the host reads it
// through Workspace and answers a data: URL the board stores like a pasted image.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { BoardToHost } from "@codeboard/core";
import { makeHandler } from "../src/handlers";
import { MAX_NOTE_IMAGE, readImageUri } from "../src/images";
import type { BoardHost, BoardPanel } from "../src/boards";
import { useWorkspace } from "../src/ws";
import { png } from "./images";
import { nodeWorkspace } from "./node-workspace";

const tmp = fs.mkdtempSync("/tmp/codeboard-uri-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ws = path.join(tmp, "ws"),
  outside = path.join(tmp, "Downloads");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
const PNG = png(20, 10, (x) => [x * 10, 80, 160, 255]);
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>`;
const file = (dir: string, name: string, body: string | Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return pathToFileURL(p).href;
};
const dataOf = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

describe("reading a dropped image by URI", () => {
  useWorkspace(nodeWorkspace(ws));

  it("reads a PNG in the workspace and one outside it (a Finder drop) as data: URLs of their type", async () => {
    for (const dir of [ws, outside]) {
      const url = await readImageUri(file(dir, "shot.png", PNG));
      expect(url.startsWith("data:image/png;base64,")).toBe(true);
      expect(dataOf(url).equals(PNG)).toBe(true);
    }
  });

  it("tells an SVG by its content, whatever the name says", async () => {
    const url = await readImageUri(file(ws, "icon.png", SVG));
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(dataOf(url).toString()).toBe(SVG);
  });

  it("decodes the file name in its messages", async () => {
    await expect(readImageUri(file(outside, "my notes.png", "def f(): pass\n"))).rejects.toThrow(
      "my notes.png is not a PNG, JPEG, WebP, GIF or SVG image",
    );
    await expect(readImageUri(pathToFileURL(path.join(outside, "gone image.png")).href)).rejects.toThrow(
      "Could not read gone image.png",
    );
  });

  it("refuses a file over the image size limit without reading it", async () => {
    const big = path.join(outside, "huge.png");
    fs.writeFileSync(big, PNG);
    fs.truncateSync(big, MAX_NOTE_IMAGE + 1);
    await expect(readImageUri(pathToFileURL(big).href)).rejects.toThrow(
      `huge.png is larger than ${MAX_NOTE_IMAGE >> 20} MB`,
    );
  });

  it("reads through Workspace, so a remote workspace's vscode-remote: URI works", async () => {
    const w = nodeWorkspace(ws),
      asked: [string, number][] = [];
    w.files.readBytes = async (uri, max) => {
      asked.push([uri, max]);
      return PNG;
    };
    useWorkspace(w);
    try {
      const uri = "vscode-remote://ssh-remote%2Bbox/home/me/proj/docs/arch%20v2.png";
      expect(dataOf(await readImageUri(uri)).equals(PNG)).toBe(true);
      expect(asked).toEqual([[uri, MAX_NOTE_IMAGE]]);
    } finally {
      useWorkspace(nodeWorkspace(ws));
    }
  });

  it("answers the board's readImageUri message", async () => {
    const h = makeHandler({} as unknown as BoardHost);
    const url = await (h(
      {} as BoardPanel,
      { type: "readImageUri", req: 1, uri: file(ws, "a.png", PNG) } as BoardToHost,
    ) as Promise<string>);
    expect(dataOf(url).equals(PNG)).toBe(true);
  });
});
