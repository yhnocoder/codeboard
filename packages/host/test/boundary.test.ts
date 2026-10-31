// Package boundaries: host code works with any editor (never imports vscode; editor access goes through Workspace and HostEnv),
// neither host nor the board reaches into the VS Code extension's files, and analysis sits below core (core imports it, so it imports
// no other CodeBoard package), and everything outside packages/host goes through its entries: the VS Code extension's code only through
// @codeboard/host, the board's tests, harness and stories and the extension's tests through @codeboard/host or @codeboard/host/testing,
// the board's own code not at all
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const PKGS = path.resolve(__dirname, "../..");
const IMPORT_VSCODE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']vscode["']/m;
const IMPORT_CODEBOARD = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']@codeboard\//m;
const IMPORT_EXTENSION = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'][^"']*extensions\//m;
const HOST_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](@codeboard\/host[^"']*)["']/gm;
const hostImports = (dirs: string[], allowed: string[]) =>
  dirs
    .flatMap((d) => files(path.join(PKGS, d)))
    .flatMap((f) =>
      [...fs.readFileSync(f, "utf8").matchAll(HOST_SPEC)]
        .map((m) => m[1])
        .filter((s) => !allowed.includes(s))
        .map((s) => `${path.relative(PKGS, f)}: ${s}`),
    );
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "fixtures" ? [] : files(p);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [p] : [];
  });
const matching = (dirs: string[], re: RegExp) =>
  dirs
    .flatMap((d) => files(path.join(PKGS, d)))
    .filter((f) => re.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(PKGS, f));

describe("package boundaries", () => {
  it("no host or analysis file imports vscode", () => {
    expect(matching(["host/src", "host/test", "analysis/src", "analysis/test"], IMPORT_VSCODE)).toEqual([]);
  });
  it("nothing in packages/host, packages/board or packages/analysis imports from extensions/", () => {
    expect(
      matching(["host/src", "host/test", "board/src", "board/test", "analysis/src", "analysis/test"], IMPORT_EXTENSION),
    ).toEqual([]);
  });
  it("packages/analysis imports no other CodeBoard package", () => {
    expect(matching(["analysis/src", "analysis/test"], IMPORT_CODEBOARD)).toEqual([]);
  });
  it("the extension's code imports the host only from @codeboard/host", () => {
    expect(hostImports(["../extensions/vscode/src"], ["@codeboard/host"])).toEqual([]);
  });
  it("tests, the harness and stories import the host only from @codeboard/host or @codeboard/host/testing", () => {
    expect(
      hostImports(
        ["board/test", "board/stories", "../extensions/vscode/test"],
        ["@codeboard/host", "@codeboard/host/testing"],
      ),
    ).toEqual([]);
  });
  it("the board's own code doesn't import the host", () => {
    expect(hostImports(["board/src"], [])).toEqual([]);
  });
});
