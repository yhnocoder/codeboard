// The shared-card library: cards/<id>.json in the storage folder, read with a cache by modification time.
import { loadSharedCard, type SharedCardFile } from "@codeboard/core";
import type { Fs } from "./fs";
import { SAFE_ID } from "./names";

export class SharedLibrary {
  private lib = new Map<string, { mtime: number; sc: SharedCardFile }>();
  /** Unreadable card files, reported once each */
  private bad = new Set<string>();

  constructor(
    private fs: Fs,
    private root: () => string,
    private log?: (level: "info" | "warn" | "error", text: string) => void,
  ) {}

  dir() {
    return this.fs.join(this.root(), "cards");
  }
  fileOf(id: string) {
    return this.fs.join(this.dir(), `${id}.json`);
  }

  /** 卡库里的一张卡（按修改时间缓存）；没有或读不了返回 undefined */
  async read(id: string): Promise<SharedCardFile | undefined> {
    if (!SAFE_ID.test(id)) return undefined;
    const file = this.fileOf(id);
    let mtime: number;
    try {
      mtime = (await this.fs.stat(file)).mtimeMs;
    } catch {
      this.lib.delete(id);
      return undefined;
    }
    const c = this.lib.get(id);
    if (c && c.mtime === mtime) return c.sc;
    try {
      const sc = loadSharedCard(JSON.parse(await this.fs.readFile(file)));
      sc.card.id = id; // 文件名说了算
      this.lib.set(id, { mtime, sc });
      return sc;
    } catch (e) {
      if (!this.bad.has(file)) {
        this.bad.add(file);
        this.log?.("error", `storage: unreadable shared card ${file}: ${e instanceof Error ? e.message : e}`);
      }
      return undefined;
    }
  }

  async write(sc: SharedCardFile) {
    const fs = this.fs;
    await fs.mkdir(this.dir());
    const file = this.fileOf(sc.card.id);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(sc, null, 1));
    await fs.rename(`${file}.tmp`, file);
    this.lib.set(sc.card.id, { mtime: (await fs.stat(file)).mtimeMs, sc });
  }

  /** The card as last read or written (no file access) */
  cached(id: string): SharedCardFile | undefined {
    return this.lib.get(id)?.sc;
  }
  forget(id: string) {
    this.lib.delete(id);
  }
  clear() {
    this.lib.clear();
  }
}
