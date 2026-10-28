import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BoardToHost } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { makeHandler } from "../src/handlers";
import type { BoardHost, BoardPanel } from "../src/boards";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";

const W = nodeWorkspace();
const dir = fs.mkdtempSync("/tmp/codeboard-ce-");
const h = makeHandler({ store: new Storage(nodeFs, { dir: () => dir }) } as unknown as BoardHost);
const send = (m: BoardToHost) => h({} as BoardPanel, m);
beforeAll(() => useWorkspace(W));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("code editing without a language service", () => {
  it("returns empty completion, hover and signature", async () => {
    await send({ type: "codeDoc", id: "free-a", lang: "python", text: "import os\nos." });
    const c0 = await send({ type: "lspComplete", req: 1, id: "free-a", text: "import os\nos.", line: 1, col: 3, trigger: "." });
    const h0 = await send({ type: "lspHover", req: 2, id: "free-a", text: "import os\nos.", line: 0, col: 7 });
    const s0 = await send({ type: "lspSignature", req: 3, id: "free-a", text: "print(", line: 0, col: 6, trigger: "(" });
    await send({ type: "codeDocClose", id: "free-a" });
    expect([c0, h0, s0]).toEqual([[], [], null]);
  });
});

describe("code editing with a language service", () => {
  // a stub language service: logs what was synced and what the document was when asked
  const log: string[] = [];
  const docs = new Map<string, string>();
  let slow = 0;
  beforeAll(async () => {
    W.language.scratch = {
      sync: async (id, lang, text, near) => { log.push(`sync ${id} ${lang} ${near ? path.relative(WS, near) : "-"} ${JSON.stringify(text)}`); docs.set(id, text); },
      close: async (id) => { log.push(`close ${id}`); docs.delete(id); },
      completions: async (id, line, col) => {
        if (slow) await new Promise((r) => setTimeout(r, slow));
        log.push(`complete ${JSON.stringify(docs.get(id))} ${line}:${col}`);
        return [...Array.from({ length: 1000 }, (_, i) => ({ label: `zz${i}` })), { label: "schedule", kind: "method" as const }, { label: "is_finished", kind: "method" as const }, { label: "reschedule" }];
      },
      hover: async () => ["```python\ndef schedule(self) -> tuple[list[Sequence], bool]\n```"],
      signature: async () => ({ label: "allocate(seq: Sequence)", params: [{ at: [9, 22] as [number, number] }], active: 0 }),
    };
    const near = { src: { kind: "repo" as const, repo: "" }, path: "nanovllm/engine/llm_engine.py", version: { kind: "none" as const } };
    await send({ type: "codeDoc", id: "free-b", lang: "python", text: "self.scheduler.", near });
  });
  afterAll(() => { delete W.language.scratch; });

  it("syncs the virtual document next to the linked source file before asking, and narrows by the word before the cursor", async () => {
    const items = await send({ type: "lspComplete", req: 4, id: "free-b", text: "self.scheduler.sch", line: 0, col: 18 }) as { label: string }[];
    expect(log[0]).toBe(`sync free-b python nanovllm/engine/llm_engine.py "self.scheduler."`);
    expect(log).toContain(`complete "self.scheduler.sch" 0:18`);
    expect(items.map((i) => i.label)).toEqual(["schedule", "reschedule"]); // prefix matches first
  });
  it("caps an empty prefix at 300 items", async () => {
    expect(await send({ type: "lspComplete", req: 5, id: "free-b", text: "self.scheduler.", line: 0, col: 15 })).toHaveLength(300);
  });
  it("drops an older request before it reaches the language service when a newer one comes", async () => {
    slow = 80;
    const [a, b] = await Promise.all([
      send({ type: "lspComplete", req: 6, id: "free-b", text: "self.scheduler.s", line: 0, col: 16 }),
      send({ type: "lspComplete", req: 7, id: "free-b", text: "self.scheduler.sc", line: 0, col: 17 }),
    ]) as unknown[][];
    slow = 0;
    expect([a.length, b.length]).toEqual([0, 2]);
    expect(log).not.toContain(`complete "self.scheduler.s" 0:16`);
  });
  it("passes hover and signature help through", async () => {
    const hv = await send({ type: "lspHover", req: 8, id: "free-b", text: "self.scheduler.schedule()", line: 0, col: 16 }) as string[];
    const sg = await send({ type: "lspSignature", req: 9, id: "free-b", text: "self.block_manager.allocate(", line: 0, col: 28, trigger: "(" }) as { active: number } | null;
    expect(hv).toHaveLength(1);
    expect(hv[0]).toMatch(/def schedule/);
    expect(sg?.active).toBe(0);
  });
  it("closes the virtual document when the editor closes", async () => {
    await send({ type: "codeDocClose", id: "free-b" });
    expect(log.at(-1)).toBe("close free-b");
  });
});
