// Two hosts in one process (two windows of a Node sidecar, two workspaces in one test worker): each has its own name index,
// definition cache, sources, log and storage, and disposing one leaves the other working
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostEnv } from "../src/env";
import { HostContext } from "../src/context";
import { startHost, type Host } from "../src/start";
import { nodeWorkspace, type TestWorkspace } from "./node-workspace";
import { startTreeSitter, stubView } from "./helpers";

const tmp = fs.mkdtempSync("/tmp/codeboard-two-");
/** A workspace with one Python file defining name, and its own workspace storage */
function workspace(dir: string, name: string): TestWorkspace {
  const root = path.join(tmp, dir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "m.py"), `def ${name}():\n    return 1\n`);
  const w = nodeWorkspace(root);
  w.storage = { ...w.storage, dir: () => path.join(tmp, `${dir}-storage`), globalDir: () => path.join(tmp, "global") };
  return w;
}
const env = (): HostEnv => {
  const g = new Map<string, unknown>();
  return {
    globalState: {
      get: <T>(k: string) => g.get(k) as T,
      set: async (k, v) => {
        g.set(k, v);
      },
    },
    openView: () => stubView().view,
  };
};

beforeAll(startTreeSitter);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("two hosts in one process", () => {
  it("keep their own name index, definition cache, log and settings writes", async () => {
    const A = workspace("a", "alpha"),
      B = workspace("b", "beta");
    const a = new HostContext(A),
      b = new HostContext(B);
    expect((await a.index.lookupName("alpha")).map((e) => e.abs)).toEqual([path.join(A.files.roots()[0], "m.py")]);
    expect(await b.index.lookupName("alpha")).toEqual([]);
    expect((await b.index.lookupName("beta")).map((e) => e.name)).toEqual(["beta"]);

    let asksA = 0,
      asksB = 0;
    A.language.definitions = async () => (asksA++, [{ abs: "/a.py", line: 1, col: 0 }]);
    B.language.definitions = async () => (asksB++, [{ abs: "/b.py", line: 1, col: 0 }]);
    const fileA = path.join(A.files.roots()[0], "m.py"),
      fileB = path.join(B.files.roots()[0], "m.py");
    expect(await a.lsp.defs(fileA, 1, 4)).toEqual([{ abs: "/a.py", line: 1, col: 0 }]);
    expect(await b.lsp.defs(fileB, 1, 4)).toEqual([{ abs: "/b.py", line: 1, col: 0 }]);
    await a.lsp.defs(fileA, 1, 4);
    expect([asksA, asksB]).toEqual([1, 1]); // a's answer is cached in a only
    a.defs.forget();
    await b.lsp.defs(fileB, 1, 4);
    expect(asksB).toBe(1); // forgetting a's definitions leaves b's

    a.log("info", "only in a");
    expect(a.recentLog().some((l) => l.includes("only in a"))).toBe(true);
    expect(b.recentLog().some((l) => l.includes("only in a"))).toBe(false);
    a.noFim.add("x");
    a.imageText.set("k", "v");
    expect([b.noFim.size, b.imageText.size]).toEqual([0, 0]);
    a.dispose();
    b.dispose();
  });

  it("started side by side, store boards in their own folders, and one's dispose leaves the other working", async () => {
    const A = workspace("c", "gamma"),
      B = workspace("d", "delta");
    const ha: Host = startHost(A, env()),
      hb: Host = startHost(B, env());
    await Promise.all([ha.ready, hb.ready]);
    expect(ha.store.dir()).not.toBe(hb.store.dir());
    await ha.actions["codeboard.openBoard"]();
    expect((await ha.store.list()).map((m) => m.name)).toEqual(["New Board"]);
    expect(await hb.store.list()).toEqual([]);
    expect(ha.hub.cx).not.toBe(hb.hub.cx);
    ha.dispose();
    await hb.actions["codeboard.openBoard"]();
    expect((await hb.store.list()).map((m) => m.name)).toEqual(["New Board"]);
    expect(await hb.hub.cx.index.lookupName("delta")).toHaveLength(1);
    hb.dispose();
  });
});
