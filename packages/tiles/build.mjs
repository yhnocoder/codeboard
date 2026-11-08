// npm run build -w @codeboard/tiles: the CLI as one file, dist/cli.mjs, with the host (TypeScript, used from source) bundled in
// and the npm packages left to node_modules. RENDERER_HASH is what of this package draws the tiles (the page and the code that
// drives it and cuts the shots): with the built board's files it makes every board's picture hash (src/hash.ts)
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "esbuild";

const HERE = import.meta.dirname;
const DRAWS = ["page/render.html", "src/render.ts", "src/tiles.ts", "src/hash.ts"];
const h = createHash("sha256");
for (const f of DRAWS) h.update(f).update("\0").update(fs.readFileSync(path.join(HERE, f))).update("\0");

await build({
  entryPoints: [path.join(HERE, "src/cli.ts")],
  outfile: path.join(HERE, "dist/cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  define: { RENDERER_HASH: JSON.stringify(h.digest("hex")) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "warning",
  plugins: [
    {
      name: "npm-external",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (r) =>
          r.path.startsWith("@codeboard/") || r.path.startsWith("node:") ? undefined : { external: true },
        );
      },
    },
  ],
});
