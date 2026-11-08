// Opening and looking at a board writes nothing: every file of a real project's storage folder is byte for byte what it was after
// every board was opened through the bridge, the camera came to rest (what the window does on open) and the app flushed on close.
// Runs on a copy of CODEBOARD_BOARDS (default ~/Projects/persona/.codeboard, where there is one); the repository's own test boards
// (examples/nano-vllm) are not in a storage folder, so without one it is skipped
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createBridge } from "../bridge";
import { nodeNative } from "./node-native";

const source = process.env.CODEBOARD_BOARDS ?? path.join(os.homedir(), "Projects/persona/.codeboard");

function hashes(dir: string) {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = createHash("sha1").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

describe.skipIf(!fs.existsSync(source))("opening a project's boards", () => {
  it("leaves every file byte for byte as it was", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-open-"));
    fs.cpSync(source, dir, { recursive: true });
    const before = hashes(dir);
    const native = nodeNative();
    const folder = createBridge(native, { timers: false }).folder(dir);
    const list = await folder.list();
    expect(list.length).toBeGreaterThan(0);
    for (const m of list) {
      const s = (await folder.open(m.id))!;
      const sc = await s.scene();
      expect(sc.id).toBe(m.id);
      s.cam(sc.cam);
      await s.changes();
    }
    await folder.flush();
    // the live save's delay (the camera) and Storage's write queue
    await new Promise((r) => setTimeout(r, 1200));
    await folder.flush();
    const after = hashes(dir);
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    expect(changed, `files written by opening: ${changed.join(", ")}`).toEqual([]);
    expect(native.events.filter((e) => e.name === "toast")).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
