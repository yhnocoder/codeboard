// Writes the icon path tables in packages/board/src/ui/icons.tsx from icons.src.mjs.
// Usage: node tools/icons/gen.mjs   (then node tools/icons/check.mjs)
import * as fs from "node:fs";
import * as path from "node:path";
import { ICONS, STICKERS, STICKER_BOX } from "./icons.src.mjs";
import { xform } from "./shapes.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const file = path.join(root, "packages/board/src/ui/icons.tsx");
const rows = (k) => Object.entries(ICONS).filter(([, v]) => v[k]).map(([n, v]) => `  ${n}: "${v[k]}", // ${v[2]}`).join("\n");
let src = fs.readFileSync(file, "utf8");
const put = (v, body) => {
  const re = new RegExp(`(const ${v}: Record<string, string> = \\{\\n)[\\s\\S]*?(\\n\\};)`);
  if (!re.test(src)) throw new Error(`no table ${v} in icons.tsx`);
  src = src.replace(re, (_, a, b) => a + body + b);
};
put("P", rows(0));
put("F", rows(1));
fs.writeFileSync(file, src);
console.log(`icons.tsx: ${Object.keys(ICONS).length} icons`);

// sticker built-ins: replace the d / fill of each BUILTIN row in glyphs.tsx
const gfile = path.join(root, "packages/board/src/stickers/glyphs.tsx");
let g = fs.readFileSync(gfile, "utf8");
for (const [name, v] of Object.entries(STICKERS)) {
  const re = new RegExp(`(\\{ name: "${name}", [^\\n]*?), (?:d|fill): "[^"]*"( \\})`);
  if (!re.test(g)) throw new Error(`no BUILTIN row for ${name}`);
  const key = v.fill ? "fill" : "d", d = xform(v.fill ?? v.d, STICKER_BOX.s, STICKER_BOX.o, STICKER_BOX.o);
  g = g.replace(re, (_, a, b) => `${a}, ${key}: "${d}"${b}`);
}
fs.writeFileSync(gfile, g);
console.log(`glyphs.tsx: ${Object.keys(STICKERS).length} stickers`);
