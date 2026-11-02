// Requests to the editor's language service: Go to Definition and Go to Implementation, shared through the definition cache,
// and waiting for a language service that is still starting (Pylance answers empty at first).
import type { HostContext } from "./context";
import type { Def } from "./defcache";
import { sleep } from "./sched";

/** Between two asks while the language service starts */
export const RETRY_GAP = 600;
/** How long a click waits for a starting language service before it falls back to the name index */
const CLICK_LSP_WAIT = 3 * RETRY_GAP;
/** How many clicks wait for it: after that an empty answer is taken as the answer */
const CLICK_WAITS = 3;

export class Lsp {
  /** The language service has answered something: it is up, an empty answer is its answer */
  private seen = false;
  private clickWaits = 0;

  constructor(private cx: HostContext) {}

  /** Asks the language service (requests for the same file, position and content are shared: a hover may be asking already) */
  defs = (abs: string, line: number, col: number): Promise<Def[]> =>
    this.cx.defs.shared(abs, line, col, () => this.askDefs(abs, line, col));

  /** Go to Implementation at a definition (Pylance searches the whole workspace for subclasses, seconds when cold) */
  impls = (d: Def): Promise<Def[]> =>
    this.cx.defs.shared(
      d.abs,
      d.line,
      d.col,
      async () => {
        const t0 = performance.now();
        const r = await this.cx.ws.language.implementations(d.abs, d.line, d.col);
        this.cx.log(
          "info",
          `implementations at ${this.cx.hostPath(d.abs)}:${d.line} → ${r.length}, ${Math.round(performance.now() - t0)} ms`,
        );
        return r;
      },
      "impl",
    );

  private async askDefs(abs: string, line: number, col: number): Promise<Def[]> {
    try {
      const r = await this.cx.ws.language.definitions(abs, line, col);
      if (r.length) this.seen = true;
      return r.filter((d) => !(d.abs === abs && d.line === line)); // points back at the call itself
    } catch (e) {
      this.cx.log(
        "warn",
        `definition provider failed at ${this.cx.hostPath(abs)}:${line}:${col}: ${e instanceof Error ? e.message : e}`,
      );
      return [];
    }
  }

  /**
   * The language service gave `first` (empty) and may still be starting, as long as it has never answered anything: asks
   * again every RETRY_GAP until it answers, it answers another request, `wait` ms are up or alive() turns false
   */
  async ready(first: Def[], ask: () => Promise<Def[]>, wait: number, alive = () => true): Promise<Def[]> {
    let d = first;
    for (let k = 0; !d.length && !this.seen && k < Math.round(wait / RETRY_GAP) && alive(); k++) {
      await sleep(RETRY_GAP);
      d = await ask();
    }
    return d;
  }

  /** Definitions for a click: when Pylance looks like it is still starting (installed, never answered), waits for it */
  async clickDefs(abs: string, line: number, col: number): Promise<Def[]> {
    const d = await this.defs(abs, line, col);
    if (
      d.length ||
      this.seen ||
      this.clickWaits >= CLICK_WAITS ||
      this.cx.langOf(abs) !== "python" ||
      !this.cx.ws.about.hasExtension("ms-python.vscode-pylance")
    )
      return d;
    this.clickWaits++;
    const r = await this.ready(d, () => this.defs(abs, line, col), CLICK_LSP_WAIT);
    if (r.length)
      this.cx.log(
        "info",
        `definition at ${this.cx.hostPath(abs)}:${line}:${col} answered after retry (language server starting)`,
      );
    return r;
  }
}
