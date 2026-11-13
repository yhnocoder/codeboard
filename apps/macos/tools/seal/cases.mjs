// What the extension's packages/core/src/seal.ts makes of a set of names, ids and typed seals, for the tests of its Swift
// port (Sources/CodeBoardModel/Seals.swift, Tests/CodeBoardModelTests/SealTests.swift) to compare against. Writes
// Tests/CodeBoardModelTests/Fixtures/seal.json; run it again when seal.ts or the cases change (from the repository root,
// after npm ci):
//   node apps/macos/tools/seal/cases.mjs
// The names are made up for the purpose.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = import.meta.dirname;
const root = path.resolve(here, "../../../..");
const out = path.resolve(here, "../../Tests/CodeBoardModelTests/Fixtures/seal.json");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seal-cases-"));
const entry = path.join(tmp, "entry.ts");
const seal = JSON.stringify(path.join(root, "packages/core/src/seal.ts"));
fs.writeFileSync(entry, `export * from ${seal};\n`);
const bundle = path.join(tmp, "seal.mjs");
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "error" });
const S = await import(pathToFileURL(bundle).href);
fs.rmSync(tmp, { recursive: true, force: true });

const names = [
  "",
  "   ",
  "Scheduler",
  "scheduler",
  "Memory Model",
  "The Art of Computer Programming",
  "and of the",
  "CUDA Graphs",
  "LLM inference on GPUs",
  "KV-cache layout",
  "warp – level — primitives",
  "调度",
  "调度器的设计与实现细节",
  "显存 Memory",
  "Prefill 预填 Decode",
  "ひらがな カタカナ",
  "한국어 노트",
  "a",
  "über die Brücke",
  "éclair Été",
  "x86 SIMD",
  "  leading and trailing  ",
  "tabs\tand\nnewlines here",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
  "😀 Emoji board",
  "C++ templates",
  "Ⅻ roman",
  "İstanbul notes",
  "ǆungla words",
];
const texts = ["", "  ", "SP", "s p", "调度器的设计与实现细节", "ABCDEFGHIJKLMNOP", "a b\tc", "中文Mixed很多字符呀呀", "é ü", "😀😀"];
const ids = ["b1", "board-0001", "sched", "mem", "x", "", "调度", "a/b", "0c9f3e2a-77aa-4f1e-9b0c-123456789abc", "zz"];
for (let i = 0; i < 40; i++) ids.push(`id-${i}-${(i * 7919).toString(36)}`);

const cases = {
  defaultText: names.map((n) => ({ name: n, text: S.defaultSealText(n) })),
  clean: [...names, ...texts].map((t) => ({ text: t, clean: S.cleanSealText(t), ok: S.sealTextOk(t) })),
  color: ids.map((id) => ({ id, color: S.defaultSealColor(id) })),
  sealOf: names.slice(0, 12).flatMap((name, i) =>
    [undefined, { text: "ZZ" }, { color: "teal" }, { text: "", color: "ink" }].map((seal) => ({
      id: ids[i],
      name,
      seal: seal ?? null,
      out: S.sealOf({ id: ids[i], name, seal }),
    })),
  ),
  keep: names.slice(0, 12).flatMap((name, i) =>
    ["", S.defaultSealText(name.trim()), "NEW", "调 度"].flatMap((text) =>
      [S.defaultSealColor(ids[i]), "plum"].map((color) => ({
        id: ids[i],
        name,
        text,
        color,
        out: S.sealToKeep({ id: ids[i], name }, text, color) ?? null,
      })),
    ),
  ),
};
fs.writeFileSync(out, `${JSON.stringify(cases, null, 1)}\n`);
console.log(`wrote ${path.relative(root, out)}`);
