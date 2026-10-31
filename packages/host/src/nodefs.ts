import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Fs } from "@codeboard/core/storage";

export const nodeFs: Fs = {
  readdir: async (dir) =>
    (await fs.readdir(dir, { withFileTypes: true })).map((d) => ({
      name: d.name,
      isFile: d.isFile(),
      isDir: d.isDirectory(),
    })),
  stat: (p) => fs.stat(p),
  readFile: (p) => fs.readFile(p, "utf8"),
  writeFile: (p, data) => fs.writeFile(p, data),
  rename: (a, b) => fs.rename(a, b),
  rm: (p) => fs.rm(p, { force: true }),
  rmdir: (p) => fs.rmdir(p),
  mkdir: async (p) => void (await fs.mkdir(p, { recursive: true })),
  join: (...p) => path.join(...p),
  fromBase64: (s) => Buffer.from(s, "base64"),
  sha1: (d) => createHash("sha1").update(d).digest("hex"),
};
