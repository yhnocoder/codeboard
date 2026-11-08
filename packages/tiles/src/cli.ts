// The phone app's data for one branch of a board repository: each board drawn into a tile pyramid, one zip per board, and
// index.json listing them. Only boards whose picture changed since --prev are drawn again; the others keep the zip the
// previous index names (the release still has it).
//   codeboard-tiles --boards <repo>/.codeboard --out <dir> [--prev <old index.json>] [--branch b --commit sha] [--jobs n]
// Needs the board built (npm run build -w @yhnocoder/markdown && npm run build -w @codeboard/board), Chromium
// (tools/test/chromium.mjs), and the fonts the boards name (a CJK font such as Noto Sans SC for Chinese)
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pictureHash, rendererHash } from "./hash";
import { makeIndex, plan, planned, zipName, type Drawn, type Index } from "./plan";
import { recordBoards } from "./record";
import { renderBoards } from "./render";
import { storedZip } from "./zip";

/** The tile renderer's own hash (its page and code), set by build.mjs */
declare const RENDERER_HASH: string;

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_DIST = path.resolve(PKG, "../board/dist");

const { values: a } = parseArgs({
  options: {
    boards: { type: "string" },
    out: { type: "string" },
    prev: { type: "string" },
    branch: { type: "string", default: "" },
    commit: { type: "string", default: "" },
    jobs: { type: "string", default: String(os.availableParallelism()) },
  },
});
if (!a.boards || !a.out) {
  console.error(
    "usage: codeboard-tiles --boards <dir> --out <dir> [--prev index.json] [--branch b] [--commit sha] [--jobs n]",
  );
  process.exit(2);
}
if (!fs.existsSync(path.join(BOARD_DIST, "boot.js"))) {
  console.error(
    `no built board in ${BOARD_DIST}: npm run build -w @yhnocoder/markdown && npm run build -w @codeboard/board`,
  );
  process.exit(1);
}
const boardsDir = path.resolve(a.boards);
const out = path.resolve(a.out);
const prev: Index | null = a.prev && fs.existsSync(a.prev) ? JSON.parse(fs.readFileSync(a.prev, "utf8")) : null;
const workers = Math.max(1, Number(a.jobs) || 1);
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const rec = await recordBoards(boardsDir, BOARD_DIST);
console.log(`recorded ${rec.metas.length} boards in ${secs(Date.now() - t0)}`);
const renderer = rendererHash(BOARD_DIST, RENDERER_HASH);
const assets = path.join(boardsDir, "assets");
const asset = (name: string) => {
  const p = path.join(assets, name);
  return fs.existsSync(p) ? fs.readFileSync(p) : undefined;
};
const boards = rec.metas.map((m) => planned(m, pictureHash(renderer, rec.messages.get(m.id) ?? [], asset)));
const { todo, kept } = plan(boards, prev);
console.log(`${boards.length} boards, ${todo.length} to draw on ${Math.min(workers, todo.length)} pages`);

const zips = new Map<string, Drawn>(kept);
if (todo.length) {
  const t1 = Date.now();
  await renderBoards({
    jobs: todo.map((b) => ({ id: b.id, msgs: rec.messages.get(b.id) ?? [] })),
    boardDist: BOARD_DIST,
    assets,
    page: path.join(PKG, "page/render.html"),
    workers,
    log: (s) => console.log(s),
    done: async (t) => {
      const b = todo.find((x) => x.id === t.id)!;
      const name = zipName(b.id, b.hash);
      const zip = storedZip(t.files);
      fs.writeFileSync(path.join(out, name), zip);
      zips.set(b.id, { asset: name, size: zip.length });
      console.log(`${b.id} ${b.name}: ${t.tiles} tiles from ${t.shots} shots, ${secs(t.ms)}`);
    },
  });
  console.log(`drew ${todo.length} boards in ${secs(Date.now() - t1)}`);
}

let codeboard = "";
try {
  codeboard = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PKG, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  // not run from a git checkout: the index names no CodeBoard commit
}
const index = makeIndex(boards, zips, { branch: a.branch, commit: a.commit, codeboard, built: new Date() });
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 1));
console.log(
  `index.json: ${boards.length} boards; new zips: ${todo.map((b) => zipName(b.id, b.hash)).join(" ") || "none"}; ${secs(Date.now() - t0)}`,
);
process.exit(0);
