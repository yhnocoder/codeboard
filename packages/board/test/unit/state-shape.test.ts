// Rules on the board's state and gestures, checked by shape:
// - the board is written only in state/changes.ts, segment views and version states (`state.views`, `state.stale`) only in
//   state/views.ts: those two are the only ones to import the store's setState
// - the undo engine, snapshots and saving (and what they import from the board) do not import Solid
// - drags go through gesture.ts: no other file listens on the window for both a pointer move and its release, and an undo step
//   for a gesture (beginGesture) is always held with holdGesture, so a board switch drops it
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
    const importers = walk(SRC)
      .filter((f) =>
        /import\s*\{[^}]*\bsetState\b[^}]*\}\s*from\s*["'][./]*(state\/)?store["']/.test(fs.readFileSync(f, "utf8")),
      )
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
  // a drag listens on the window for the moves and for the release: only track() in gesture.ts does both
  const NOT_DRAGS = new Set([
    "gesture.ts",
    "ui/shield.ts", // the pan shield: page-long passive listeners that take it away on any move, no drag
  ]);
  it("are tracked only in gesture.ts", () => {
    const both = walk(SRC)
      .filter((f) => !NOT_DRAGS.has(rel(f)))
      .filter((f) => {
        const t = fs.readFileSync(f, "utf8");
        return (
          /window\.addEventListener\(\s*["']pointermove["']/.test(t) &&
          /window\.addEventListener\(\s*["'](pointerup|pointercancel)["']/.test(t)
        );
      })
      .map(rel);
    expect(both).toEqual([]);
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
