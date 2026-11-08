// A Native for the tests: Node's file system, synchronously, and timers through Node's own
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { Native } from "../native";

export type Event = { name: string; data: unknown };

export function nodeNative(): Native & {
  events: Event[];
  replies: Map<number, unknown>;
  watchers: Map<number, string>;
} {
  const events: Event[] = [];
  const watchers = new Map<number, string>();
  let watchN = 1;
  const cams = new Map<string, string>();
  const wrap = <T>(fn: () => T) => {
    try {
      return fn();
    } catch (e) {
      return { error: (e as NodeJS.ErrnoException).code ?? String(e) };
    }
  };
  const n: Native & { events: Event[]; replies: Map<number, unknown>; watchers: Map<number, string> } = {
    events,
    replies: new Map(),
    watchers,
    readdir: (dir) =>
      wrap(() =>
        fs
          .readdirSync(dir, { withFileTypes: true })
          .map((d) => ({ name: d.name, isFile: d.isFile(), isDir: d.isDirectory() })),
      ),
    stat: (p) =>
      wrap(() => {
        const s = fs.statSync(p);
        return { mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs, ctimeMs: s.ctimeMs };
      }),
    readFile: (p) => wrap(() => fs.readFileSync(p, "utf8")),
    readBinary: (p) => wrap(() => fs.readFileSync(p).toString("base64")),
    writeFile: (p, data, base64) =>
      wrap(() => (fs.writeFileSync(p, base64 ? Buffer.from(data, "base64") : data), null)),
    rename: (a, b) => wrap(() => (fs.renameSync(a, b), null)),
    rm: (p) => wrap(() => (fs.rmSync(p, { force: true }), null)),
    rmdir: (p) => wrap(() => (fs.rmdirSync(p), null)),
    mkdir: (p) => wrap(() => (fs.mkdirSync(p, { recursive: true }), null)),
    camGet: (id) => cams.get(id) ?? null,
    camSet: (id, json) => void cams.set(id, json),
    sha1: (b64) => createHash("sha1").update(Buffer.from(b64, "base64")).digest("hex"),
    sha256: (text) => createHash("sha256").update(text).digest("hex"),
    readBase64: (p) => wrap(() => fs.readFileSync(p).toString("base64")),
    watch: (base) => {
      const id = watchN++;
      watchers.set(id, base);
      return id;
    },
    unwatch: (id) => void watchers.delete(id),
    choose: (_t, _o, _x, done) => done(null),
    now: () => performance.now(),
    emit: (name, json) => void events.push({ name, data: JSON.parse(json) }),
    // the bridge runs on Node's own timers in the tests (createBridge timers: false)
    setTimer: () => {},
    cancelTimer: () => {},
  };
  return n;
}
