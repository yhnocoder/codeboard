// 几处手工保持一致的清单：改了一边忘了另一边时在这里失败（材质主题的 SHAPES 键由 look.ts 的类型守着）
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { THEMES, EXPERIMENTAL_THEMES } from "@codeboard/core";
import { FORWARDED_KEYS } from "@codeboard/host/boards";
import { helpRows, keyText } from "../../src/keymap";

// keymap 的表里动作要用白板的状态（DOM、宿主桥）；这里只读表和清单文字，状态模块换成空的
vi.mock("../../src/state/store", () => ({}));
vi.mock("../../src/state/camera", () => ({}));
vi.mock("../../src/state/ui", () => ({}));
vi.mock("../../src/state/mode", () => ({}));
vi.mock("../../src/state/stickers", () => ({}));
vi.mock("../../src/state/measure", () => ({}));

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

  it("every key the host forwards to the board is in the shortcut help", () => {
    const help = helpRows(true).flatMap(([, rows]) => rows.map(([k]) => k)).join(" ");
    const sym: Record<string, string> = { "=": "+", "+": "+", "-": "−" };
    for (const k of FORWARDED_KEYS) {
      const [shift, key] = k.startsWith("shift+") ? ["⇧", k.slice(6)] : ["", k];
      expect(help).toContain(`${shift}⌘${sym[key] ?? key.toUpperCase()}`); // Mac 的修饰键顺序：⌃⌥⇧⌘
    }
  });

  it("shortcut text off the Mac puts Ctrl, Alt, Shift in that order", () => {
    expect(keyText("⇧⌘L", false)).toBe("Ctrl+Shift+L");
    expect(keyText("⌥⌘V", false)).toBe("Ctrl+Alt+V");
    expect(keyText("⌃⇧-", false)).toBe("Ctrl+Alt+Shift+-");
    expect(keyText("⌘ + scroll / pinch", false)).toBe("Ctrl + scroll / pinch");
  });

  it("icon tables are what tools/icons/gen.mjs writes", () => {
    expect(() => execFileSync("node", [path.join(ROOT, "tools/icons/gen.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
