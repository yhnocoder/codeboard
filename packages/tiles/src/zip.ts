// One zip per board: stored, not deflated (WebP is compressed already, and the app reads each tile straight out of the file)
import { zipSync } from "fflate";

export const storedZip = (files: Map<string, Uint8Array>): Uint8Array =>
  zipSync(
    Object.fromEntries(
      [...files].sort(([a], [b]) => (a === "manifest.json" ? -1 : b === "manifest.json" ? 1 : a < b ? -1 : 1)),
    ),
    {
      level: 0,
      mtime: new Date("2000-01-01T00:00:00Z"),
    },
  );
