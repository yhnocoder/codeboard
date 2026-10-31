// @vitest-environment happy-dom
// Right after a press on the board, a blur that leaves the keyboard on the webview's host page (VS Code's first focusing step, its second
// one skipped) gives the keyboard back to the board; a blur to elsewhere in VS Code, or one long after the press, is left alone
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { reportFocus } from "../../src/focus";
import { CLICK_KEEPS_KEYS } from "../../src/state/timing";

const body = {} as HTMLElement;
const host = { hasFocus: () => true, activeElement: body as Element | null, body, addEventListener: () => {} };
let focused = 0;

beforeAll(() => {
  Object.defineProperty(window, "frameElement", { value: { ownerDocument: host }, configurable: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(window, "focus").mockImplementation(() => {
    focused++;
  });
  reportFocus();
});
afterEach(() => {
  vi.useRealTimers();
  host.hasFocus = () => true;
  host.activeElement = body;
});

const pressThenBlur = async (after: number) => {
  vi.useFakeTimers();
  window.dispatchEvent(new Event("pointerdown"));
  vi.advanceTimersByTime(after);
  focused = 0;
  window.dispatchEvent(new Event("blur"));
  await vi.runAllTimersAsync();
  return focused;
};

describe("the keyboard after a press on the board", () => {
  it("comes back when the host page took it to its <body> right after the press", async () => {
    expect(await pressThenBlur(50)).toBe(1);
  });
  it("stays where VS Code moved it (the host page lost it too)", async () => {
    host.hasFocus = () => false;
    expect(await pressThenBlur(50)).toBe(0);
  });
  it("stays on the host page long after a press", async () => {
    expect(await pressThenBlur(CLICK_KEEPS_KEYS + 50)).toBe(0);
  });
});
