import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildHash } from "../../../../tools/test/buildhash.mjs";

// npm run check rebuilds the board when anything it is built from changed: fonts and icons in public/ too, not its tests
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-buildhash-"));
const put = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); };
put("packages/board/src/index.tsx", "x");
put("packages/board/public/fonts/a.woff2", "font");
put("packages/board/test/unit/a.test.ts", "test");
execFileSync("git", ["init", "-q"], { cwd: repo });
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("buildHash", () => {
  it("changes with a file in public/", () => {
    const before = buildHash(repo);
    put("packages/board/public/fonts/a.woff2", "another font");
    expect(buildHash(repo)).not.toBe(before);
  });
  it("does not change with the board's tests", () => {
    const before = buildHash(repo);
    put("packages/board/test/unit/a.test.ts", "another test");
    expect(buildHash(repo)).toBe(before);
  });
});
