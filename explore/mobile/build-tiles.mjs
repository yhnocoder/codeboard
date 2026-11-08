// The phone app's data for one branch of a board repository: each board drawn by the real board into a tile pyramid, one zip
// per board, and index.json listing them. Only boards whose inputs changed since --prev are drawn again; the others keep the
// zip named in the previous index (the release still has it).
//   node explore/mobile/build-tiles.mjs --boards <repo>/.codeboard --out <dir> [--prev <old index.json>] [--branch b --commit sha]
// Needs: npm ci and the board built (npm run build -w @yhnocoder/markdown && npm run build -w @codeboard/board), Chromium
// (tools/test/chromium.mjs), python3 with Pillow (WebP), and a CJK font named "Noto Sans SC" for the Notes' Chinese.
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { renderTiles } from "./tiles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const boardsDir = path.resolve(arg("boards"));
const out = path.resolve(arg("out"));
const prevFile = arg("prev");
const prev = prevFile && fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, "utf8")) : null;
const work = fs.mkdtempSync("/tmp/cb-tiles-");
const site = path.join(work, "site");
fs.mkdirSync(out, { recursive: true });

// stored, not deflated: WebP is compressed already, and the app reads entries straight out of the file
const ZIP = `
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED) as z:
    for root, _, files in os.walk(src):
        for f in sorted(files):
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, src))
`;

// 1. the host's messages for every board (record.ts: the real host over the board folder)
await build({
  entryPoints: [path.join(HERE, "record.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(work, "record.mjs"),
  absWorkingDir: REPO,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  plugins: [
    {
      name: "ext",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (a) =>
          a.path.startsWith("@codeboard/") || a.path.startsWith("node:") ? undefined : { external: true },
        );
      },
    },
  ],
});
// the bundle imports node_modules packages: run it from inside the repo so they resolve
const rec = path.join(REPO, "explore/mobile/.record.mjs");
fs.copyFileSync(path.join(work, "record.mjs"), rec);
try {
  execFileSync("node", [rec, boardsDir, path.join(site, "data")], { stdio: "inherit", cwd: path.join(REPO, "explore/mobile") });
} finally {
  fs.rmSync(rec, { force: true });
}
if (fs.existsSync(path.join(site, "data/assets"))) fs.renameSync(path.join(site, "data/assets"), path.join(site, "assets"));
fs.cpSync(path.join(REPO, "packages/board/dist"), path.join(site, "board"), { recursive: true });
fs.copyFileSync(path.join(HERE, "site/render.html"), path.join(site, "render.html"));
const metas = JSON.parse(fs.readFileSync(path.join(site, "data/index.json"), "utf8"));

// 2. what each board's picture depends on: its file, its sub-boards' files (their previews), the images it names, the shared
// cards, and the CodeBoard build that draws it
const codeboard = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim();
// board files by id, wherever they sit under the folder (group folders)
const files = new Map();
for (const f of fs.readdirSync(boardsDir, { recursive: true })) {
  if (!f.endsWith(".json") || f.startsWith("cards/") || f.startsWith("assets/")) continue;
  try {
    const id = JSON.parse(fs.readFileSync(path.join(boardsDir, f), "utf8")).id;
    if (typeof id === "string") files.set(id, path.join(boardsDir, f));
  } catch {}
}
const fileOf = (id) => files.get(id);
const shared = fs.existsSync(path.join(boardsDir, "cards"))
  ? fs.readdirSync(path.join(boardsDir, "cards")).sort().map((f) => fs.readFileSync(path.join(boardsDir, "cards", f)))
  : [];
const hashOf = (m) => {
  const h = crypto.createHash("sha256").update(codeboard);
  for (const id of [m.id, ...(m.subs ?? [])]) {
    const f = fileOf(id);
    if (!f) continue;
    const text = fs.readFileSync(f, "utf8");
    h.update(text);
    for (const a of new Set(text.match(/assets\/[\w.-]+/g) ?? [])) {
      const p = path.join(boardsDir, a);
      if (fs.existsSync(p)) h.update(fs.readFileSync(p));
    }
  }
  for (const s of shared) h.update(s);
  return h.digest("hex").slice(0, 16);
};
const boards = metas.map((m) => ({ id: m.id, name: m.name, cards: m.cards, subs: m.subs, hash: hashOf(m) }));
const kept = new Map((prev?.boards ?? []).map((b) => [b.id, b]));
const todo = boards.filter((b) => kept.get(b.id)?.hash !== b.hash);
console.log(`${boards.length} boards, ${todo.length} to draw`);

// 3. draw the changed ones (a static server over the site folder), then WebP and one zip per board
if (todo.length) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
  const server = http.createServer((req, res) => {
    const f = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!f.startsWith(site) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[path.extname(f).toLowerCase()] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const tiles = path.join(work, "tiles");
  try {
    await renderTiles({ base: `http://127.0.0.1:${server.address().port}`, siteDir: site, out: tiles, ids: todo.map((b) => b.id) });
  } finally {
    server.close();
  }
  execFileSync("python3", ["-I", path.join(HERE, "towebp.py"), tiles], { stdio: "inherit" });
  for (const b of todo) {
    b.asset = `${b.id}-${b.hash}.zip`;
    execFileSync("python3", ["-I", "-c", ZIP, path.join(tiles, b.id), path.join(out, b.asset)], { stdio: "inherit" });
    b.size = fs.statSync(path.join(out, b.asset)).size;
  }
}
for (const b of boards) if (!b.asset) Object.assign(b, { asset: kept.get(b.id).asset, size: kept.get(b.id).size });
const index = { branch: arg("branch", ""), commit: arg("commit", ""), codeboard, built: new Date().toISOString(), boards };
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 1));
fs.rmSync(work, { recursive: true, force: true });
console.log(`index.json: ${boards.length} boards; new zips: ${todo.map((b) => b.asset).join(" ") || "none"}`);

