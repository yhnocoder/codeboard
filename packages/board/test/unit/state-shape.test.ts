// Rules on the board's state, checked by shape:
// - segment views and version states (`state.views`, `state.stale`) are written only in state/views.ts
// - the undo engine, snapshots and saving (and what they import from the board) do not import Solid
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

describe("board state", () => {
  it("writes views and version states only in state/views.ts", () => {
    const hits = walk(SRC).filter((f) => rel(f) !== "state/views.ts").flatMap((f) =>
      fs.readFileSync(f, "utf8").split("\n").flatMap((l, i) => (/setState\(\s*["'](views|stale)["']/.test(l) ? [`${rel(f)}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it("keeps the undo engine, snapshots and saving free of Solid", () => {
    const seen = new Set<string>(), bad: string[] = [];
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
    for (const f of ["state/history.ts", "state/snap.ts", "state/save.ts", "state/upkeep.ts"]) visit(path.join(SRC, f), f);
    expect(bad).toEqual([]);
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});
