import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { codeExts } from "@codeboard/analysis/langs";
import { startAnalysis } from "../src/analysis";
import { CODE_GLOB } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { HostContext } from "../src/context";

let cx: HostContext;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-nameindex-"));

beforeAll(async () => {
  fs.writeFileSync(path.join(root, "kernel.hh"), "namespace k {\nint launch_hh(int n) {\n  return n;\n}\n}\n");
  fs.writeFileSync(path.join(root, "impl.inl"), "template <typename T>\nT scale_inl(T x) {\n  return x * 2;\n}\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "int not_code(int n) { return n; }\n");
  cx = new HostContext(nodeWorkspace(root));
  await startAnalysis();
});

describe("name index files", () => {
  it("covers every extension of an analysed language", () => {
    for (const e of ["py", "pyi", "cu", "cuh", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "h", "inl", "c", "rs"])
      expect(codeExts()).toContain(e);
    expect(CODE_GLOB).toMatch(/[{,]hh[,}]/);
    expect(CODE_GLOB).toMatch(/[{,]inl[,}]/);
    expect(cx.index.isCode("/w/a/kernel.hh") && cx.index.isCode("/w/a/impl.inl")).toBe(true);
    expect(cx.index.isCode("/w/a/notes.txt") || cx.index.isCode("/w/node_modules/x/kernel.hh")).toBe(false);
  });
  it("leave out installed packages, by the folders under the workspace root only", () => {
    expect(cx.index.isCode(path.join(root, "env/lib/python3.12/site-packages/pkg/core.py"))).toBe(false);
    const pkg = path.join(root, "lib/site-packages/pkg");
    cx = new HostContext(nodeWorkspace(pkg));
    try {
      expect(cx.index.isCode(path.join(pkg, "core.py"))).toBe(true);
    } finally {
      cx = new HostContext(nodeWorkspace(root));
    }
  });
  it("finds definitions in .hh and .inl files", async () => {
    expect((await cx.index.lookupName("launch_hh")).map((e) => path.basename(e.abs))).toEqual(["kernel.hh"]);
    expect((await cx.index.lookupName("scale_inl")).map((e) => path.basename(e.abs))).toEqual(["impl.inl"]);
    expect(await cx.index.lookupName("not_code")).toEqual([]);
  });
});
