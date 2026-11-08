// The host storage's Fs port over the shell's synchronous file system: the same Storage (packages/host/src/storage) that the VS
// Code extension runs, so the app writes, merges and trashes board files exactly as the extension does.
import type { Fs } from "@codeboard/host/storage";
import { isErr, type Native } from "./native";

const fail = (what: string, r: { error: string }) => Promise.reject(new Error(`${what}: ${r.error}`));
export const bytesToBase64 = (b: Uint8Array) => {
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
    fromBase64,
    sha1: (d) => n.sha1(bytesToBase64(d)),
  };
}

const B64 = new Uint8Array(128);
for (let i = 0; i < 64; i++) B64["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(i)] = i;
/** Straight into the bytes, no string in between (the CUDA grammar is 9 MB: through atob it was hundreds of MB of garbage) */
export function fromBase64(s: string): Uint8Array {
  let n = s.length;
  while (n > 0 && (s.charCodeAt(n - 1) === 61 || s.charCodeAt(n - 1) <= 32)) n--;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let acc = 0,
    bits = 0,
    j = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c > 127 || c <= 32) continue;
    acc = (acc << 6) | B64[c];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, j);
}
