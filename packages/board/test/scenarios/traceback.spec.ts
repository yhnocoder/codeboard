// A Python traceback pasted on the board unrolls into a call chain of the frames found in the workspace (the real host's
// traceCards on examples/nano-vllm): one card per frame, arrows from the calling lines marked Observed, the raising line
// highlighted, the exception in a Note at the end, and the whole paste one undo step
import * as path from "node:path";
import { emptyBoard, type CodeCard, type NoteCard } from "@codeboard/core";
import { shot, REPO } from "../harness";
import { nodeWorkspace, startAnalysis, traceCards, useWorkspace } from "@codeboard/host/testing";
import { test, open, light, verdict, until, idle } from "../fixtures";

const TB = `Traceback (most recent call last):
  File "/usr/lib/python3.12/runpy.py", line 198, in _run_module_as_main
    return _run_code(code, main_globals, None,
  File "/home/alice/nano-vllm/example.py", line 33, in <module>
    main()
  File "/home/alice/nano-vllm/example.py", line 24, in main
    outputs = llm.generate(prompts, sampling_params)
              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/home/alice/nano-vllm/nanovllm/engine/llm_engine.py", line 75, in generate
    output, num_tokens = self.step()
                         ^^^^^^^^^^^
  File "/home/alice/nano-vllm/nanovllm/engine/llm_engine.py", line 50, in step
    seqs, is_prefill = self.scheduler.schedule()
                       ~~~~~~~~~~~~~~~~~~~~~~~^^
  File "/home/alice/nano-vllm/nanovllm/engine/scheduler.py", line 45, in schedule
    self.block_manager.allocate(seq, num_cached_blocks)
  File "/home/alice/nano-vllm/nanovllm/engine/block_manager.py", line 76, in allocate
    assert not seq.block_table
           ^^^^^^^^^^^^^^^^^^^
AssertionError: sequence 3 already has blocks`;

test("pastedTracebackUnrollsIntoACallChain", () => verdict("pastedTracebackUnrollsIntoACallChain", async (res) => {
  useWorkspace(nodeWorkspace(path.join(REPO, "examples/nano-vllm")));
  await startAnalysis();
  const h = await open({ board: emptyBoard("bT", "traceback"), light, w: 1600, h: 1000, on: async (m, reply) => {
    if (m.type !== "trace") return false;
    await reply(m.req!, await traceCards(m.frames));
    return true;
  } });
  await h.page.mouse.move(200, 200);
  await h.page.evaluate((t) => { const dt = new DataTransfer(); dt.setData("text/plain", t); window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, TB);
  await until(h, "the chain unrolls to the exception Note", () => h.board().cards.some((c) => c.kind === "note"), 10000);
  await idle(h);
  const b = h.board();
  const code = b.cards.filter((c): c is CodeCard => c.kind === "code");
  res.cards = code.map((c) => c.segments[0].symbol?.qual);
  const calls = b.links.filter((l) => l.call);
  res.calls = calls.map((l) => `${l.call!.name}:${l.from.line}:${l.call!.ev?.kind}`);
  res.hl = code[code.length - 1]?.segments[0].hl;
  const note = b.cards.find((c): c is NoteCard => c.kind === "note");
  res.note = note?.md;
  res.noteLink = b.links.some((l) => !l.call && l.to.card === note?.id && l.from.line === 76);
  await shot(h, "traceback-chain");
  await h.page.keyboard.press("Meta+-"); await h.page.keyboard.press("Meta+-"); await idle(h);
  await shot(h, "traceback-chain-end");
  await h.page.keyboard.press("Shift+Digit1"); await idle(h);
  await shot(h, "traceback-chain-fit");
  // one paste, one undo step
  await h.page.keyboard.press("Meta+z"); await idle(h);
  res.afterUndo = h.board().cards.length;
  await h.page.context().close();
  return JSON.stringify(res.cards) === JSON.stringify(["<module>", "main", "LLMEngine.generate", "LLMEngine.step", "Scheduler.schedule", "BlockManager.allocate"])
    && JSON.stringify(res.calls) === JSON.stringify(["main:33:observed", "generate:24:observed", "step:75:observed", "schedule:50:observed", "allocate:45:observed"])
    && JSON.stringify(res.hl) === "[76]" && /^\*\*AssertionError\*\*/.test(String(res.note)) && /sequence 3 already has blocks/.test(String(res.note))
    && res.noteLink && res.afterUndo === 0;
}));
