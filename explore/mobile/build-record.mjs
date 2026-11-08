import { build } from "esbuild";
await build({
  entryPoints: ["record.ts"], bundle: true, platform: "node", format: "esm", outfile: "out/record.mjs",
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  plugins: [{ name: "ext", setup(b) { b.onResolve({ filter: /^[^./]/ }, (a) => a.path.startsWith("@codeboard/") || a.path.startsWith("node:") ? undefined : { external: true }); } }],
});
