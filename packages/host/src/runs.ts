// Capture Run：用户给一个 Python 入口（命令 / 脚本 + 参数），宿主跑一次，记下被调函数在 Study Scope 里的调用。
// 不改用户的工作区：在临时目录里放一个 sitecustomize.py，PYTHONPATH 指过去，Python 启动时自己装上 sys.setprofile 的抓取器；
// 进程退出时每个进程写一个 trace-<pid>.json，宿主合成一份运行记录（格式见 core/run.ts），存到 <存储目录>/runs/<id>.json。
// 多进程分开记、可调抓取范围还没做：子进程也会带上抓取器（同一个环境变量），记录合在一起。
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadRun, type CallSample, type RunCall, type RunLoc, type RunRecord } from "@codeboard/core";
import { git } from "./git";
import { log } from "./log";
import { readSettings } from "./settings";
import { locOfFile } from "./source";
import { hostPath, workspace, ws0, wsRoots } from "./ws";

/** 每个调用对留几次实参：前 FIRST 次 + 最后一次 */
const FIRST = 3;

/** 抓取器（装在临时目录的 sitecustomize.py 里）。只看 call 事件、被调函数的文件在 scope 里（或在 pkgs 列的包里）才记 */
export const TRACER = String.raw`# CodeBoard Capture Run: installed only for this run (PYTHONPATH), records calls into Study Scope.
import os, sys

def _codeboard_install():
    out = os.environ.get("CODEBOARD_TRACE_OUT")
    if not out:
        return
    import json, atexit, threading
    me = os.path.dirname(os.path.realpath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.realpath(p or ".") != me]
    norm = lambda p: os.path.normcase(os.path.realpath(p))
    scope = [norm(p) for p in json.loads(os.environ.get("CODEBOARD_TRACE_SCOPE", "[]"))]
    pkgs = set(json.loads(os.environ.get("CODEBOARD_TRACE_PKGS", "[]")))
    maxk = int(os.environ.get("CODEBOARD_TRACE_MAX", "5000"))
    first = ${FIRST}
    site = ("site-packages", "dist-packages")
    inscope, calls, real = {}, {}, {}
    state = {"truncated": False}

    def realf(f):
        r = real.get(f)
        if r is None:
            r = real[f] = norm(f) if f and not f.startswith("<") else f
        return r

    def ok(code):
        r = inscope.get(code)
        if r is None:
            r = False
            f = code.co_filename
            # <module>、<genexpr>、<listcomp>、<lambda> 不算调用
            # 类体也是一次 call 事件，但不是函数（没有 CO_OPTIMIZED）
            if f and not f.startswith("<") and not code.co_name.startswith("<") and code.co_flags & 0x01:
                a = realf(f)
                parts = a.replace("\\", "/").split("/")
                hit = [i for i, s in enumerate(parts) if s in site]
                if hit:
                    i = hit[-1]
                    r = i + 1 < len(parts) and parts[i + 1].split(".")[0] in pkgs
                else:
                    r = any(a == s or a.startswith(s + os.sep) for s in scope)
            inscope[code] = r
        return r

    def short(x):
        try:
            if hasattr(x, "shape") and hasattr(x, "dtype") and not isinstance(x, type):
                s = "%s%s %s" % (type(x).__name__, list(int(d) for d in x.shape), str(x.dtype).replace("torch.", ""))
                dev = getattr(x, "device", None)
                return s + (" %s" % dev if dev is not None and str(dev) != "cpu" else "")
            if x is None or isinstance(x, (bool, int, float, complex, str, bytes)):
                r = repr(x)
                return r if len(r) <= 48 else r[:47] + "\u2026"
            if isinstance(x, (list, tuple, set, frozenset, dict)):
                return "%s \u00b7 len %d" % (type(x).__name__, len(x))
            return type(x).__name__
        except Exception:
            return "?"

    def sample(frame, code, n):
        names = list(code.co_varnames[: code.co_argcount + code.co_kwonlyargcount])
        if code.co_flags & 0x04:
            names.append(code.co_varnames[len(names)])
        if code.co_flags & 0x08:
            names.append(code.co_varnames[len(names)])
        loc = frame.f_locals
        return {"n": n, "args": [[k, short(loc.get(k))] for k in names if k not in ("self", "cls") and k in loc]}

    def prof(frame, event, arg):
        if event != "call":
            return
        code = frame.f_code
        if not ok(code):
            return
        back = frame.f_back
        if back is None:
            return
        key = (back.f_code.co_filename, back.f_lineno, code)
        e = calls.get(key)
        if e is None:
            if len(calls) >= maxk:
                state["truncated"] = True
                return
            e = calls[key] = [0, [], None]
        e[0] += 1
        n = e[0]
        if n <= first:
            e[1].append(sample(frame, code, n))
        else:
            e[2] = sample(frame, code, n)

    def qual(code):
        return getattr(code, "co_qualname", code.co_name)

    def dump():
        sys.setprofile(None)
        threading.setprofile(None)
        rows = []
        for (ff, fl, code), (cnt, smp, last) in list(calls.items()):
            rows.append({"from": {"file": realf(ff), "line": fl}, "to": {"file": realf(code.co_filename), "line": code.co_firstlineno, "qual": qual(code)},
                         "count": cnt, "samples": smp + ([last] if last else [])})
        try:
            with open(os.path.join(out, "trace-%d.json" % os.getpid()), "w") as f:
                json.dump({"pid": os.getpid(), "calls": rows, "truncated": state["truncated"]}, f)
        except Exception as e:
            sys.stderr.write("codeboard: could not write the trace: %s\n" % e)

    atexit.register(dump)
    threading.setprofile(prof)
    sys.setprofile(prof)
    # the user's own sitecustomize (if any) still runs
    try:
        import importlib.machinery, importlib.util
        spec = importlib.machinery.PathFinder.find_spec("sitecustomize", sys.path)
        if spec and spec.origin and norm(os.path.dirname(spec.origin)) != norm(me):
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
    except Exception:
        pass

_codeboard_install()
del _codeboard_install
`;

