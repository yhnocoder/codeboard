import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { clipAnalysis } from "@codeboard/analysis";
import { analysisOf, segAnalysis } from "../src/analysis";
import { WS } from "./node-workspace";
import { startTreeSitter } from "./helpers";

beforeAll(startTreeSitter);

describe("segment analysis", () => {
  // new content, not in the cache
  const t = () => fs.readFileSync(path.join(WS, "nanovllm/engine/llm_engine.py"), "utf8") + "\n# segment test\n";
  it("equals the whole-file analysis clipped to the segment, before and after the whole file was analyzed", () => {
    const s1 = segAnalysis("python", t(), 20, 45, "seg-test");
    const full = analysisOf("python", t(), "seg-test");
    expect(s1.calls.length).toBeGreaterThan(0);
    expect(s1).toEqual(clipAnalysis(full, 20, 45));
    expect(segAnalysis("python", t(), 20, 45)).toEqual(s1);
  });
  it("keeps the file's imports with no lines", () => {
    expect(segAnalysis("python", t(), 1, 0).imports).toEqual(analysisOf("python", t()).imports);
  });
});
