// The host storage's Fs port over the shell's synchronous file system: the same Storage (packages/host/src/storage) that the VS
// Code extension runs, so the app writes, merges and trashes board files exactly as the extension does.
import type { Fs } from "@codeboard/host/storage";
import { isErr, type Native } from "./native";

const fail = (what: string, r: { error: string }) => Promise.reject(new Error(`${what}: ${r.error}`));
const bytesToBase64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export function nativeFs(n: Native): Fs {
  const done = (what: string, r: null | { error: string }) => (r ? fail(what, r) : Promise.resolve());
  return {
    readdir: (dir) => {
      const r = n.readdir(dir);
      return isErr(r) ? fail(dir, r) : Promise.resolve(r);
    },
    stat: (p) => {
      const r = n.stat(p);
      return isErr(r) ? fail(p, r) : Promise.resolve(r);
    },
    readFile: (p) => {
      const r = n.readFile(p);
      return isErr(r) ? fail(p, r) : Promise.resolve(r);
    },
    writeFile: (p, data) =>
      done(p, typeof data === "string" ? n.writeFile(p, data, false) : n.writeFile(p, bytesToBase64(data), true)),
    rename: (a, b) => done(a, n.rename(a, b)),
    rm: (p) => done(p, n.rm(p)),
    rmdir: (p) => done(p, n.rmdir(p)),
    mkdir: (p) => done(p, n.mkdir(p)),
    join: (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/"),
    fromBase64: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
    sha1: (d) => n.sha1(bytesToBase64(d)),
  };
}
