// Where the Markdown component's files are, for the scripts that write some of them (fixtures.mjs, rules.mjs,
// emoji.mjs): `--out <folder>` or MARKDOWN_COMPONENT, else this checkout's own
import { join } from "node:path";

export function componentRoot() {
  const i = process.argv.indexOf("--out");
  return (i > 0 ? process.argv[i + 1] : undefined) ?? process.env.MARKDOWN_COMPONENT ?? join(import.meta.dirname, "../..");
}
