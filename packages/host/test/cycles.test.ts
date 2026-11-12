// No circular imports inside a package (tools/test/cycles.mjs: the runtime import graph, type-only imports and lazy import()
// left out). Two modules that need each other share something that belongs in a third one both import
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cycles } from "../../../tools/test/cycles.mjs";

const REPO = path.resolve(__dirname, "../../..");
// every workspace's sources: a package added later is checked without being listed here
const DIRS = ["packages", "extensions"].flatMap((top) =>
  fs
    .readdirSync(path.join(REPO, top))
    .map((name) => `${top}/${name}/src`)
    .filter((d) => fs.existsSync(path.join(REPO, d))),
);

describe("circular imports", () => {
  it.each(DIRS)("%s has none", (d) => {
    expect(cycles(REPO, d)).toEqual([]);
  });
});
