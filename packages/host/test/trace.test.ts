// A traceback pasted from another machine (other paths, a library frame, a line that moved since): the frames in the workspace
// become cards of the functions they ran in, at the line where the printed source is now
import { beforeAll, describe, expect, it } from "vitest";
import { parseTraceback, type CodeCard } from "@codeboard/core";
import { traceCards } from "../src/trace";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { startTreeSitter } from "./helpers";

const TB = `Traceback (most recent call last):
  File "/usr/lib/python3.12/runpy.py", line 198, in _run_module_as_main
    return _run_code(code, main_globals, None,
  File "/home/alice/src/nano-vllm/example.py", line 33, in <module>
    main()
  File "/home/alice/src/nano-vllm/example.py", line 24, in main
    outputs = llm.generate(prompts, sampling_params)
  File "/home/alice/src/nano-vllm/nanovllm/engine/llm_engine.py", line 72, in generate
    output, num_tokens = self.step()
  File "/home/alice/src/nano-vllm/nanovllm/engine/scheduler.py", line 45, in schedule
    self.block_manager.allocate(seq, num_cached_blocks)
  File "/home/alice/src/nano-vllm/nanovllm/engine/gone.py", line 3, in nowhere
    pass
AssertionError`;

beforeAll(async () => { useWorkspace(nodeWorkspace()); await startTreeSitter(); });

describe("cards for a pasted traceback", () => {
  it("finds each frame by the tail of its path, follows a moved line, and skips library frames and missing files", async () => {
    const hits = await traceCards(parseTraceback(TB)!.frames);
    const got = hits.map((h) => h && { qual: (h.card.card as CodeCard).segments[0].symbol?.qual, path: (h.card.card as CodeCard).segments[0].path, line: h.line });
    expect(got).toEqual([
      null,
      { qual: "<module>", path: "example.py", line: 33 },
      { qual: "main", path: "example.py", line: 24 },
      // printed as line 72: the statement is at 75 in this checkout
      { qual: "LLMEngine.generate", path: "nanovllm/engine/llm_engine.py", line: 75 },
      { qual: "Scheduler.schedule", path: "nanovllm/engine/scheduler.py", line: 45 },
      null,
    ]);
    // top-level code: a few lines around the frame, with views for the board
    const mod = hits[1]!.card;
    const seg = (mod.card as CodeCard).segments[0];
    expect(seg.start).toBeLessThanOrEqual(33);
    expect(seg.end).toBeGreaterThanOrEqual(33);
    expect(mod.views[seg.id]).toBeTruthy();
  });
});
