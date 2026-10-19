// package.json lists that must match the code: the theme setting's choices and the keys bound to codeboard.boardKey
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { THEMES, EXPERIMENTAL_THEMES } from "@codeboard/core";
import { FORWARDED_KEYS } from "@codeboard/host/boards";

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));

describe("package.json", () => {
  it("codeboard.theme enum = core THEMES", () => {
    expect(pkg.contributes.configuration.properties["codeboard.theme"].enum).toEqual(THEMES.map(([id]) => id));
    // 实验性的主题在 VS Code 设置的下拉里也标 Experimental
    expect(pkg.contributes.configuration.properties["codeboard.theme"].enumDescriptions).toEqual(THEMES.map(([id, name]) => (EXPERIMENTAL_THEMES.includes(id) ? `${name} (Experimental)` : name)));
  });

  it("the keys bound to codeboard.boardKey = the keys the host forwards", () => {
    const keys = pkg.contributes.keybindings.filter((k: { command: string }) => k.command === "codeboard.boardKey");
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.mac.replace(/^cmd\+/, "")).toBe(k.key.replace(/^ctrl\+/, ""));
    const bound = keys.map((k: { key: string }) => k.key.replace(/^ctrl\+/, ""));
    // "+" 是 "=" 那个键按着 Shift 时的 e.key，没有单独的绑定
    expect([...FORWARDED_KEYS].filter((k) => k !== "+").sort()).toEqual([...bound].sort());
  });
});
