import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BoardToHost } from "@codeboard/core";
import { Storage } from "../src/storage/boards";
import { nodeFs } from "../src/storage/nodefs";
import { makeHandler } from "../src/handlers";
import type { BoardHost, BoardPanel } from "../src/boards";
import { WS, nodeWorkspace } from "./node-workspace";
import { HostContext } from "../src/context";
import { MEDIA } from "./helpers";

const W = nodeWorkspace();
const cx = new HostContext(W);
const dir = fs.realpathSync(fs.mkdtempSync("/tmp/codeboard-ce-"));
const h = makeHandler(
  cx,
  {
    get cx() {
      return cx;
    },
    store: new Storage(nodeFs, { dir: () => dir }),
  } as unknown as BoardHost,
  MEDIA,
);
const send = (m: BoardToHost) => h({} as BoardPanel, m);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("code editing without a language service", () => {
  it("returns empty completion, hover and signature", async () => {
    await send({ type: "codeDoc", id: "free-a", lang: "python", text: "import os\nos." });
    const c0 = await send({
      type: "lspComplete",
      req: 1,
      id: "free-a",
      text: "import os\nos.",
      line: 1,
      col: 3,
      trigger: ".",
    });
    const h0 = await send({ type: "lspHover", req: 2, id: "free-a", text: "import os\nos.", line: 0, col: 7 });
    const s0 = await send({
      type: "lspSignature",
      req: 3,
      id: "free-a",
      text: "print(",
      line: 0,
      col: 6,
      trigger: "(",
    });
    await send({ type: "codeDocClose", id: "free-a" });
    expect([c0, h0, s0]).toEqual([[], [], null]);
  });
});

describe("code editing with a language service", () => {
  // a stub language service: logs what was synced and what the document was when asked
  const log: string[] = [];
  const docs = new Map<string, string>();
  const files: string[] = [];
  let slow: Promise<void> | undefined; // a slow language service: completions wait for this
  beforeAll(async () => {
    W.language.scratch = {
      sync: async (file, lang, text) => {
        log.push(`sync ${path.relative(WS, file)} ${lang} ${JSON.stringify(text)}`);
        files.push(file);
        docs.set(file, text);
      },
      close: (file) => {
        log.push(`close ${path.relative(WS, file)}`);
        docs.delete(file);
      },
      completions: async (file, line, col) => {
        await slow;
        log.push(`complete ${JSON.stringify(docs.get(file))} ${line}:${col}`);
        return [
          ...Array.from({ length: 1000 }, (_, i) => ({ label: `zz${i}` })),
          { label: "schedule", kind: "method" as const },
          { label: "is_finished", kind: "method" as const },
          { label: "reschedule" },
        ];
      },
      signature: async () => ({
        label: "allocate(seq: Sequence)",
        params: [{ at: [9, 22] as [number, number] }],
        active: 0,
      }),
    };
    const near = {
      src: { kind: "repo" as const, repo: "" },
      path: "nanovllm/engine/llm_engine.py",
      version: { kind: "none" as const },
    };
    W.language.hover = async (file, line, col) =>
      docs.has(file) ? [`\`\`\`python\ndef schedule(self) -> tuple[list[Sequence], bool]\n\`\`\` ${line}:${col}`] : [];
    await send({ type: "codeDoc", id: "free-b", lang: "python", text: "self.scheduler.", near });
  });
  afterAll(() => {
    delete W.language.scratch;
    W.language.hover = async () => [];
  });

  it("syncs the virtual document next to the linked source file before asking, and narrows by the word before the cursor", async () => {
    const items = (await send({
      type: "lspComplete",
      req: 4,
      id: "free-b",
      text: "self.scheduler.sch",
      line: 0,
      col: 18,
    })) as { label: string }[];
    expect(log[0]).toBe(`sync nanovllm/engine/.codeboard-scratch-free-b.py python "self.scheduler."`);
    expect(fs.readFileSync(files[0], "utf8")).toBe(""); // the editor writes the text; the host only creates the file
    expect(log).toContain(`complete "self.scheduler.sch" 0:18`);
    expect(items.map((i) => i.label)).toEqual(["schedule", "reschedule"]); // prefix matches first
  });
  it("caps an empty prefix at 300 items", async () => {
    expect(
      await send({ type: "lspComplete", req: 5, id: "free-b", text: "self.scheduler.", line: 0, col: 15 }),
    ).toHaveLength(300);
  });
  it("drops an older request before it reaches the language service when a newer one comes", async () => {
    let answer!: () => void;
    slow = new Promise((r) => {
      answer = r;
    });
    const both = Promise.all([
      send({ type: "lspComplete", req: 6, id: "free-b", text: "self.scheduler.s", line: 0, col: 16 }),
      send({ type: "lspComplete", req: 7, id: "free-b", text: "self.scheduler.sc", line: 0, col: 17 }),
    ]);
    answer(); // both were asked while the language service was still busy
    const [a, b] = (await both) as unknown[][];
    slow = undefined;
    expect([a.length, b.length]).toEqual([0, 2]);
    expect(log).not.toContain(`complete "self.scheduler.s" 0:16`);
  });
  it("passes hover and signature help through", async () => {
    const hv = (await send({
      type: "lspHover",
      req: 8,
      id: "free-b",
      text: "self.scheduler.schedule()",
      line: 0,
      col: 16,
    })) as string[];
    const sg = (await send({
      type: "lspSignature",
      req: 9,
      id: "free-b",
      text: "self.block_manager.allocate(",
      line: 0,
      col: 28,
      trigger: "(",
    })) as { active: number } | null;
    expect(hv).toHaveLength(1);
    expect(hv[0]).toMatch(/def schedule.* 1:16$/s); // the hover of the scratch file, its line counted from 1
    expect(sg?.active).toBe(0);
  });
  it("closes the document and deletes its file when the editor closes", async () => {
    await send({ type: "codeDocClose", id: "free-b" });
    expect(log.at(-1)).toBe("close nanovllm/engine/.codeboard-scratch-free-b.py");
    expect(fs.existsSync(files[0])).toBe(false);
  });
});
