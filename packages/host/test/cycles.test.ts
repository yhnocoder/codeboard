// Circular imports inside a package (tools/test/cycles.mjs: the runtime import graph, type-only imports and lazy import() left out).
// The cycles there were when this test came are listed below; they may only shrink: a new cycle, or one that grew, fails, and so
// does an entry here that no longer exists (delete it, so the list keeps up)
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cycles } from "../../../tools/test/cycles.mjs";

const REPO = path.resolve(__dirname, "../../..");
const DIRS = [
  "packages/analysis/src",
  "packages/core/src",
  "packages/markdown/src",
  "packages/board/src",
  "packages/host/src",
  "extensions/vscode/src",
];
const KNOWN: string[][] = [
  ["packages/analysis/src/index.ts", "packages/analysis/src/peek.ts", "packages/analysis/src/select.ts"],
  ["packages/markdown/src/math.ts", "packages/markdown/src/render.ts"],
  ["packages/board/src/actions/chains.ts", "packages/board/src/actions/flow.ts"],
  ["packages/board/src/actions/common.ts", "packages/board/src/actions/subboards.ts", "packages/board/src/md/refs.ts"],
  [
    "packages/board/src/actions/create.ts",
    "packages/board/src/actions/edit.ts",
    "packages/board/src/actions/imageai.ts",
    "packages/board/src/actions/notes.ts",
    "packages/board/src/actions/shared.ts",
  ],
  ["packages/board/src/canvas/Labels.tsx", "packages/board/src/canvas/Links.tsx"],
  [
    "packages/board/src/cards/BoardBody.tsx",
    "packages/board/src/cards/Card.tsx",
    "packages/board/src/cards/CompareBody.tsx",
  ],
  ["packages/board/src/state/cull.ts", "packages/board/src/state/lodcards.ts"],
];

describe("circular imports", () => {
  const found = DIRS.flatMap((d) => cycles(REPO, d));
  it("adds no cycle and grows none", () => {
    const extra = found.filter((c) => !KNOWN.some((k) => c.every((f) => k.includes(f))));
    expect(extra).toEqual([]);
  });
  it("lists only cycles that are still there", () => {
    const gone = KNOWN.filter((k) => !found.some((c) => k.every((f) => c.includes(f))));
    expect(gone).toEqual([]);
  });
});
