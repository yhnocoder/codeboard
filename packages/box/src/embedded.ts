// box inside this Node process: the addon (node/src/lib.rs, which build.mjs puts in node/bin/<platform>-<arch>/box.node), for a
// tool that is one process. The same index and requests as the service (PROTOCOL.md) without the socket; one process per data
// folder may have it open. CodeBoard uses the service instead (connect in index.ts): every VS Code window is a process.
import { createRequire } from "node:module";
import * as path from "node:path";
import type { BoxEmbedder, BoxItem, BoxResult, BoxSearch, BoxStatus } from "./index";

type Addon = {
  BoxIndex: { open(home: string): { request(op: string, body: string): Promise<string>; close(): void } };
};

export type BoxIndex = {
  /** The whole set of items of a source at a ref; answers at once, indexing goes on in background threads */
  sync(source: string, ref: string, embedder: BoxEmbedder, items: BoxItem[]): Promise<{ accepted: number }>;
  search(q: BoxSearch): Promise<BoxResult>;
  status(source: string, ref: string): Promise<BoxStatus>;
  forget(source: string): Promise<void>;
  /** Background indexing stops after its current batch; the data folder is free for another process after that */
  close(): void;
};

/** The addon for this platform in a folder of <platform>-<arch>/box.node (packages/box/node/bin) */
export function addonIn(dir: string): string {
  return path.join(dir, `${process.platform}-${process.arch}`, "box.node");
}

/** Opens the index in the data folder `home` (made if missing); throws when another process has it open */
export function open(o: { addon: string; home: string }): BoxIndex {
  const addon = createRequire(import.meta.url)(o.addon) as Addon;
  const index = addon.BoxIndex.open(o.home);
  const ask = async <T>(op: string, body: object): Promise<T> =>
    JSON.parse(await index.request(op, JSON.stringify(body)));
  return {
    sync: (source, ref, embedder, items) => ask("sync", { source, ref, embedder, items }),
    search: (q) => ask("search", q),
    status: (source, ref) => ask("status", { source, ref }),
    forget: async (source) => void (await ask("forget", { source })),
    close: () => index.close(),
  };
}
