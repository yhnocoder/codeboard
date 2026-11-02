// @vitest-environment happy-dom
// Gray inline completions follow the AI provider setting: the host's settings message turns them on or off with the board open
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, emptyBoard, type HostInfo, type Settings } from "@codeboard/core";
import { onHost } from "../../src/hostio";
import { ghostHost } from "../../src/cm/load";

const HOST: HostInfo = { assetBase: "", target: true, settings: DEFAULT_SETTINGS };
const settings = (aiProvider: Settings["aiProvider"]) => ({ ...DEFAULT_SETTINGS, aiProvider });

describe("inline completions", () => {
  it("turn on when the provider changes from Off to Auto while the board is open, and off again", () => {
    onHost({
      type: "init",
      board: emptyBoard("a", "a"),
      boards: [{ id: "a", name: "a", cards: 0 }],
      views: {},
      stale: {},
      host: { ...HOST, settings: settings("off") },
    });
    expect(ghostHost()).toBeUndefined();
    onHost({ type: "host", host: { settings: settings("auto") } });
    expect(ghostHost()).toBeDefined();
    onHost({ type: "host", host: { settings: settings("off") } });
    expect(ghostHost()).toBeUndefined();
  });
});
