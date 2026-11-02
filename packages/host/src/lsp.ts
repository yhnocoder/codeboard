// Requests to the editor's language service: Go to Definition and Go to Implementation, shared through the definition cache,
// and waiting for a language service that is still starting (Pylance answers empty at first).
import { sharedDefs, type Def } from "./defcache";
import { log } from "./log";
import { sleep } from "./sched";
import { hostPath, langOf, workspace } from "./ws";

/** Asks the language service (requests for the same file, position and content are shared: a hover may be asking already) */
export const lspDefs = (abs: string, line: number, col: number): Promise<Def[]> =>
  sharedDefs(abs, line, col, () => askDefs(abs, line, col));

/** Go to Implementation at a definition (Pylance searches the whole workspace for subclasses, seconds when cold) */
export const lspImpls = (d: Def): Promise<Def[]> =>
  sharedDefs(
    d.abs,
    d.line,
    d.col,
    async () => {
      const t0 = performance.now();
      const r = await workspace().language.implementations(d.abs, d.line, d.col);
      log(
        "info",
        `implementations at ${hostPath(d.abs)}:${d.line} → ${r.length}, ${Math.round(performance.now() - t0)} ms`,
      );
      return r;
    },
    "impl",
  );

let seen = false;
async function askDefs(abs: string, line: number, col: number): Promise<Def[]> {
  try {
    const r = await workspace().language.definitions(abs, line, col);
    if (r.length) seen = true;
    return r.filter((d) => !(d.abs === abs && d.line === line)); // points back at the call itself
  } catch (e) {
    log("warn", `definition provider failed at ${hostPath(abs)}:${line}:${col}: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/** Between two asks while the language service starts */
export const RETRY_GAP = 600;
/** How long a click waits for a starting language service before it falls back to the name index */
const CLICK_LSP_WAIT = 3 * RETRY_GAP;
/** How many clicks wait for it: after that an empty answer is taken as the answer */
const CLICK_WAITS = 3;
let clickWaits = 0;

/**
 * The language service gave `first` (empty) and may still be starting, as long as it has never answered anything: asks
 * again every RETRY_GAP until it answers, it answers another request, `wait` ms are up or alive() turns false
 */
export async function lspReady(
  first: Def[],
  ask: () => Promise<Def[]>,
  wait: number,
  alive = () => true,
): Promise<Def[]> {
  let d = first;
  for (let k = 0; !d.length && !seen && k < Math.round(wait / RETRY_GAP) && alive(); k++) {
    await sleep(RETRY_GAP);
    d = await ask();
  }
  return d;
}

/** Definitions for a click: when Pylance looks like it is still starting (installed, never answered), waits for it */
export async function clickDefs(abs: string, line: number, col: number): Promise<Def[]> {
  const d = await lspDefs(abs, line, col);
  if (
    d.length ||
    seen ||
    clickWaits >= CLICK_WAITS ||
    langOf(abs) !== "python" ||
    !workspace().about.hasExtension("ms-python.vscode-pylance")
  )
    return d;
  clickWaits++;
  const r = await lspReady(d, () => lspDefs(abs, line, col), CLICK_LSP_WAIT);
  if (r.length)
    log("info", `definition at ${hostPath(abs)}:${line}:${col} answered after retry (language server starting)`);
  return r;
}

/** Tests: as if the language service never answered */
export const forgetLspSeen = () => {
  seen = false;
  clickWaits = 0;
};
