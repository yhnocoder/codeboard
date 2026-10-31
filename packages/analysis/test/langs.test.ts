import { describe, expect, it } from "vitest";
import { LANG_TABLE, analyzedEditorLangs } from "../src/langs";

// The editor shows board marks (CodeLens) on the files of every language the analysis reads, Rust included: the list comes from the
// language table, so a language added there gets them too
describe("analyzedEditorLangs", () => {
  it("has the editor id of every analyzed language, once", () => {
    const ids = analyzedEditorLangs();
    for (const l of LANG_TABLE) if (l.grammar) expect(ids).toContain(l.vscodeId);
    expect(ids).toEqual(expect.arrayContaining(["python", "cpp", "cuda-cpp", "c", "rust"]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("typescript");
  });
});
