import { describe, expect, it } from "vitest";
import { classifyPaste, parseTraceback } from "../src";

const PY311 = `Traceback (most recent call last):
  File "/home/me/nano-vllm/example.py", line 33, in <module>
    main()
  File "/home/me/nano-vllm/nanovllm/engine/llm_engine.py", line 75, in generate
    output, num_tokens = self.step()
                         ^^^^^^^^^^^
  File "/home/me/nano-vllm/nanovllm/engine/llm_engine.py", line 50, in step
    seqs, is_prefill = self.scheduler.schedule()
                       ~~~~~~~~~~~~~~~~~~~~~~~^^
AssertionError: no free blocks
`;

describe("pasting a Python traceback", () => {
  it("reads every frame with its source line, outermost first, and the exception", () => {
    const t = parseTraceback(PY311)!;
    expect(t.frames).toEqual([
      { file: "/home/me/nano-vllm/example.py", line: 33, func: "<module>", code: "main()" },
      { file: "/home/me/nano-vllm/nanovllm/engine/llm_engine.py", line: 75, func: "generate", code: "output, num_tokens = self.step()" },
      { file: "/home/me/nano-vllm/nanovllm/engine/llm_engine.py", line: 50, func: "step", code: "seqs, is_prefill = self.scheduler.schedule()" },
    ]);
    expect(t.error).toBe("AssertionError: no free blocks");
    expect(classifyPaste(PY311).kind).toBe("trace");
  });

  it("strips a prefix every line carries, as torch distributed prints it", () => {
    const text = PY311.trimEnd().split("\n").map((l) => `[rank1]: ${l}`).join("\n");
    const t = parseTraceback(`some log line\n${text}`)!;
    expect(t.frames.map((f) => f.func)).toEqual(["<module>", "generate", "step"]);
    expect(t.frames[2].code).toBe("seqs, is_prefill = self.scheduler.schedule()");
    expect(t.error).toBe("AssertionError: no free blocks");
  });

  it("takes the last traceback of a chained exception, and frames without source lines", () => {
    const t = parseTraceback(`Traceback (most recent call last):
  File "a.py", line 1, in f
KeyError: 'x'

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "b.py", line 9, in g
  File "c.py", line 4, in h
RuntimeError: boom
  while doing h`)!;
    expect(t.frames).toEqual([{ file: "b.py", line: 9, func: "g" }, { file: "c.py", line: 4, func: "h" }]);
    expect(t.error).toBe("RuntimeError: boom\n  while doing h");
  });

  it("is not a traceback without frames", () => {
    expect(parseTraceback("Traceback (most recent call last):\nnothing here")).toBeNull();
    expect(classifyPaste("def f():\n    return 1").kind).toBe("code");
  });
});
