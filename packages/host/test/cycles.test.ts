// No circular imports inside a package (tools/test/cycles.mjs: the runtime import graph, type-only imports and lazy import()
// left out). Two modules that need each other share something that belongs in a third one both import
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

describe("circular imports", () => {
  it.each(DIRS)("%s has none", (d) => {
    expect(cycles(REPO, d)).toEqual([]);
  });
});