/** 命令行按空格切开（单双引号里的空格不切） */
export function splitCmd(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? m[3]);
  return out;
}

/** 用户给的入口 → 要跑的 argv：python … 原样；脚本 / -m / -c 前面补解释器；别的命令（pytest、torchrun）原样（它们自己起 Python，同样带上抓取器） */
export function toArgv(cmd: string, python: string): string[] {
  const a = splitCmd(cmd.trim());
  if (!a.length) return [];
  if (/^python[\d.]*(\.exe)?$/i.test(path.basename(a[0]))) return a;
  if (/\.py$/i.test(a[0]) || a[0] === "-m" || a[0] === "-c") return [python, ...a];
  return a;
}

export type CaptureOpts = {
  cmd: string; cwd: string;
  /** 算 Study Scope 的根目录（工作区的根）和包名（设置里的 studyScope） */
  scope: string[]; pkgs: string[];
  python?: string; timeoutMs?: number;
  /** 子进程的输出（写到 Output 面板） */
  out?: (s: string) => void;
};

type Trace = { pid: number; calls: RunCall[]; truncated?: boolean };

/** 几个进程的记录合成一份：同一对 from → to 次数相加，实参留前 FIRST 次 + 最后一次 */
export function mergeTraces(ts: Trace[]): { calls: RunCall[]; truncated: boolean } {
  const m = new Map<string, RunCall>();
  for (const t of ts) for (const c of t.calls) {
    const k = `${c.from.file}:${c.from.line}>${c.to.file}:${c.to.line}:${c.to.qual}`;
    const o = m.get(k);
    if (!o) { m.set(k, { ...c, samples: [...c.samples] }); continue; }
    const base = o.count;
    o.count += c.count;
    const all: CallSample[] = [...o.samples, ...c.samples.map((s) => ({ ...s, n: s.n + base }))];
    o.samples = all.length > FIRST + 1 ? [...all.slice(0, FIRST), all[all.length - 1]] : all;
  }
  return { calls: [...m.values()].sort((a, b) => b.count - a.count), truncated: ts.some((t) => t.truncated) };
}

