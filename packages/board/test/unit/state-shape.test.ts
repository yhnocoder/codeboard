// Rules on the board's state and gestures, checked by shape:
// - the board is written only in state/changes.ts, segment views and version states (`state.views`, `state.stale`) only in
//   state/views.ts: those two are the only ones to import the store's setState, by name or through a namespace import
// - the undo engine, snapshots and saving (and what they import from the board) do not import Solid
// - drags go through gesture.ts: no other file listens on the window or the document for pointer moves (but the listed trackers,
//   which never listen for a release there), and an undo step for a gesture (beginGesture) is always held with holdGesture, so a
//   board switch drops it
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const walk = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : [],
    );
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
/** file:line of the lines matching `re`, in the board's sources except `skip` */
const lines = (re: RegExp, skip: string[] = []) =>
  walk(SRC)
    .filter((f) => !skip.includes(rel(f)))
    .flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .flatMap((l, i) => (re.test(l) ? [`${rel(f)}:${i + 1}`] : [])),
    );

describe("board state", () => {
  it("writes views and version states only in state/views.ts", () => {
    expect(lines(/setState\(\s*["'](views|stale)["']/, ["state/views.ts"])).toEqual([]);
  });

  it("writes the board only in state/changes.ts", () => {
    expect(lines(/setState\(\s*["']board["']/, ["state/changes.ts"])).toEqual([]);
  });

  it("lets only state/changes.ts and state/views.ts import the store's setState", () => {
    const STORE = String.raw`from\s*["'](?:\.\.?\/)+(?:state\/)?store["']`;
    const named = new RegExp(String.raw`import\s*\{[^}]*\bsetState\b[^}]*\}\s*${STORE}`);
    const spaces = new RegExp(String.raw`import\s*(?:type\s+)?(?:\w+\s*,\s*)?\*\s*as\s+(\w+)\s*${STORE}`, "g");
    const importers = walk(SRC)
      .filter((f) => {
        const t = fs.readFileSync(f, "utf8");
        // import * as S from "./store", then S.setState
        const viaSpace = [...t.matchAll(spaces)].some((m) =>
          new RegExp(String.raw`\b${m[1]}\s*\.\s*setState\b`).test(t),
        );
        return named.test(t) || viaSpace;
      })
      .map(rel)
      .sort();
    expect(importers).toEqual(["state/changes.ts", "state/views.ts"]);
  });

  it("keeps the undo engine, snapshots and saving free of Solid", () => {
    const seen = new Set<string>(),
      bad: string[] = [];
    const visit = (f: string, from: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) {
        const spec = m[1];
        if (spec.startsWith("solid-js")) bad.push(`${rel(f)} (from ${from})`);
        if (!spec.startsWith(".")) continue;
        const base = path.resolve(path.dirname(f), spec);
        const next = [".ts", ".tsx", "/index.ts"].map((x) => base + x).find((x) => fs.existsSync(x));
        if (next) visit(next, rel(f));
      }
    };
    for (const f of ["state/history.ts", "state/snap.ts", "state/save.ts", "state/upkeep.ts"])
      visit(path.join(SRC, f), f);
    expect(bad).toEqual([]);
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});

describe("board gestures", () => {
  // a drag listens for the moves on the window (or the document): only track() in gesture.ts does that. Besides it, these follow
  // the pointer with no button held, and none of them listens for a release there
  const TRACKERS = new Set([
    "state/hover.ts", // which card or link the pointer is over
    "state/measure.ts", // the last pointer position
    "state/blocks.ts", // the Note block under the pointer
    "stickers/Picker.tsx", // the sticker that follows the pointer until a click places it
  ]);
  const SHIELD = "ui/shield.ts"; // the pan shield: page-long passive listeners that take it away on any move or release, no drag
  const listens = (t: string, kinds: string) =>
    new RegExp(
      String.raw`\b(?:window|document|globalThis)\s*\.\s*(?:addEventListener\(\s*["'](?:pointer|mouse|touch)(?:${kinds})["']|on(?:pointer|mouse|touch)(?:${kinds})\s*=)`,
    ).test(t);
  it("are tracked only in gesture.ts", () => {
    const sources = walk(SRC).filter((f) => !["gesture.ts", SHIELD].includes(rel(f)));
    const moves = sources.filter((f) => listens(fs.readFileSync(f, "utf8"), "move")).map(rel);
    // a tracker that stopped listening comes off the list
    expect(moves.sort()).toEqual([...TRACKERS].sort());
    expect(moves.filter((f) => listens(fs.readFileSync(path.join(SRC, f), "utf8"), "up|cancel|end"))).toEqual([]);
  });

  it("hold their undo step with holdGesture, so a board switch drops it", () => {
    const loose = walk(SRC)
      .filter((f) => !["gesture.ts", "state/history.ts", "state/changes.ts"].includes(rel(f)))
      .filter((f) => {
        const t = fs.readFileSync(f, "utf8");
        return /\bbeginGesture\(/.test(t) && !/\bholdGesture\(/.test(t);
      })
      .map(rel);
    expect(loose).toEqual([]);
  });
});
