// Settings read from and written to codeboard.*: object settings come back complete (levels left out of settings.json take the
// default), and values the board sends are checked before they are written
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@codeboard/core";
import { readSettings, validSetting, writeSetting } from "../src/settings";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";

const conf = new Map<string, unknown>();
const W = nodeWorkspace();
W.settings = { ...W.settings, get: <T>(k: string) => conf.get(k) as T, set: async (k, v) => { conf.set(k, v); } };

beforeEach(() => { conf.clear(); useWorkspace(W); });

describe("Note font sizes", () => {
  it("default to the theme's sizes", () => {
    expect(readSettings().noteFontSize).toEqual(DEFAULT_SETTINGS.noteFontSize);
    expect(Object.values(readSettings().noteFontSize).every((v) => v === null)).toBe(true);
  });

  it("fill levels left out of settings.json with the theme's size", () => {
    conf.set("codeboard.notes.fontSize", { body: 15, h1: 28 });
    expect(readSettings().noteFontSize).toEqual({ body: 15, h1: 28, h2: null, h3: null, h4: null, h5: null, h6: null });
  });

  it("accept sizes in range and null, and refuse the rest", () => {
    expect(validSetting("noteFontSize", { ...DEFAULT_SETTINGS.noteFontSize, body: 16, h1: 32 })).toBe(true);
    expect(validSetting("noteFontSize", { body: 9 })).toBe(false);
    expect(validSetting("noteFontSize", { h2: 41 })).toBe(false);
    expect(validSetting("noteFontSize", { body: "16" })).toBe(false);
    expect(validSetting("noteFontSize", { h7: 12 })).toBe(false);
    expect(validSetting("noteFontSize", 16)).toBe(false);
  });

  it("are written as codeboard.notes.fontSize", async () => {
    const v = { ...DEFAULT_SETTINGS.noteFontSize, body: 16 };
    await writeSetting("noteFontSize", v);
    await writeSetting("noteFontSize", { body: 200 });
    expect(conf.get("codeboard.notes.fontSize")).toEqual(v);
  });
});
