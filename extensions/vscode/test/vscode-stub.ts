// Fake vscode module for host tests: a single workspace root, no open documents, no language services (executeCommand returns nothing).
import * as fs from "node:fs";
import * as path from "node:path";

export const WS = "/tmp/codeboard-perf/ws";
const inWs = (p: string) => p === WS || p.startsWith(WS + "/");
export const workspace = {
  workspaceFolders: [{ uri: { fsPath: WS }, name: "ws", index: 0 }],
  textDocuments: [] as unknown[],
  getWorkspaceFolder: (u: { fsPath: string }) => (inWs(u.fsPath) ? { uri: { fsPath: WS } } : undefined),
  /** For the name index: all .py files under WS */
  findFiles: async () => {
    const out: { fsPath: string }[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith(".")) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".py")) out.push({ fsPath: p }); } };
    walk(WS);
    return out;
  },
};
export const Uri = { file: (fsPath: string) => ({ fsPath, scheme: "file" }) };
export const commands = { executeCommand: async () => undefined };
export class Position { constructor(public line: number, public character: number) {} }
const quiet = () => {};
export const window = { createOutputChannel: () => ({ info: quiet, warn: quiet, error: quiet, appendLine: quiet }) };
