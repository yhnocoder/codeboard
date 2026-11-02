// DeepSeek for scenarios on the real host (realhost.ts): a local HTTP server that the codeboard.ai.deepseekBaseUrl setting points
// the host to, so the host's own request building, response reading, timeouts and cancelling run as they do against the service
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { RealHostRun } from "./realhost";

/** What the fake answers a request: the model's text, an HTTP status (an error), or "hang" (no answer until the host gives up) */
export type DeepseekAnswer = string | number | "hang";
/** Where the host keeps the DeepSeek key (the editor's secret storage), as Set DeepSeek API Key… stores it */
const DEEPSEEK_SECRET = "codeboard.deepseekApiKey";

/**
 * Starts the fake and points run's host to it. answer: for each request (its JSON body and path: /chat/completions, or /beta/completions
 * for a fill-in-the-middle completion), what to answer, after anything it awaits. key: the DeepSeek key stored; null = none.
 * calls: the bodies the host sent, in order. Closed after the scenario
 */
export async function fakeDeepseek(
  run: RealHostRun,
  answer: (body: any, path: string) => DeepseekAnswer | Promise<DeepseekAnswer>,
  o: { key?: string | null } = {},
) {
  const calls: { path: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (d) => (text += d));
    req.on("end", async () => {
      const body = JSON.parse(text || "{}"),
        p = new URL(req.url ?? "/", "http://x").pathname;
      calls.push({ path: p, body });
      const a = await answer(body, p);
      if (a === "hang" || res.destroyed) return; // until the host aborts the request
      res.writeHead(typeof a === "number" ? a : 200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          typeof a === "number"
            ? { error: { message: `status ${a}` } }
            : p.endsWith("/beta/completions")
              ? { choices: [{ finish_reason: "stop", text: a }] }
              : { choices: [{ finish_reason: "stop", message: { content: a } }] },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  run.afterClose(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  await run.ws.settings.set(
    "codeboard.ai.deepseekBaseUrl",
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  if (o.key !== null) await run.ws.secrets.set(DEEPSEEK_SECRET, o.key ?? "sk-fake");
  return { calls };
}
