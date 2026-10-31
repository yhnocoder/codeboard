import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener<T> = (e: T) => void;
const changes = new Set<Listener<{ document: FakeDoc }>>();
const closes = new Set<Listener<FakeDoc>>();
const on =
  <T>(set: Set<Listener<T>>) =>
  (f: Listener<T>) => {
    set.add(f);
    return { dispose: () => set.delete(f) };
  };
const writes: { path: string; text: string }[] = [];
let failWrite: Error | undefined;

vi.mock("vscode", () => ({
  workspace: {
    onDidChangeTextDocument: on(changes),
    onDidCloseTextDocument: on(closes),
    fs: {
      writeFile: (uri: { fsPath: string }, data: Uint8Array) => {
        writes.push({ path: uri.fsPath, text: Buffer.from(data).toString("utf8") });
        return failWrite ? Promise.reject(failWrite) : Promise.resolve();
      },
    },
  },
  CompletionItemKind: {},
}));

class FakeDoc {
  version = 1;
  constructor(
    public uri: { fsPath: string; toString(): string },
    public text: string,
  ) {}
  getText() {
    return this.text;
  }
  /** VS Code read the file back from disk */
  reload(text: string) {
    this.text = text;
    this.version++;
    for (const f of [...changes]) f({ document: this });
  }
}
const uri = (p: string) => ({ fsPath: p, toString: () => `file://${p}` });

const { setText, isScratch, RELOAD_LIMIT_MS } = await import("../src/vscode/scratch");
const doc = (text = "old") => {
  const u = uri("/w/.codeboard-scratch-a.py");
  return { uri: u, lang: "python", doc: new FakeDoc(u, text) } as any;
};
const settled = (p: Promise<unknown>) => {
  const s = { done: false, err: undefined as unknown };
  p.then(
    () => {
      s.done = true;
    },
    (e) => {
      s.err = e;
    },
  );
  return s;
};
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  writes.length = 0;
  failWrite = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  changes.clear();
  closes.clear();
});

describe("scratch setText", () => {
  it("waits for the document to hold the new text, however late the reload comes", async () => {
    const d = doc();
    const s = settled(setText(d, "new text"));
    await tick();
    expect(writes).toEqual([{ path: "/w/.codeboard-scratch-a.py", text: "new text" }]);
    vi.advanceTimersByTime(RELOAD_LIMIT_MS - 1);
    await tick();
    expect(s.done).toBe(false);
    // another document changing, or this one changing to other text, is not the reload
    const other = new FakeDoc(uri("/w/other.py"), "");
    other.reload("new text");
    d.doc.reload("half");
    await tick();
    expect(s.done).toBe(false);
    d.doc.reload("new text");
    await tick();
    expect(s).toEqual({ done: true, err: undefined });
    expect(changes.size + closes.size).toBe(0); // listeners and the limit are cleaned up
  });
  it("does nothing when the document already has the text (CRLF read back counts)", async () => {
    await setText(doc("a\r\nb"), "a\nb");
    expect(writes).toEqual([]);
  });
  it("fails instead of answering for stale text: no reload within the limit, the document closed, or the write failed", async () => {
    const d = doc();
    const late = settled(setText(d, "x"));
    await tick();
    vi.advanceTimersByTime(RELOAD_LIMIT_MS);
    await tick();
    expect(String(late.err)).toMatch(/did not reload/);
    expect(changes.size + closes.size).toBe(0);

    const closed = settled(setText(d, "y"));
    await tick();
    for (const f of [...closes]) f(d.doc);
    await tick();
    expect(String(closed.err)).toMatch(/closed before it reloaded/);

    failWrite = new Error("EACCES");
    const unwritten = settled(setText(d, "z"));
    await tick();
    expect(String(unwritten.err)).toMatch(/EACCES/);
    expect(changes.size + closes.size).toBe(0);
  });
});

describe("scratch files in the editor's events", () => {
  it("are skipped by name, with no file of this window behind them (a delete event that comes after the file is gone)", () => {
    expect(isScratch({ scheme: "file", fsPath: "/w/.codeboard-scratch-gone.py" } as any)).toBe(true);
    expect(isScratch({ scheme: "file", fsPath: "/w/llm_engine.py" } as any)).toBe(false);
    expect(isScratch({ scheme: "untitled", fsPath: "/w/.codeboard-scratch-a.py" } as any)).toBe(false);
  });
});
