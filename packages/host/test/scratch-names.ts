// Scratch file naming and crash cleanup (src/scratchnames.ts): only exact .codeboard-scratch-<id>.<ext> names that are
// not ours and whose mtime is older than STALE_MS get deleted. Usage: node packages/host/test/run-scratch-names.mjs
import { HEARTBEAT_MS, STALE_MS, isScratchName, isStale, scratchName, staleScratch } from "../src/scratchnames";

let failed = 0;
const check = (ok: unknown, what: string, extra?: unknown) => { console.log(`${ok ? "✓" : "✗"} ${what}${!ok && extra !== undefined ? "  " + JSON.stringify(extra) : ""}`); if (!ok) failed++; };

const now = Date.UTC(2026, 9, 18, 12);
const fresh = now - 30_000, stale = now - STALE_MS - 1;

check(scratchName("c:12/x", "python") === ".codeboard-scratch-c_12_x.py" && scratchName("k", "markdown") === ".codeboard-scratch-k.txt", "scratchName sanitizes the id and maps the language to an extension");
for (const n of [scratchName("c:12/x", "python"), scratchName("k", "markdown"), scratchName("a-b_c", "cuda-cpp")]) check(isScratchName(n), `${n} is a scratch name`);
for (const n of [".codeboard-notes.md", ".codeboard-config", ".codeboard-ref", ".codeboard-scratch-x.md", ".codeboard-scratch-.py", ".codeboard-scratch-a.b.py", ".codeboard-scratch-x.py.bak", "x.codeboard-scratch-x.py", ".codeboard-x.py"])
  check(!isScratchName(n), `${n} is not a scratch name`);
check(!isStale(fresh, now) && !isStale(now - STALE_MS, now) && isStale(stale, now), "isStale: only older than STALE_MS");
check(HEARTBEAT_MS * 5 <= STALE_MS, "the heartbeat runs several times within the stale window");

const entries = [
  { name: ".codeboard-scratch-x.py", mtimeMs: fresh },       // another window is editing it
  { name: ".codeboard-scratch-old.py", mtimeMs: stale },     // left behind by a crash
  { name: ".codeboard-scratch-mine.py", mtimeMs: stale },    // this process's own file
  { name: ".codeboard-notes.md", mtimeMs: stale },           // user files
  { name: ".codeboard-config", mtimeMs: stale },
  { name: ".codeboard-ref", mtimeMs: stale },
  { name: "llm_engine.py", mtimeMs: stale },
];
const del = staleScratch(entries, now, (n) => n === ".codeboard-scratch-mine.py");
check(!del.includes(".codeboard-scratch-x.py"), "a fresh .codeboard-scratch-x.py from another window is kept", del);
check(del.includes(".codeboard-scratch-old.py"), "a stale .codeboard-scratch-old.py is deleted", del);
check(!del.includes(".codeboard-scratch-mine.py"), "this process's own live file is kept even if old", del);
check(!del.includes(".codeboard-notes.md") && !del.includes(".codeboard-config") && !del.includes(".codeboard-ref"), "user files .codeboard-notes.md / .codeboard-config / .codeboard-ref are kept", del);
check(del.length === 1, "nothing else is deleted", del);

console.log(failed ? `${failed} checks failed` : "all passed");
process.exit(failed ? 1 : 0);