const rid = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 跑一次入口，回运行记录（还没存）。命令起不来时抛出；退出码不是 0 也回记录（exit 里记着），抓到多少算多少 */
export async function captureRun(o: CaptureOpts): Promise<RunRecord> {
  const python = o.python || "python3";
  const argv = toArgv(o.cmd, python);
  if (!argv.length) throw new Error("No command given.");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeboard-run-"));
  const boot = path.join(tmp, "boot"), out = path.join(tmp, "out");
  await fs.mkdir(boot); await fs.mkdir(out);
  await fs.writeFile(path.join(boot, "sitecustomize.py"), TRACER);
  const env = {
    ...process.env,
    PYTHONPATH: [boot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    CODEBOARD_TRACE_OUT: out, CODEBOARD_TRACE_SCOPE: JSON.stringify(o.scope), CODEBOARD_TRACE_PKGS: JSON.stringify(o.pkgs),
  };
  const t0 = Date.now();
  try {
    const exit = await new Promise<number>((res, rej) => {
      const p = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { o.out?.(`Timed out after ${Math.round((o.timeoutMs ?? 120_000) / 1000)} s; stopping.\n`); p.kill("SIGINT"); setTimeout(() => p.kill("SIGKILL"), 3000); }, o.timeoutMs ?? 120_000);
      p.stdout.on("data", (d) => o.out?.(String(d)));
      p.stderr.on("data", (d) => o.out?.(String(d)));
      p.on("error", (e) => { clearTimeout(timer); rej(new Error(`Could not start ${argv[0]}: ${e.message}`)); });
      p.on("close", (code) => { clearTimeout(timer); res(code ?? -1); });
    });
    const ts: Trace[] = [];
    for (const f of await fs.readdir(out)) {
      if (!/^trace-\d+\.json$/.test(f)) continue;
      try { ts.push(JSON.parse(await fs.readFile(path.join(out, f), "utf8"))); } catch { /* 进程被杀时写了一半 */ }
    }
    const m = mergeTraces(ts);
    const commit = (await git(o.cwd, ["rev-parse", "HEAD"]))?.trim() || null;
    const rec: RunRecord = { version: 1, id: rid(), entry: o.cmd.trim(), cwd: o.cwd, commit, at: t0, ms: Date.now() - t0, exit, scope: o.scope, pkgs: o.pkgs, calls: m.calls };
    if (m.truncated) rec.truncated = true;
    return loadRun(rec);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const runsDir = (storageDir: string) => path.join(storageDir, "runs");

export async function saveRun(storageDir: string, r: RunRecord): Promise<string> {
  const d = runsDir(storageDir);
  await fs.mkdir(d, { recursive: true });
  const f = path.join(d, `${r.id}.json`);
  await fs.writeFile(f, JSON.stringify(r, null, 1));
  return f;
}

/** 存着的运行记录，新的在前（读不懂的跳过） */
export async function listRuns(storageDir: string): Promise<RunRecord[]> {
  const d = runsDir(storageDir);
  let names: string[] = [];
  try { names = (await fs.readdir(d)).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out: RunRecord[] = [];
  for (const n of names) {
    try { out.push(loadRun(JSON.parse(await fs.readFile(path.join(d, n), "utf8")))); } catch { /* 坏文件 */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** 运行记录里出现的文件 → 白板上的位置（来源 + 相对路径），白板拿它对箭头 */
export async function runLocs(r: RunRecord): Promise<Record<string, RunLoc>> {
  const files = new Set<string>();
  for (const c of r.calls) { files.add(c.from.file); files.add(c.to.file); }
  const out: Record<string, RunLoc> = {};
  for (const f of files) {
    if (!path.isAbsolute(f)) continue;
    const l = await locOfFile(f);
    out[f] = { src: l.src, path: l.path, hp: hostPath(f) };
  }
  return out;
}

export function runLabel(r: RunRecord): { label: string; description: string; detail: string } {
  const d = new Date(r.at);
  const when = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const n = r.calls.reduce((s, c) => s + c.count, 0);
  return { label: r.entry, description: `${when}${r.commit ? ` · ${r.commit.slice(0, 7)}` : ""}`, detail: `${r.calls.length} call sites · ${n} calls${r.exit ? ` · exit ${r.exit}` : ""}` };
}

/** 发给白板的那一份（白板只要记录 + 路径对照） */
export async function runApply(r: RunRecord) { return { run: r, locs: await runLocs(r) }; }

type Target = { post(m: { type: "run"; apply: Awaited<ReturnType<typeof runApply>> } | { type: "toast"; text: string }): void };

/** 问入口、跑一次、存下来、发给白板（没有白板就只存） */
export async function captureFlow(storageDir: string, p: Target | undefined): Promise<RunRecord | undefined> {
  const w = workspace();
  const last = w.storage.get<string>("codeboard.lastRun");
  const cmd = await w.ui.input({ prompt: "Run a Python entry once and record the calls into Study Scope (script or -m module, with arguments)", value: last ?? "", placeHolder: "example.py --steps 2   ·   -m mypkg.main" });
  if (!cmd?.trim()) return;
  await w.storage.set("codeboard.lastRun", cmd.trim());
  const interp = w.settings.get<string>("python.defaultInterpreterPath");
  p?.post({ type: "toast", text: `Running ${cmd.trim()} …` });
  log("info", `Capture Run: ${cmd.trim()}`);
  let rec: RunRecord;
  try {
    rec = await captureRun({ cmd, cwd: ws0(), scope: wsRoots(), pkgs: readSettings().studyScope, python: interp && interp !== "python" ? interp : undefined, out: (s) => log("info", s.replace(/\n$/, "")) });
  } catch (e) {
    void w.ui.info(`Capture Run failed: ${(e as Error).message}`);
    return;
  }
  await saveRun(storageDir, rec);
  if (!rec.calls.length) void w.ui.info(`The run finished (exit ${rec.exit}) but recorded no calls into Study Scope. See Output › CodeBoard.`);
  if (p) p.post({ type: "run", apply: await runApply(rec) });
  return rec;
}

export async function applyFlow(storageDir: string, p: Target | undefined) {
  const w = workspace();
  if (!p) { void w.ui.info("Open a board first."); return; }
  const rs = await listRuns(storageDir);
  if (!rs.length) { void w.ui.info("No runs yet. Use CodeBoard: Capture Run… first."); return; }
  const r = await w.ui.pick(rs.map((x) => ({ ...runLabel(x), r: x })), { placeHolder: "Apply which run to this board?" });
  if (r) p.post({ type: "run", apply: await runApply(r.r) });
}
