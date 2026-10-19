// Workspace for host tests in plain Node: a single workspace root, no language service unless a test plugs one in,
// "open editors" are a map of path → text, events are fired by the test.
import * as fs from "node:fs";
import * as path from "node:path";
import { Emitter, type Workspace } from "@codeboard/core";

export const WS = "/tmp/codeboard-perf/ws";

export type TestWorkspace = Workspace & {
  /** Unsaved editor buffers */
  open: Map<string, string>;
  fire: { save: Emitter<string | undefined>; edit: Emitter<string | undefined>; create: Emitter<string[]>; delete: Emitter<string[]>; change: Emitter<string> };
  /** Number of findFiles calls (the name index must not walk the workspace on every click) */
  finds: number;
};

const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "build", "dist", "__pycache__", ".mypy_cache", ".tox"]);

export function nodeWorkspace(root = WS): TestWorkspace {
  const inRoot = (p: string) => p === root || p.startsWith(root + "/");
  const quiet = new Emitter<never>();
  const fire = { save: new Emitter<string | undefined>(), edit: new Emitter<string | undefined>(), create: new Emitter<string[]>(), delete: new Emitter<string[]>(), change: new Emitter<string>() };
  const open = new Map<string, string>();
  const w: TestWorkspace = {
    open, fire, finds: 0,
    files: {
      roots: () => [root],
      rootOf: (abs) => (inRoot(abs) ? root : undefined),
      unsavedText: (abs) => open.get(abs),
      openLanguage: () => undefined,
      openFiles: () => [...open].map(([abs, t]) => ({ abs, text: () => t })),
      /** Code files under the root ("**\/*.{ext,…}" filters by extension, anything else = .py files), sorted, up to max */
      findFiles: async (include, _exclude, max) => {
        w.finds++;
        const ext = /^\*\*\/\*\.\{?([\w,]+)\}?$/.exec(include)?.[1].split(",");
        const want = (p: string) => (ext ? ext.some((e) => p.endsWith(`.${e}`)) : p.endsWith(".py"));
        const out: string[] = [];
        const walk = (d: string) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else if (want(p)) out.push(p);
          }
        };
        walk(root);
        return max ? out.slice(0, max) : out;
      },
      watch: (_base, _glob, fn) => fire.change.event(fn),
      onDidSave: fire.save.event,
      onDidEdit: fire.edit.event,
      onDidCreate: fire.create.event,
      onDidDelete: fire.delete.event,
      onDidRename: quiet.event,
      onDidChangeRoots: quiet.event,
      onDidChangeGit: quiet.event,
    },
    storage: { dir: () => "/tmp/codeboard-perf/storage", globalDir: () => "/tmp/codeboard-perf/global", get: () => undefined, set: async () => {} },
    language: { definitions: async () => [], hover: async () => [], implementations: async () => [] },
    settings: { get: () => undefined, set: async () => {}, onDidChange: quiet.event },
    editor: { active: () => undefined, open: async () => {}, openVersion: async () => {} },
    ui: {
      info: async () => undefined, warn: async () => undefined, error: () => {}, pick: async () => undefined, input: async () => undefined,
      openDialog: async () => undefined, saveDialog: async () => undefined, openUrl: async () => {}, openFolder: async () => {}, revealInOS: async () => {}, copy: async () => {}, clipboard: async () => "",
    },
    githubToken: async () => undefined,
    log: () => {},
    about: { app: "test", ext: "test", hasExtension: () => false },
  };
  return w;
}
