import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@codeboard/core";
import { affectsSettings, readSettings, validSetting, writeSetting } from "../src/settings";
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

describe("VS Code background", () => {
  it("is off by default and read from codeboard.useVSCodeBackground", () => {
    expect(readSettings().vscodeBg).toBe(false);
    conf.set("codeboard.useVSCodeBackground", true);
    expect(readSettings().vscodeBg).toBe(true);
  });

  it("accepts only booleans", async () => {
    await writeSetting("vscodeBg", true);
    await writeSetting("vscodeBg", "yes" as never);
    expect(conf.get("codeboard.useVSCodeBackground")).toBe(true);
  });
});

describe("Math preamble", () => {
  it("is empty by default and read from codeboard.math.preamble", () => {
    expect(readSettings().mathPreamble).toBe("");
    conf.set("codeboard.math.preamble", "\\newcommand{\\R}{\\mathbb{R}}");
    expect(readSettings().mathPreamble).toBe("\\newcommand{\\R}{\\mathbb{R}}");
  });

  it("is reported as a CodeBoard setting change, so open boards get it", () => {
    expect(affectsSettings({ affects: (k) => k === "codeboard.math.preamble" })).toBe(true);
  });

  it("accepts only text", async () => {
    await writeSetting("mathPreamble", "\\def\\x{y}");
    await writeSetting("mathPreamble", 3 as never);
    expect(conf.get("codeboard.math.preamble")).toBe("\\def\\x{y}");
  });

  it("is saved in the project's workspace settings, other settings in the user settings", async () => {
    const scopes = new Map<string, string | undefined>();
    const set = W.settings.set;
    W.settings.set = async (k, v, scope) => { scopes.set(k, scope); await set(k, v); };
    await writeSetting("mathPreamble", "\\def\\x{y}");
    await writeSetting("theme", DEFAULT_SETTINGS.theme);
    W.settings.set = set;
    expect(scopes.get("codeboard.math.preamble")).toBe("workspace");
    expect(scopes.get("codeboard.theme")).toBe("user");
  });
});

describe("Changes made in a row", () => {
  it("read back as the last value the board sent while the writes before it finish", async () => {
    // each write finishes when the test lets it; the change event of the first one reads the settings before the second is written
    const done: (() => void)[] = [];
    const set = W.settings.set;
    W.settings.set = (k, v) => new Promise<void>((r) => done.push(() => { conf.set(k, v); r(); }));
    const a = writeSetting("theme", "graphite"), b = writeSetting("theme", "city");
    done[0]();
    await a;
    expect(conf.get("codeboard.theme")).toBe("graphite");
    expect(readSettings().theme).toBe("city");
    done[1]();
    await b;
    W.settings.set = set;
    expect(readSettings().theme).toBe("city");
    conf.set("codeboard.theme", "poster"); // edited in settings.json afterwards
    expect(readSettings().theme).toBe("poster");
  });
});
