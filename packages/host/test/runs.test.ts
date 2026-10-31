import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunRecord } from "@codeboard/core";
import { captureRun, listRuns, runApply, saveRun } from "../src/runs";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { git } from "./helpers";

const FIX = fs.mkdtempSync("/tmp/codeboard-run-");
const SD = fs.mkdtempSync("/tmp/codeboard-store-");
let rec: RunRecord, head: string, before: string;

beforeAll(async () => {
  fs.cpSync(path.join(__dirname, "fixtures/runtime"), FIX, { recursive: true });
  git(FIX, "init", "-q");
  git(FIX, "add", "-A");
  git(FIX, "commit", "-qm", "fixture");
  head = git(FIX, "rev-parse", "HEAD");
  useWorkspace(nodeWorkspace(FIX));
  before = fs.readdirSync(FIX).sort().join(",");
  rec = await captureRun({ cmd: "run.py 2", cwd: FIX, scope: [FIX], pkgs: [] });
});
afterAll(() => {
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.rmSync(SD, { recursive: true, force: true });
});

describe("Capture Run", () => {
  it("records exit 0, the commit and the command", () => {
    expect({ exit: rec.exit, commit: rec.commit, entry: rec.entry }).toEqual({
      exit: 0,
      commit: head,
      entry: "run.py 2",
    });
  });
  it("records only function calls in scope: no <genexpr>/<module>, no class bodies, no stdlib", () => {
    const quals = new Set(rec.calls.map((c) => c.to.qual));
    expect(quals).toContain("Scheduler.schedule");
    expect(quals).toContain("ModelRunner.run");
    expect([...quals].filter((q) => q.startsWith("<") || q === "Tensor")).toEqual([]);
    expect(rec.calls.filter((c) => !c.from.file.startsWith(FIX) || !c.to.file.startsWith(FIX))).toEqual([]);
  });
  it("records the call site file:line and count", () => {
    const sch = rec.calls.find((c) => c.to.qual === "Scheduler.schedule");
    expect({ file: sch?.from.file, line: sch?.from.line, count: sch?.count }).toEqual({
      file: path.join(FIX, "toyllm/engine.py"),
      line: 11,
      count: 2,
    });
  });
  it("shows tensor-like values as Type[shape] dtype and leaves self out", () => {
    const smp = rec.calls.find((c) => c.to.qual === "ModelRunner.sample");
    expect(smp?.samples[0].args).toContainEqual(["logits", "Tensor[10, 64] float16"]);
    const run = rec.calls.find((c) => c.to.qual === "ModelRunner.run");
    expect(run?.samples[0].args.map(([k]) => k)).not.toContain("self");
  });
  it("writes nothing into the workspace", () => {
    expect(fs.readdirSync(FIX).sort().join(",")).toBe(before);
  });
  it("saves the record under <storageDir>/runs/ and reads it back through the schema", async () => {
    expect(await saveRun(SD, rec)).toBe(path.join(SD, "runs", `${rec.id}.json`));
    expect((await listRuns(SD))[0]?.id).toBe(rec.id);
  });
  it("maps absolute files to workspace-relative paths", async () => {
    const a = await runApply(rec);
    expect(a.locs[path.join(FIX, "toyllm/engine.py")]?.path).toBe("toyllm/engine.py");
  });
  it("still returns a record with its exit code when the command fails", async () => {
    const bad = await captureRun({ cmd: '-c "raise SystemExit(3)"', cwd: FIX, scope: [FIX], pkgs: [] });
    expect({ exit: bad.exit, calls: bad.calls.length }).toEqual({ exit: 3, calls: 0 });
  });
});
