// @vitest-environment jsdom
// The board tells the host when its frame gets or loses the keyboard
import { beforeAll, describe, expect, it } from "vitest";
import { reportFocus } from "../../src/focus";
import { sent } from "./host";

const last = () => sent[sent.length - 1];

beforeAll(() => reportFocus());

describe("board focus messages", () => {
  it("reports getting the keyboard and losing it", () => {
    window.dispatchEvent(new Event("focus"));
    expect(last()).toEqual({ type: "focus", has: true });
    window.dispatchEvent(new Event("blur"));
    expect(last()).toEqual({ type: "focus", has: false });
  });
});
