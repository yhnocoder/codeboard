// Stand-in for the DeepSeek API while taking the release shots, so the Notes shot can show a gray inline completion without a real model or key.
// Answers the FIM endpoint (/beta/completions) and the chat fallback (/chat/completions) with one fixed sentence when the text before
// the caret ends with the Note's last sentence; anything else gets an empty completion (no gray text while the Note is being typed).
// Usage: node tools/release/mock-deepseek.mjs <port>
import * as http from "node:http";

const port = Number(process.argv[2] || 17841);
const AFTER = "Decode adds one token per sequence each step.";
const TEXT = " Finished sequences free their KV blocks for the waiting queue.";
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {
        /* empty request */
      }
      const before = j.prompt ?? j.messages?.at(-1)?.content ?? "";
      const hit = before.trimEnd().endsWith(AFTER) || before.includes(AFTER + "\n</note_before_cursor>");
      const text = hit ? TEXT : "";
      console.log(`mock DeepSeek: ${req.url} ${hit ? "completion" : "empty"}`);
      const out = req.url.endsWith("/beta/completions")
        ? { choices: [{ text }] }
        : req.url.endsWith("/chat/completions")
          ? { choices: [{ message: { content: text.trim() } }] }
          : null;
      res.writeHead(out ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out ?? { error: "not found" }));
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock DeepSeek on http://127.0.0.1:${port}`));
