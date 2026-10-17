// Blocks 主题：源文件路径 → 色相
import { describe, expect, it } from "vitest";
import { fileHash } from "../../src/state/filehash";

describe("fileHash", () => {
  it("is stable, in range, and spreads similar paths apart", () => {
    expect(fileHash(undefined)).toBeUndefined();
    expect(fileHash("")).toBeUndefined();
    const a = fileHash("nanovllm/engine/llm_engine.py")!;
    expect(a).toBe(fileHash("nanovllm/engine/llm_engine.py"));
    const paths = ["a.py", "b.py", "c.py", "engine/scheduler.py", "engine/model_runner.py", "engine/llm_engine.py", "layers/linear.py", "layers/attention.py"];
    const hs = paths.map((p) => fileHash(p)!);
    for (const h of hs) { expect(Number.isInteger(h)).toBe(true); expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThan(360); }
    expect(new Set(hs).size).toBe(paths.length);
  });
});
