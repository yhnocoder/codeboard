import { describe, it, expect } from "vitest";
import { fuzzy, substr } from "../src";

describe("⌘K name matching", () => {
  it("does not match names that only contain the query's letters scattered", () => {
    for (const name of ["main", "Context", "get_context", "__init__", "set_params", "Qwen3ForCausalLM"])
      expect(fuzzy("step", name)).toBe(-1);
  });
  it("matches a query that is part of the name or the qualified name", () => {
    expect(fuzzy("step", "step")).toBeGreaterThan(0);
    expect(fuzzy("sched", "Scheduler")).toBeGreaterThan(0);
    expect(substr("step", "LLMEngine.step")).toBeGreaterThan(0);
    expect(substr("step", "Qwen3ForCausalLM.__init__")).toBe(-1);
  });
  it("matches abbreviations made of word starts or runs of letters", () => {
    expect(fuzzy("ca", "can_allocate")).toBeGreaterThan(0);
    expect(fuzzy("bm", "BlockManager")).toBeGreaterThan(0);
    expect(fuzzy("prefill", "prepare_prefill")).toBeGreaterThan(0);
    expect(fuzzy("ppre", "prepare_prefill")).toBeGreaterThan(0);
    expect(fuzzy("bm", "batch_sum")).toBe(-1);
  });
  it("ranks substring matches above abbreviations", () => {
    expect(fuzzy("alloc", "allocate")).toBeGreaterThan(fuzzy("ca", "can_allocate"));
    expect(fuzzy("bm", "bm_free")).toBeGreaterThan(fuzzy("bm", "BlockManager"));
  });
});
