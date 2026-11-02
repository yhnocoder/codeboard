// The files behind code being edited on a board: one hidden file per editor (.codeboard-scratch-<id>.<ext>, scratchnames.ts) next
// to the source file it belongs to, so the language service resolves imports from there. The host creates, refreshes and deletes
// them; the editor (Workspace.language.scratch) only opens them as documents and asks its language service about them.
// A file left behind by a window that was closed or crashed is deleted the first time a later window uses that folder.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Disposable } from "@codeboard/core";
import type { HostContext } from "./context";
import { HEARTBEAT_MS, excludeScratch, isScratchName, scratchName, staleScratch } from "./scratchnames";

/** One host's scratch files */
export class ScratchFiles implements Disposable {
  /** editor id → its file */
  private files = new Map<string, string>();
  /** folders already swept for files left behind */
  private swept = new Set<string>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private cx: HostContext) {}

  /** Files left behind by another process: only those with a scratch name, not ours, and not refreshed for STALE_MS */
  private sweep(dir: string) {
    try {
      const mine = new Set(this.files.values());
      const entries: { name: string; mtimeMs: number }[] = [];
      for (const name of fs.readdirSync(dir)) {
        if (!isScratchName(name)) continue;
        try {
          const st = fs.statSync(path.join(dir, name));
          if (st.isFile()) entries.push({ name, mtimeMs: st.mtimeMs });
        } catch {
          /* just deleted */
        }
      }
      for (const name of staleScratch(entries, Date.now(), (n) => mine.has(path.join(dir, n))))
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          /* one file we may not delete (EPERM): the rest are still swept */
        }
    } catch {
      /* a folder we cannot read or clean: leave it */
    }
  }

  /** Another window in the same folder keeps its files: their mtime stays fresh while they are open */
  private beat = () => {
    const now = new Date();
    for (const f of this.files.values()) {
      try {
        fs.utimesSync(f, now, now);
      } catch {
        /* the file is gone */
      }
    }
  };

  /** The file for this editor, created empty the first time: next to near, or in the extension's storage without one */
  async file(id: string, lang: string, near: string | undefined): Promise<string> {
    const have = this.files.get(id);
    if (have) return have;
    const dir = near ? path.dirname(near) : path.join(this.cx.ws.storage.globalDir(), "scratch");
    fs.mkdirSync(dir, { recursive: true });
    await excludeScratch(this.cx.git, dir);
    if (!this.swept.has(dir)) {
      this.swept.add(dir);
      this.sweep(dir);
    }
    const file = path.join(dir, scratchName(id, lang));
    fs.writeFileSync(file, "");
    this.files.set(id, file);
    if (!this.heartbeat) {
      this.heartbeat = setInterval(this.beat, HEARTBEAT_MS);
      this.heartbeat.unref?.();
    }
    return file;
  }

  fileOf = (id: string) => this.files.get(id);

  private idle() {
    if (this.files.size || !this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /** Editing ended: the file goes */
  drop(id: string) {
    const f = this.files.get(id);
    this.files.delete(id);
    if (f) fs.rmSync(f, { force: true });
    this.idle();
  }

  /** The host stops: every file still open goes */
  dispose() {
    for (const f of this.files.values()) fs.rmSync(f, { force: true });
    this.files.clear();
    this.idle();
  }
}
