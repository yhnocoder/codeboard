// The client of box, the per-user index service (src/*.rs, PROTOCOL.md). connect() starts the service from its binary when no
// service is listening (detached: it outlives this process and exits by itself when no one has used it for a while), says
// hello with the token from its data folder, and connects again when the service has gone since.
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export type BoxImage = {
  /** The image's content hash: one vector per key */
  key: string;
  /** data:image/…;base64,…; none: not embedded until a sync brings it */
  url?: string;
};
export type BoxItem = {
  id: string;
  /** The item's own title (not where it sits: moving it would embed it again) */
  title: string;
  text: string;
  /** What a search can be narrowed to (CodeBoard: the boards the item is on) */
  groups?: string[];
  /** Handed back with hits */
  meta?: unknown;
  images?: BoxImage[];
};
/** An OpenAI-compatible embedding endpoint; the key stays in the service's memory */
export type BoxEmbedder = { base: string; model?: string; key?: string };
export type BoxHit = {
  id: string;
  score: number;
  /** Which of the item's pieces matched: 0 the whole item, then its paragraphs, then its images */
  piece: number;
  /** A text piece: where it is in the item's text (UTF-16 offsets, as String.slice takes them) */
  range?: [number, number];
  /** An image piece: its key */
  picture?: string;
  meta?: unknown;
};
export type BoxSearch = {
  source: string;
  ref: string;
  q: string;
  k?: number;
  /** Only items in any of these groups */
  groups?: string[];
  min_score?: number;
};
export type BoxResult = {
  hits: BoxHit[];
  /** Pieces still to embed for this manifest */
  left: number;
  /** The last indexing error, or why this search failed */
  error?: string;
  /** The service has no embedder for this source yet (it started since the last sync): sync, then ask again */
  unsynced?: true;
  /** The model fingerprint the scores come from */
  model?: string;
  source: string;
  ref: string;
};
export type BoxStatus = {
  items: number;
  pieces: number;
  vectors?: number;
  model?: string;
  left: number;
  indexing: boolean;
  error?: string;
  synced: boolean;
};

export type BoxClient = {
  /** The whole set of items of a source at a ref; answers at once, indexing goes on in the service */
  sync(source: string, ref: string, embedder: BoxEmbedder, items: BoxItem[]): Promise<{ accepted: number }>;
  search(q: BoxSearch): Promise<BoxResult>;
  status(source: string, ref: string): Promise<BoxStatus>;
  forget(source: string): Promise<void>;
  /** The service's process id (one per data folder, whoever started it) */
  pid(): Promise<number>;
  close(): void;
};

/** How long connect waits for a service it started to listen */
const START_WAIT = 15_000;
/** First pause between tries to connect to a starting service (doubles up to 200 ms) */
const FIRST_TRY = 10;

/** The binary for this platform in a folder of bin/<platform>-<arch>/box[.exe] (packages/box/bin, the extension's bin) */
export function binIn(dir: string): string {
  return path.join(dir, `${process.platform}-${process.arch}`, process.platform === "win32" ? "box.exe" : "box");
}

type Paths = { home: string; socket: string; token: string };
type Conn = { sock: net.Socket; pid: number; send(op: string, body: object): Promise<unknown> };

/** The service's answer could not come: the connection closed first (the request is tried again on a new one) */
class Lost extends Error {}

export function connect(o: { bin: string; home?: string; idle?: number }): BoxClient {
  const env = { ...process.env, ...(o.home ? { BOX_HOME: o.home } : {}) };
  let paths: Promise<Paths> | undefined;
  let conn: Promise<Conn> | undefined;
  let closed = false;

  const where = () =>
    (paths ??= new Promise<Paths>((resolve, reject) =>
      execFile(o.bin, ["home"], { env, windowsHide: true }, (err, out) =>
        err ? reject(new Error(`Cannot run box (${o.bin}): ${err.message}`)) : resolve(JSON.parse(out) as Paths),
      ),
    ).catch((e) => {
      paths = undefined;
      throw e;
    }));

  const dial = (socket: string) =>
    new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(socket);
      s.once("connect", () => {
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", reject);
    });

  const start = () => {
    if (process.platform !== "win32")
      try {
        fs.accessSync(o.bin, fs.constants.X_OK);
      } catch {
        fs.chmodSync(o.bin, 0o755); // a .vsix does not keep the executable bit
      }
    const args = ["serve", ...(o.idle ? ["--idle", String(o.idle)] : [])];
    const p = spawn(o.bin, args, { env, detached: true, stdio: "ignore", windowsHide: true });
    p.on("error", () => {}); // a binary that cannot start shows as a service that never listens
    p.unref();
  };

  const open = async (): Promise<Conn> => {
    const p = await where();
    let sock: net.Socket;
    try {
      sock = await dial(p.socket);
    } catch {
      start();
      const until = Date.now() + START_WAIT;
      for (let pause = FIRST_TRY; ; pause = Math.min(200, pause * 2)) {
        try {
          sock = await dial(p.socket);
          break;
        } catch (e) {
          if (Date.now() > until) throw new Error(`box did not start (${(e as Error).message})`);
          await new Promise((r) => setTimeout(r, pause));
        }
      }
    }
    const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    let n = 0,
      buf = "";
    sock.setEncoding("utf8");
    sock.unref();
    sock.on("data", (d: string) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        const w = waiting.get(m.id);
        if (!w) continue;
        waiting.delete(m.id);
        if (m.error !== undefined) w.reject(new Error(m.error));
        else w.resolve(m.result);
        if (!waiting.size) sock.unref();
      }
    });
    const lost = () => {
      for (const w of waiting.values()) w.reject(new Lost("box closed the connection"));
      waiting.clear();
      conn = undefined;
    };
    sock.on("close", lost);
    sock.on("error", lost);
    const send = (op: string, body: object) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++n;
        waiting.set(id, { resolve, reject });
        sock.ref();
        sock.write(`${JSON.stringify({ ...body, id, op })}\n`);
      });
    const token = fs.readFileSync(p.token, "utf8").trim();
    const hello = (await send("hello", { token })) as { pid: number };
    return { sock, pid: hello.pid, send };
  };

  const ready = () => {
    if (closed) return Promise.reject(new Error("box client closed"));
    return (conn ??= open().catch((e) => {
      conn = undefined;
      throw e;
    }));
  };

  /** A request; one the connection dropped (the service exited) is sent again once on a new connection */
  const ask = async <T>(op: string, body: object): Promise<T> => {
    try {
      return (await (await ready()).send(op, body)) as T;
    } catch (e) {
      if (!(e instanceof Lost)) throw e;
      return (await (await ready()).send(op, body)) as T;
    }
  };

  return {
    sync: (source, ref, embedder, items) => ask("sync", { source, ref, embedder, items }),
    search: (q) => ask("search", q),
    status: (source, ref) => ask("status", { source, ref }),
    forget: (source) => ask("forget", { source }),
    pid: async () => (await ready()).pid,
    close() {
      closed = true;
      void conn?.then(
        (c) => c.sock.destroy(),
        () => {},
      );
      conn = undefined;
    },
  };
}
