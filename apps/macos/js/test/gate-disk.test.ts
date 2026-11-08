import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diskStop, dropCaptures, freeGB, hitchesRecord, sizeGB } from "../../../../tools/mac-gate-disk.mjs";

describe("the macOS gate's disk guards", () => {
  const lim = { minFree: 8, maxOut: 1 };
  it("stops under the free-space floor and over the output cap, and not otherwise", () => {
    expect(diskStop({ free: 7.9, used: 0 }, lim)).toMatch(/7\.9 GB free.*8 GB/);
    expect(diskStop({ free: 50, used: 1.2 }, lim)).toMatch(/1\.20 GB.*cap is 1 GB/);
    expect(diskStop({ free: 8, used: 1 }, lim)).toBeNull();
  });

  it("records the Hitches instrument alone, with a time limit", () => {
    const a = hitchesRecord(42, "/x/hitches.trace", 180);
    expect(a.slice(0, 2)).toEqual(["xctrace", "record"]);
    expect(a[a.indexOf("--instrument") + 1]).toBe("Hitches");
    expect(a).not.toContain("--template");
    expect(a[a.indexOf("--time-limit") + 1]).toBe("180s");
    expect(a[a.indexOf("--attach") + 1]).toBe("42");
  });

  it("measures a folder, reads free space, and drops capture folders but keeps fails/ and the files", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gate-disk-"));
    try {
      for (const s of ["pan", "drag_card", "fails"]) fs.mkdirSync(path.join(d, s));
      fs.writeFileSync(path.join(d, "pan", "000.jpg"), Buffer.alloc(1 << 20));
      fs.writeFileSync(path.join(d, "fails", "pan-flash-003.jpg"), "x");
      fs.writeFileSync(path.join(d, "run.json"), "{}");
      expect(sizeGB(d) * 2 ** 30).toBe((1 << 20) + 3);
      expect(sizeGB(path.join(d, "missing"))).toBe(0);
      expect(freeGB(d)).toBeGreaterThan(0);
      dropCaptures(d);
      expect(fs.readdirSync(d).sort()).toEqual(["fails", "run.json"]);
      expect(fs.readdirSync(path.join(d, "fails"))).toEqual(["pan-flash-003.jpg"]);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
