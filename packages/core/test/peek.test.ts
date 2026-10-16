import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initAnalysis, analyze, peekPlan, isModuleDef, docToMd, cleanDoc, importPkg } from "../src/analysis";

const repo = fileURLToPath(new URL("../../../examples/nano-vllm/", import.meta.url));
const read = (p: string) => readFileSync(repo + p, "utf8");
const fa = (p: string) => { const t = read(p); return { a: analyze("python", t), lines: t.split("\n") }; };

beforeAll(() => initAnalysis());

describe("peekPlan", () => {
  it("field: shows the whole class's fields with the current one in the list", () => {
    const { a, lines } = fa("nanovllm/config.py");
    const p = peekPlan(a, lines, 17, { word: "config.kvcache_block_size" });
    expect(p.kind).toBe("field");
    expect(p.rows).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(p.head).toBe("class Config");
    expect(p.sig).toBe("(variable) kvcache_block_size: int = 256");
  });
  it("function: signature + first lines, docstring skipped, rest counted", () => {
    const { a, lines } = fa("nanovllm/utils/loader.py");
    const p = peekPlan(a, lines, 12);
    expect(p.kind).toBe("function");
    expect(p.rows).toEqual([12, 13, 14, 15]);
    expect(p.more).toBe(28 - 15);
    expect(p.sig).toBe("(function) def load_model(model: nn.Module, path: str)");
  });
  it("self.x in __init__: all self assignments of that method", () => {
    const { a, lines } = fa("nanovllm/engine/scheduler.py");
    const l = lines.findIndex((x) => /self\.max_num_seqs\s*=/.test(x)) + 1;
    const p = peekPlan(a, lines, l);
    expect(p.kind).toBe("field");
    expect(p.rows).toContain(l);
    expect(p.rows.length).toBeGreaterThan(2);
    expect(p.rows.every((r) => /^\s*self\./.test(lines[r - 1]))).toBe(true);
  });
  it("module: only docs, no source", () => {
    const src = `# mypy: allow-untyped-defs\n"""torch.multiprocessing is a wrapper around the native :mod:\`multiprocessing\` module.\n\nIt registers custom reducers, that use shared memory to provide shared\nviews on the same data in different processes."""\nimport sys\n`;
    const lines = src.split("\n");
    expect(isModuleDef(lines, 1, 0, "mp")).toBe(true);
    expect(isModuleDef(["mp = 1"], 1, 0, "mp")).toBe(false);
    const p = peekPlan(analyze("python", src), lines, 1, { word: "mp", module: true });
    expect(p).toMatchObject({ kind: "module", rows: [], sig: "(module) mp" });
    expect(p.doc).toBe("torch.multiprocessing is a wrapper around the native `multiprocessing` module.\n\nIt registers custom reducers, that use shared memory to provide shared views on the same data in different processes.");
  });
});

describe("docstrings and imports", () => {
  it("extracts and cleans docstrings", () => {
    expect(cleanDoc(`"""Creates a block.\n\n    Every block is named.\n    """`)).toBe("Creates a block.\n\nEvery block is named.");
    const a = analyze("python", `class A:\n    """Doc A."""\n    x = 1\n    def f(self):\n        'f doc'\n        return 1\n`);
    expect(a.symbols.map((s) => s.doc)).toEqual(["Doc A.", "f doc"]);
  });
  it("docToMd keeps arg lists and examples", () => {
    expect(docToMd("Load it.\n\nArgs:\n    model: the model\n    path: dir\n\n>>> load(m, p)")).toBe("Load it.\n\nArgs:\n- model: the model\n- path: dir\n\n```\n>>> load(m, p)\n```");
  });
  it("maps calls to the package they were imported from", () => {
    const { a } = fa("nanovllm/engine/model_runner.py");
    const pk = (name: string) => { const c = a.calls.find((x) => x.name === name)!; return importPkg(a, c); };
    expect(pk("init_process_group")).toBe("torch"); // dist.init_process_group
    expect(pk("SharedMemory")).toBe("multiprocessing");
    expect(pk("Qwen3ForCausalLM")).toBe("nanovllm");
    expect(pk("load_model")).toBe("nanovllm");
    expect(pk("warmup_model")).toBeUndefined(); // self.warmup_model
    expect(a.imports.find((i) => i.name === "dist")).toMatchObject({ module: "torch.distributed" });
  });
});
