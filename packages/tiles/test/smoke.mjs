// The CLI end to end on a small synthetic board folder (a board with Notes, a Section, an image and a sub-board card, and the
// sub-board): its zips and index.json come out in the phone app's format, a second run with --prev draws nothing, and an edit
// to the sub-board draws it and the board that shows it again, nothing else. CI's tiles job runs it after the builds:
//   npm run build -w @yhnocoder/markdown && npm run build -w @codeboard/board && npm run build -w @codeboard/tiles
//   node packages/tiles/test/smoke.mjs
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync } from "fflate";

const CLI = path.resolve(import.meta.dirname, "../dist/cli.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tiles-smoke-"));
const dir = path.join(tmp, ".codeboard");
fs.mkdirSync(path.join(dir, "assets"), { recursive: true });

const board = (id, name, cards, place, sections = []) => ({
  version: 15,
  id,
  name,
  cam: { x: 0, y: 0, z: 1 },
  cards,
  place,
  links: [],
  sections,
  sidenotes: [],
  stickers: [],
  born: {},
  seq: 0,
});
const note = (id, md) => ({ id, kind: "note", md, look: "note" });
fs.writeFileSync(
  path.join(dir, "assets/dot.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#c84"/></svg>',
);
const write = (b) => fs.writeFileSync(path.join(dir, `${b.id}.json`), JSON.stringify(b));
const sub = (title) =>
  board("bSub", "Scheduler", [note("s1", `# ${title}\n\nTakes waiting sequences while the KV cache has room.`)], {
    s1: { x: 0, y: 0, w: 420 },
  });
write(
  board(
    "bMain",
    "Engine",
    [
      note("n1", "# Engine\n\nThe engine **steps** the scheduler, then the model runner."),
      note("n2", "## Pictures\n\n![dot](assets/dot.svg)"),
      { id: "f1", kind: "board", board: "bSub" },
    ],
    {
      n1: { x: 60, y: 100, w: 480, section: "s" },
      n2: { x: 600, y: 100, w: 360, section: "s" },
      f1: { x: 60, y: 900, w: 520, h: 360 },
    },
    [{ id: "s", title: "Loop", x: 20, y: 40, w: 1000, h: 700 }],
  ),
);
write(sub("Scheduler"));

const run = (out, ...extra) => {
  const log = execFileSync(
    "node",
    [CLI, "--boards", dir, "--out", out, "--branch", "smoke", "--commit", "c0", ...extra],
    {
      encoding: "utf8",
    },
  );
  process.stdout.write(log);
  return JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
};
const fail = (msg) => {
  console.error(`tiles smoke: ${msg}`);
  process.exit(1);
};
const check = (ok, msg) => ok || fail(msg);

const out1 = path.join(tmp, "out1");
const i1 = run(out1, "--jobs", "2");
check(i1.branch === "smoke" && i1.commit === "c0" && typeof i1.built === "string", "index header");
check(
  i1.boards
    .map((b) => b.id)
    .sort()
    .join() === "bMain,bSub",
  `boards ${i1.boards.map((b) => b.id)}`,
);
for (const b of i1.boards) {
  check(b.asset === `${b.id}-${b.hash}.zip` && /^[0-9a-f]{16}$/.test(b.hash), `asset name ${b.asset}`);
  const zip = fs.readFileSync(path.join(out1, b.asset));
  check(zip.length === b.size, `${b.asset} size`);
  const files = unzipSync(zip);
  const m = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  const tiles = Object.keys(files).filter((f) => /^\d+\/\d+_\d+\.webp$/.test(f));
  check(
    m.id === b.id && m.tile === 512 && m.dpr === 2 && m.levels.length > 0 && /^#[0-9a-f]{6}$/.test(m.bg),
    `${b.id} manifest`,
  );
  check(tiles.length > 0, `${b.id} has no tiles`);
  for (const t of tiles) {
    const [lv, c, r] = t.split(/[/_.]/).map(Number);
    const L = m.levels[lv];
    check(L && c < L.cols && r < L.rows, `${b.id} tile ${t} outside its level`);
    check(new TextDecoder().decode(files[t].slice(8, 12)) === "WEBP", `${t} is not WebP`);
  }
  if (b.id === "bMain")
    check(
      m.hits.length === 1 && m.hits[0].board === "bSub" && m.hits[0].rect.y === 900,
      `hits ${JSON.stringify(m.hits)}`,
    );
}

const out2 = path.join(tmp, "out2");
const i2 = run(out2, "--prev", path.join(out1, "index.json"));
check(fs.readdirSync(out2).join() === "index.json", `an unchanged run drew ${fs.readdirSync(out2)}`);
check(JSON.stringify(i2.boards) === JSON.stringify(i1.boards), "an unchanged run's index differs");

// the sub-board card on bMain shows its cards' titles
write(sub("Scheduler and preemption"));
const out3 = path.join(tmp, "out3");
run(out3, "--prev", path.join(out1, "index.json"));
const drawn = fs
  .readdirSync(out3)
  .filter((f) => f.endsWith(".zip"))
  .map((f) => f.split("-")[0])
  .sort();
check(drawn.join() === "bMain,bSub", `an edit to the sub-board drew ${drawn}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("tiles smoke: ok");
