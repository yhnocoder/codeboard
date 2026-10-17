// 几处手工保持一致的清单：改了一边忘了另一边时在这里失败（材质主题的 SHAPES 键由 look.ts 的类型守着）
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { THEMES, EXPERIMENTAL_THEMES } from "@codeboard/core";
import { FORWARDED_KEYS } from "../../../../extensions/vscode/src/boards";

const ROOT = path.resolve(__dirname, "../../../..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "extensions/vscode/package.json"), "utf8"));

describe("hand-synced lists", () => {
  it("codeboard.theme enum = core THEMES", () => {
    expect(pkg.contributes.configuration.properties["codeboard.theme"].enum).toEqual(THEMES.map(([id]) => id));
    // 实验性的主题在 VS Code 设置的下拉里也标 Experimental
    expect(pkg.contributes.configuration.properties["codeboard.theme"].enumDescriptions).toEqual(THEMES.map(([id, name]) => (EXPERIMENTAL_THEMES.includes(id) ? `${name} (Experimental)` : name)));
  });

  it("forwarded keys = the keys package.json binds to codeboard.boardKey", () => {
    const keys = pkg.contributes.keybindings.filter((k: any) => k.command === "codeboard.boardKey");
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.mac.replace(/^cmd\+/, "")).toBe(k.key.replace(/^ctrl\+/, ""));
    const bound = keys.map((k: any) => k.key.replace(/^ctrl\+/, ""));
    // "+" 是 "=" 那个键按着 Shift 时的 e.key，没有单独的绑定
    expect([...FORWARDED_KEYS].filter((k) => k !== "+").sort()).toEqual([...bound].sort());
  });

  it("icon tables are what tools/icons/gen.mjs writes", () => {
    expect(() => execFileSync("node", [path.join(ROOT, "tools/icons/gen.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
