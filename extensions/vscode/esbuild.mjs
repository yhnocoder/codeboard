import { build, context } from "esbuild";

const opts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};
if (process.argv.includes("--watch")) await (await context(opts)).watch();
else await build(opts);
