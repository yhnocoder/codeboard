// The Workspace the recording host runs on: a folder that holds only the boards (.codeboard/), read, never edited. No editor, no
// language service, no user to ask: what the host would show or ask is dropped, and its settings are the defaults
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Emitter, type Workspace } from "@codeboard/core";

export function boardsWorkspace(root: string, storage: string): Workspace {
  const quiet = new Emitter<never>();
  const state = new Map<string, unknown>();
  const inRoot = (p: string) => p === root || p.startsWith(`${root}/`);
  const none = async () => undefined;
  return {
    files: {
      roots: () => [root],
      name: () => path.basename(root),
      rootOf: (abs) => (inRoot(abs) ? root : undefined),
      unsavedText: () => undefined,
      openLanguage: () => undefined,
      openFiles: () => [],
      readBytes: async (uri, max) => {
        const abs = fileURLToPath(uri);
        return fs.statSync(abs).size > max ? undefined : fs.readFileSync(abs);
      },
      // the folder has no source files: the boards' code is what their files keep
      findFiles: async () => [],
      watch: () => ({ dispose() {} }),
      onDidSave: quiet.event,
      onDidEdit: quiet.event,
      onDidCreate: quiet.event,
      onDidDelete: quiet.event,
      onDidRename: quiet.event,
      onDidChangeRoots: quiet.event,
      onDidChangeGit: quiet.event,
    },
    storage: {
      dir: () => path.join(storage, "workspace"),
      globalDir: () => path.join(storage, "global"),
      get: <T>(k: string) => state.get(k) as T | undefined,
      set: async (k, v) => void state.set(k, v),
    },
    language: { definitions: async () => [], hover: async () => [], implementations: async () => [] },
    settings: { get: () => undefined, set: async () => {}, onDidChange: quiet.event },
    editor: { active: () => undefined, open: async () => {}, openVersion: async () => {} },
    ui: {
      info: none,
      warn: none,
      error: none,
      pick: none,
      input: none,
      openDialog: none,
      saveDialog: none,
      openUrl: async () => {},
      openFolder: async () => {},
      revealInOS: async () => {},
      copy: async () => {},
      clipboard: async () => "",
    },
    secrets: { get: none, set: async () => {}, delete: async () => {} },
    githubToken: none,
    log: () => {},
    about: { app: "codeboard-tiles", ext: "", hasExtension: () => false },
  };
}
