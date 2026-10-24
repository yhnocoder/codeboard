// AI 续写（灰字补全）问模型的提示词、模型回来的字怎么收拾（complete.ts）
import { describe, expect, it } from "vitest";
import { cleanCompletion, completePrompt } from "../src/complete";

describe("AI completion text", () => {
  it("cleans model output", () => {
    expect(cleanCompletion("```\n the rest.\n```", "Hello and", "")).toBe(" the rest.");
    expect(cleanCompletion("Hello and more", "say Hello and", "")).toBe(" more");
    expect(cleanCompletion("next line\nsecond", "x ", "")).toBe("next line");
    expect(cleanCompletion("   ", "x", "")).toBe("");
  });
  it("prompt carries the text around the cursor", () => {
    const p = completePrompt("before text", "after text");
    expect(p).toContain("before text");
    expect(p).toContain("after text");
  });
});
