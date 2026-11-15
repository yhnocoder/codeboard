// Writes Tests/CodeBoardMarkdownTests/Fixtures/*.json: what the TypeScript Markdown package makes of the synthetic corpus
// (corpus.mjs), for the Swift parser to match exactly. Run from the repository root after `npm ci`, and commit the result:
//   node apps/macos/tools/markdown/fixtures.mjs
// It bundles the package's sources (not its build) so the fixtures follow the code in this checkout.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blocks, inline, moves } from "./corpus.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");
const out = join(here, "../../Tests/CodeBoardMarkdownTests/Fixtures");

// schema.ts keeps its MarkdownManager to itself; the bundle exports it as well, to read marked's raw tokens
const exposeManager = {
  name: "expose-manager",
  setup(b) {
    b.onLoad({ filter: /packages\/markdown\/src\/schema\.ts$/ }, (a) => ({
      contents: `${readFileSync(a.path, "utf8")}\nexport { mm as __manager };`,
      loader: "ts",
    }));
  },
};
const bundle = await build({
  stdin: {
    contents: [
      `export { mdBlockStarts, __manager } from "./packages/markdown/src/schema.ts";`,
      `export { blockInfo } from "./packages/markdown/src/editor/spans.ts";`,
      `export { cutMdBlocks, insertMdBlocks, moveMdBlocks } from "./packages/markdown/src/blockmove.ts";`,
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "error",
  plugins: [exposeManager],
});
const ts = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

/** a marked block token as the fixtures compare it */
function block(t) {
  const o = { type: t.type, raw: t.raw };
  switch (t.type) {
    case "heading":
      o.depth = t.depth;
      o.text = t.text;
      break;
    case "paragraph":
    case "text":
      o.text = t.text;
      break;
    case "code":
      o.lang = t.lang ?? null;
      o.text = t.text;
      break;
    case "blockMath":
      o.latex = t.latex;
      break;
    case "blockquote":
      o.tokens = t.tokens.map(block);
      break;
    case "list":
      o.ordered = t.ordered;
      o.start = t.start === "" ? null : t.start;
      o.loose = t.loose;
      o.items = t.items.map((i) => ({
        raw: i.raw,
        task: i.task,
        checked: i.checked ?? null,
        tokens: i.tokens.filter((k) => k.type !== "checkbox").map(block),
      }));
      break;
    case "taskList":
      o.items = t.items.map((i) => ({ text: i.text, checked: i.checked, nested: (i.nestedTokens ?? []).map(block) }));
      break;
    case "table":
      o.align = t.align;
      o.header = t.header.map((c) => c.text);
      o.rows = t.rows.map((r) => r.map((c) => c.text));
      break;
  }
  return o;
}

/** every inline text in a token tree (paragraphs, headings, cells, task items) */
function texts(ts, acc) {
  for (const t of ts) {
    if (["paragraph", "text", "heading"].includes(t.type)) acc.add(t.text);
    if (t.type === "table") for (const c of [...t.header, ...t.rows.flat()]) acc.add(c.text);
    if (t.type === "taskList") for (const i of t.items) acc.add(i.text);
    texts(t.tokens ?? [], acc);
    for (const i of t.items ?? []) {
      texts(i.tokens ?? [], acc);
      texts(i.nestedTokens ?? [], acc);
    }
  }
}

const lexer = () => ts.__manager.createLexer();
const inlineTexts = new Set(inline);
const blockCases = blocks.map((src) => {
  const toks = lexer().lex(src);
  texts(toks, inlineTexts);
  return { src, starts: ts.mdBlockStarts(src), tokens: toks.map(block) };
});

/** a span as the fixtures compare it */
const span = (s) => ({
  from: s.from,
  to: s.to,
  marks: s.marks,
  inner: s.inner,
  tag: s.tag?.nodeName ?? null,
  tagClass: s.tag?.class ?? null,
  href: s.tag?.href ?? null,
  atom: s.atom ?? null,
  plain: !!s.plain,
  kids: s.kids.map(span),
});
const inlineCases = [...inlineTexts].map((src) => ({ src, spans: ts.blockInfo(src).spans.map(span) }));

const part = (md) => ({ md, layout: null });
const moveCases = moves.map((m) => ({
  ...m,
  cutResult: ts.cutMdBlocks(part(m.src), m.cut[0], m.cut[m.cut.length - 1] + 1),
  moveResult: ts.moveMdBlocks(part(m.src), m.move.blocks[0], m.move.blocks[m.move.blocks.length - 1] + 1, m.move.to),
  insertResult: ts.insertMdBlocks(part(m.src), 1, part("inserted **block**\n\n- x")),
}));

const write = (name, data) => writeFileSync(join(out, name), `${JSON.stringify(data, null, 1)}\n`);
write("blocks.json", blockCases);
write("inline.json", inlineCases);
write("blockmove.json", moveCases);
console.log(`wrote ${blockCases.length} block, ${inlineCases.length} inline, ${moveCases.length} block-move cases`);
