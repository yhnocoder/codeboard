// The name index takes its files from the language table: every extension of a language with a grammar is indexed
// (.hh / .inl headers included), nothing else is
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { codeExts } from "@codeboard/analysis/langs";
import { startAnalysis } from "../src/analysis";
import { CODE_GLOB, useWorkspace } from "../src/ws";
import { isCode, lookupName, resetIndex } from "../src/nameindex";
import { nodeWorkspace } from "./node-workspace";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-nameindex-"));

beforeAll(async () => {
  fs.writeFileSync(path.join(root, "kernel.hh"), "namespace k {\nint launch_hh(int n) {\n  return n;\n}\n}\n");
  fs.writeFileSync(path.join(root, "impl.inl"), "template <typename T>\nT scale_inl(T x) {\n  return x * 2;\n}\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "int not_code(int n) { return n; }\n");
  useWorkspace(nodeWorkspace(root));
  resetIndex();
  await startAnalysis();
});

describe("name index files", () => {
  it("covers every extension of an analysed language", () => {
    for (const e of ["py", "pyi", "cu", "cuh", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "h", "inl", "c", "rs"]) expect(codeExts()).toContain(e);
    expect(CODE_GLOB).toMatch(/[{,]hh[,}]/);
    expect(CODE_GLOB).toMatch(/[{,]inl[,}]/);
    expect(isCode("/w/a/kernel.hh") && isCode("/w/a/impl.inl")).toBe(true);
    expect(isCode("/w/a/notes.txt") || isCode("/w/node_modules/x/kernel.hh")).toBe(false);
  });
  it("finds definitions in .hh and .inl files", async () => {
    expect((await lookupName("launch_hh")).map((e) => path.basename(e.abs))).toEqual(["kernel.hh"]);
    expect((await lookupName("scale_inl")).map((e) => path.basename(e.abs))).toEqual(["impl.inl"]);
    expect(await lookupName("not_code")).toEqual([]);
  });
});
