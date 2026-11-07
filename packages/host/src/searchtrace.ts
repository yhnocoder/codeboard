// ⌘K's search traces: every session the board reports (what was typed, what each group answered, what was picked or nothing,
// the feedback given) kept with where the project stood (each root's commit, branch and uncommitted changes) in the storage
// folder's .trace/search.jsonl, out of git and never sent anywhere. Export Search Traces… writes them as one JSON file to hand
// over for analysis. Independent of the search engine: it records what the board was shown.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SearchTrace } from "@codeboard/core";
import type { Storage } from "./storage/boards";
import type { HostContext } from "./context";
import { git, githubRemote } from "./git";

/** The export's format name and version (what an analysis script checks) */
export const TRACE_FORMAT = "codeboard-search-traces";
const TRACE_VERSION = 1;
/** Changed files listed per root (the rest only counted) */
const FILES_LISTED = 200;

/** Where one root of the project stood when the search ran */
export type RootState = {
  name: string;
  repo?: string;
  commit?: string;
  branch?: string;
  /** uncommitted changes against the commit: the files (status letters as git status --porcelain), their count, git diff
   *  --shortstat, and a hash of the whole diff (two searches on the same changes share it) */
  dirty?: { files: string[]; n: number; stat: string; hash: string };
};

/** A trace as kept: the board's record and where the project stood */
export type KeptTrace = SearchTrace & { roots: RootState[] };

export class SearchTraces {
  /** One write at a time, in order */
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private cx: HostContext) {}

  private file(store: Storage) {
    return path.join(store.dir(), ".trace", "search.jsonl");
  }

  /** Keeps a session's trace with where the project stands now */
  record(store: Storage, t: SearchTrace): Promise<void> {
    const run = this.queue.then(async () => {
      const roots = await Promise.all(this.cx.roots().map(rootState));
      const file = this.file(store);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(path.join(path.dirname(file), ".gitignore"), "*\n", { flag: "wx" }).catch(() => undefined);
      const kept: KeptTrace = { ...t, roots };
      // a line cut short (the window closed while writing) ends here, so this one starts on its own line
      const cut = !(await endsWithNewline(file));
      await fs.appendFile(file, `${cut ? "\n" : ""}${JSON.stringify(kept)}\n`);
    });
    this.queue = run.catch((err) => this.cx.log("warn", `search trace: ${(err as Error).message}`));
    return run;
  }

  /** Every session kept, oldest first (an id written twice: the last one) */
  async all(store: Storage): Promise<KeptTrace[]> {
    await this.queue;
    const text = await fs.readFile(this.file(store), "utf8").catch(() => "");
    const byId = new Map<string, KeptTrace>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as KeptTrace;
        byId.set(t.id, t);
      } catch {
        // a line cut short (the window closed while writing): skipped
      }
    }
    return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  /** The traces as one file: everything an analysis needs, nothing to look up elsewhere */
  async exportJson(store: Storage): Promise<{ text: string; n: number }> {
    const traces = await this.all(store);
    const out = {
      format: TRACE_FORMAT,
      version: TRACE_VERSION,
      exported: new Date().toISOString(),
      traces,
    };
    return { text: `${JSON.stringify(out, null, 1)}\n`, n: traces.length };
  }
}

async function rootState(root: string): Promise<RootState> {
  const name = path.basename(root);
  const commit = (await git(root, ["rev-parse", "HEAD"]))?.trim();
  if (!commit) return { name };
  const [branch, remote, status, stat] = await Promise.all([
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    githubRemote(root),
    git(root, ["status", "--porcelain", "--untracked-files=normal"]),
    git(root, ["diff", "HEAD", "--shortstat"]),
  ]);
  const files = (status ?? "").split("\n").filter((l) => l.trim());
  const state: RootState = { name, commit, branch: branch?.trim() || undefined };
  if (remote) state.repo = `${remote.owner}/${remote.name}`;
  if (files.length)
    state.dirty = {
      files: files.slice(0, FILES_LISTED).map((l) => l.trimEnd()),
      n: files.length,
      stat: stat?.trim() ?? "",
      hash: await changesHash(root, files),
    };
  return state;
}

/** A hash of the uncommitted changes: the diff against HEAD (streamed, however big) and the new files' contents */
async function changesHash(root: string, files: string[]): Promise<string> {
  const h = createHash("sha1");
  await new Promise<void>((res) => {
    const p = spawn("git", ["diff", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (c: Buffer) => h.update(c));
    p.on("close", () => res());
    p.on("error", () => res());
  });
  // each new file by itself (status lists a new folder as one line, and quotes odd names)
  const fresh = ((await git(root, ["ls-files", "-o", "--exclude-standard", "-z"])) ?? "")
    .split("\0")
    .filter(Boolean)
    .slice(0, 1000);
  const blobs = fresh.length
    ? await new Promise<string>((res) => {
        const p = execFile("git", ["hash-object", "--stdin-paths"], { cwd: root }, (err, out) => res(err ? "" : out));
        p.stdin?.end(fresh.join("\n"));
      })
    : "";
  return h.update(files.join("\n")).update(blobs).digest("hex").slice(0, 12);
}

async function endsWithNewline(file: string): Promise<boolean> {
  const f = await fs.open(file, "r").catch(() => undefined);
  if (!f) return true;
  try {
    const { size } = await f.stat();
    if (!size) return true;
    const b = Buffer.alloc(1);
    await f.read(b, 0, 1, size - 1);
    return b[0] === 10;
  } finally {
    await f.close();
  }
}

/** Command Export Search Traces…: every ⌘K session kept on this machine as one JSON file */
export async function exportSearchTraces(cx: HostContext, store: Storage): Promise<boolean> {
  const { text, n } = await cx.searchTraces.exportJson(store);
  const ui = cx.ws.ui;
  if (!n) {
    void ui.info("No searches recorded yet: ⌘K keeps one for every search.");
    return false;
  }
  const day = new Date().toISOString().slice(0, 10);
  const file = await ui.saveDialog({
    defaultPath: path.join(os.homedir(), `search-traces-${day}.json`), // not in the repository, where it could be committed
    filters: { "Search Traces": ["json"] },
  });
  if (!file) return false;
  await fs.writeFile(file, text);
  cx.log("info", `search traces: exported ${n} to ${file}`);
  void ui
    .info(`Exported ${n} searches to ${path.basename(file)}`, "Reveal")
    .then((r) => (r ? ui.revealInOS(file) : undefined));
  return true;
}
