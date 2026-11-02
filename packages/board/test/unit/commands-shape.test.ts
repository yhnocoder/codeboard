// The board's actions are UI glue; the rules another shell would need too live in core's command layer. Checked by shape: the
// board never imports core's structural edits (every function in core/src/edit/ that takes a board to change, and the variant and
// sub-board ones), only the commands in @codeboard/core/commands that use them
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const CORE = fileURLToPath(new URL("../../../core/src", import.meta.url));
const walk = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : [],
    );
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

/** Functions in these files whose first parameter is the board they change */
const boardOps = (files: string[]) =>
  files.flatMap((f) =>
    [...fs.readFileSync(f, "utf8").matchAll(/export function (\w+)\(\s*\w+: Board\b/g)].map((m) => m[1]),
  );
const EDIT = path.join(CORE, "edit");
const GUARDED = new Set([
  ...boardOps(
    fs
      .readdirSync(EDIT)
      .filter((f) => f !== "check.ts") // danglingRefs only reads
      .map((f) => path.join(EDIT, f)),
  ),
  // the variant and sub-board ones (those files also hold readers)
  "addVariant",
  "switchVariant",
  "setVariantSegs",
  "rebaseUpstream",
  "removeVariant",
  "dropVariants",
  "extractBoard",
]);
/** [file, op, why]: the board's own wiring that applies what the host already decided, not a user's command */
const ALLOW: [string, string, string][] = [
  ["state/changes.ts", "removeCards", "syncGone: another board's Delete Everywhere, already done by the host"],
];

describe("command layer", () => {
  it("finds the structural edits it guards", () => {
    for (const op of [
      "removeCards",
      "rebaseSegment",
      "placeCards",
      "mergeCodeCards",
      "makeCompare",
      "cardIntoSidenote",
    ])
      expect(GUARDED.has(op), op).toBe(true);
  });

  it("the board reaches core's structural edits only through @codeboard/core/commands", () => {
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      const t = fs.readFileSync(f, "utf8");
      for (const m of t.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@codeboard\/core["']/g))
        for (const name of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]))
          if (GUARDED.has(name) && !ALLOW.some(([file, op]) => file === rel(f) && op === name))
            hits.push(`${rel(f)}: ${name}`);
      if (/import\s*\*\s*as\s+\w+\s*from\s*["']@codeboard\/core["']/.test(t))
        hits.push(`${rel(f)}: import * from core`);
    }
    expect(hits).toEqual([]);
  });
});
