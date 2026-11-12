// @vitest-environment jsdom
// 换白板（宿主发 init）时界面状态怎么处理：这块白板的临时状态回到初值，宿主状态整个换掉，浮层关掉（设置页留着）
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  emptyBoard,
  type HostInfo,
  type HostToBoard,
  type SegView,
  type Stale,
} from "@codeboard/core";
import { state } from "../../src/state/store";
import { lineSel, setLineSel, reportSelection } from "../../src/state/selection";
import { dropTarget, setDropTarget, editing, setEditing, settingsOpen, setSettingsOpen } from "../../src/state/ui";
import { traffic, setTraffic } from "../../src/state/look";
import { pushLayer, closeOverlays } from "../../src/ui/overlay";
import { choose, promptText } from "../../src/ui/Menu";
import { fromHost, sent } from "./host";
import { ask, switched } from "../../src/host";
import { boardMap, boardRef, boardSet, boardSignal, boardStore, boardTimer } from "../../src/state/root";

const HOST: HostInfo = { assetBase: "", target: true, settings: DEFAULT_SETTINGS };
function init(
  id: string,
  o: { stale?: Record<string, Stale>; views?: Record<string, SegView>; host?: Partial<HostInfo> } = {},
): HostToBoard {
  const board = emptyBoard(id, id);
  return {
    type: "init",
    board,
    boards: [{ id, name: id, cards: 0 }],
    views: o.views ?? {},
    stale: o.stale ?? {},
    host: { ...HOST, ...o.host },
  };
}
/** 还没 resolve 的 Promise 给 "pending"（先让已经排好的微任务跑完） */
const settled = <T>(p: Promise<T>) =>
  Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 0))]);

// A board switch clears the selection, and the board reports the selection to the host a moment after it changes (a timer): the
// last report goes out before jsdom is torn down, or it fires on a window that is gone (an uncaught error in the run)
afterAll(async () => {
  const before = sent.length;
  reportSelection();
  await vi.waitFor(() => expect(sent.slice(before).some((m) => m.type === "selection")).toBe(true), {
    timeout: 5000,
    interval: 5,
  });
});

describe("board switch", () => {
  it("resets a signal declared with boardSignal to its initial value", () => {
    fromHost(init("a"));
    const [n, setN] = boardSignal(3);
    setN(7);
    fromHost(init("b"));
    expect(n()).toBe(3);
  });

  it("resets the board's stores, Maps, Sets, values and timers declared with the board* helpers", () => {
    fromHost(init("a"));
    const [s, setS] = boardStore<Record<string, number>>(() => ({}));
    const [kept, setKept] = boardStore<Record<string, number>>(
      () => ({}),
      (k) => k === "stays",
    );
    const m = boardMap<string, number>(),
      set = boardSet<string>(),
      r = boardRef(0),
      t = boardTimer();
    const fired = vi.fn();
    setS("x", 1);
    setKept({ stays: 1, goes: 2 });
    m.set("x", 1);
    set.add("x");
    r.v = 5;
    t.start(fired, 0);
    fromHost(init("b"));
    expect({ ...s }).toEqual({});
    // what the new board still has stays (a mounted card's measured size)
    expect({ ...kept }).toEqual({ stays: 1 });
    expect(m.size + set.size).toBe(0);
    expect(r.v).toBe(0);
    expect(t.pending).toBe(false);
  });

  it("resets the board's selection, drag, editing and traffic state but keeps Settings open", () => {
    fromHost(init("a"));
    setLineSel({ card: "c1", seg: "s1", start: 1, end: 2 });
    setDropTarget({ kind: "merge", card: "c1" });
    setEditing({ kind: "note", id: "c1" });
    setTraffic(true);
    setSettingsOpen({});
    fromHost(init("b"));
    // 上一块白板选中的行留着的话，⌥S 会在新白板上建一条指向不存在的卡的 Sidenote
    expect(lineSel()).toBeNull();
    // 拖到一半换白板：落点指着上一块白板的卡（DropHint 在新白板上找不到卡）
    expect(dropTarget()).toBeNull();
    expect(editing()).toBeNull();
    expect(traffic()).toBe(false);
    // 设置页和白板无关：留着
    expect(settingsOpen()).toEqual({});
    setSettingsOpen(false);
  });

  it("replaces the host info and version states instead of merging them", () => {
    fromHost(
      init("a", {
        stale: { s1: { state: "ok" } },
        host: { readonly: "Repository not found", clip: { board: "a", n: 1 } },
      }),
    );
    expect(state.stale.s1).toBeDefined();
    fromHost(init("b", { stale: { s2: { state: "ok" } } }));
    expect(Object.keys(state.stale)).toEqual(["s2"]);
    expect(state.host.readonly).toBeUndefined();
    expect(state.host.clip).toBeUndefined();
  });

  it("keeps only the new board's segment views", () => {
    const v = (t: string): SegView => ({ html: [t], flags: [0], calls: [], defs: [] });
    fromHost(init("a", { views: { s1: v("one"), s2: v("two") } }));
    fromHost(init("b", { views: { s2: v("two again"), s3: v("three") } }));
    expect(Object.keys(state.views).sort()).toEqual(["s2", "s3"]);
    expect(state.views.s2.html).toEqual(["two again"]);
  });

  it("closes overlays from the top down, keeping the ones that stay", () => {
    const closed: string[] = [];
    const layer = (name: string, stay?: boolean) => {
      const off = pushLayer({
        close: () => {
          closed.push(name);
          off();
        },
        stay,
      });
      return off;
    };
    layer("settings", true);
    layer("menu");
    layer("dialog");
    closeOverlays();
    expect(closed).toEqual(["dialog", "menu"]);
    closed.length = 0;
    // 换白板时也一样
    layer("pop");
    fromHost(init("c"));
    expect(closed).toEqual(["pop"]);
  });

  it("resolves a dialog with null when another dialog replaces it", async () => {
    const first = choose("Delete?", ["Delete", "Cancel"]);
    const second = promptText("Name", "x");
    expect(await settled(first)).toBeNull();
    expect(await settled(second)).toBe("pending");
  });

  it("cancels an ask still waiting with a cancellation its caller can tell from a failure", async () => {
    fromHost(init("a"));
    const waiting = ask("copyPath", {}).catch((e: unknown) => e);
    fromHost(init("b"));
    const e = await waiting;
    expect(switched(e)).toBe(true);
    expect(switched(new Error("The board changed"))).toBe(false);
  });
});
