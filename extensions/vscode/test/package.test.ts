import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FORWARDED_KEYS } from "@codeboard/host";
import { contributes } from "../src/contributes";

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));

describe("package.json", () => {
  it("commands and settings are the ones generated from the host's command table and core's settings (npm run build writes them)", () => {
    const gen = contributes();
    expect(pkg.contributes.commands).toEqual(gen.commands);
    expect(pkg.contributes.configuration).toEqual(gen.configuration);
  });

  it("every command in menus and keybindings is declared", () => {
    const declared = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
    const used = [
      ...Object.values(pkg.contributes.menus as Record<string, { command?: string }[]>).flat().map((m) => m.command),
      ...pkg.contributes.keybindings.map((k: { command: string }) => k.command),
    ].filter((c): c is string => !!c);
    expect(used.filter((c) => !declared.has(c))).toEqual([]);
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
