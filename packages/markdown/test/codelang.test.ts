import { describe, expect, it } from "vitest";
import { langLabel, langOf, matchLangs, type CodeLang } from "../src/editor/codelang";

const LANGS: CodeLang[] = [
  { name: "python", label: "Python", aliases: ["py", "python3"] },
  { name: "cuda", label: "CUDA", aliases: ["cuda-cpp", "cu"] },
  { name: "cpp", label: "C++", aliases: ["c++", "cc"] },
  { name: "c", label: "C" },
  { name: "javascript", label: "JavaScript", aliases: ["js"] },
];

describe("code block language box", () => {
  it("lists every language for an empty query, the ones matching the typed text otherwise, exact and prefix matches first", () => {
    expect(matchLangs(LANGS, "  ").map((l) => l.name)).toEqual(LANGS.map((l) => l.name));
    expect(matchLangs(LANGS, "py").map((l) => l.name)).toEqual(["python"]);
    expect(matchLangs(LANGS, "C").map((l) => l.name)).toEqual(["c", "cuda", "cpp", "javascript"]);
    expect(matchLangs(LANGS, "script").map((l) => l.name)).toEqual(["javascript"]);
    expect(matchLangs(LANGS, "zig")).toEqual([]);
  });
  it("writes a known language by its fence name, anything else as typed, and empty as plain text", () => {
    expect(langOf(LANGS, "py")).toBe("python");
    expect(langOf(LANGS, "CUDA-CPP")).toBe("cuda");
    expect(langOf(LANGS, "C++")).toBe("cpp");
    expect(langOf(LANGS, " zig ")).toBe("zig");
    expect(langOf(LANGS, "zig extra words")).toBe("zig");
    expect(langOf(LANGS, "   ")).toBeNull();
  });
  it("shows a language by its display name, aliases included, anything unknown as written, and none as Plain text", () => {
    expect(langLabel(LANGS, "cuda")).toBe("CUDA");
    expect(langLabel(LANGS, "py")).toBe("Python");
    expect(langLabel(LANGS, "cpp")).toBe("C++");
    expect(langLabel(LANGS, "zig")).toBe("zig");
    expect(langLabel(LANGS, "")).toBe("Plain text");
  });
});
