// Writes Sources/MarkdownCore/Data/EmojiTable.swift from the TypeScript package's emoji table (gemoji names), so
// :name: reads the same in both. Run after packages/markdown/src/emoji-data.ts changes:
//   node apps/macos/tools/markdown/emoji.mjs [--out <the component's folder>]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { componentRoot } from "./component.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../../../../packages/markdown/src/emoji-data.ts"), "utf8");
const header = /^\/\/ (Generated .*)$/m.exec(src)?.[1] ?? "";
const pairs = [...src.matchAll(/^\s+("([^"]+)"|[\w+-]+):\s*"([^"]*)",?$/gm)].map((m) => [m[2] ?? m[1], m[3]]);
// one line per name, a tab before its emoji; Swift reads it once into a dictionary
const body = pairs.map(([n, e]) => `${n}\t${e}`).join("\n");
const gemoji = /from (gemoji [\d.]+)/.exec(header)?.[1] ?? "gemoji";
const swift = `// Generated from @yhnocoder/markdown's emoji-data.ts, itself generated from ${gemoji}: do not edit.

// swift-format-ignore-file

enum EmojiTable {
  static let count = ${pairs.length}
  static let lines = """
${body}
"""
}
`;
writeFileSync(join(componentRoot(), "Sources/MarkdownCore/Data/EmojiTable.swift"), swift);
console.log(`wrote ${pairs.length} emoji`);
