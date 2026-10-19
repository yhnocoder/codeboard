import { beforeEach, describe, expect, it } from "vitest";
import { cleanCompletion, spaceChatReply, COMPLETE_SYSTEM } from "@codeboard/core";
import { deepseekChatRequest, deepseekComplete, deepseekFimRequest, resetDeepseekFim } from "../src/deepseek";

type Call = { url: string; body: any; headers: Record<string, string>; signal?: AbortSignal };
// 假的 fetch：按顺序回给定的回答，记下每次请求（不连网）
function fakeFetch(replies: (((c: Call) => Promise<Response>) | { status: number; json?: unknown })[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c: Call = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string>, signal: init.signal ?? undefined };
    calls.push(c);
    const r = replies[calls.length - 1];
    if (typeof r === "function") return r(c);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const KEY = "sk-test-123";

describe("DeepSeek completion", () => {
  beforeEach(() => resetDeepseekFim());

  it("builds the FIM request from the text around the cursor", () => {
    const r = deepseekFimRequest({ key: KEY, baseUrl: "https://api.deepseek.com/" }, "before ", " after");
    expect(r.url).toBe("https://api.deepseek.com/beta/completions");
    expect(r.init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const b = JSON.parse(r.init.body);
    expect(b).toMatchObject({ model: "deepseek-flash", prompt: "before ", suffix: " after", max_tokens: 48, stop: ["\n"], stream: false });
    expect(b.temperature).toBeLessThanOrEqual(0.3);
  });

  it("builds the chat fallback with the shared prompt, and honors model and base URL", () => {
    const r = deepseekChatRequest({ key: KEY, model: "m1", baseUrl: "http://proxy.local/v1" }, "a", "b");
    expect(r.url).toBe("http://proxy.local/v1/chat/completions");
    const b = JSON.parse(r.init.body);
    expect(b.model).toBe("m1");
    // deepseek-flash 默认会思考，回答被截断：对话请求要关掉思考
    expect(b.thinking).toEqual({ type: "disabled" });
    expect(JSON.parse(deepseekChatRequest({ key: KEY }, "a", "b").init.body).model).toBe("deepseek-flash");
    expect(b.messages[0]).toEqual({ role: "system", content: COMPLETE_SYSTEM });
    expect(b.messages[1].content).toContain("<note_before_cursor>\na\n");
  });

  it("returns the FIM text, which cleanCompletion trims like the Copilot reply", async () => {
    const { f, calls } = fakeFetch([{ status: 200, json: { choices: [{ text: "uses the KV cache. And more" }] } }]);
    const before = "The scheduler ";
    const raw = await deepseekComplete({ key: KEY, fetch: f }, before, "");
    expect(calls.length).toBe(1);
    expect(raw).toBe("uses the KV cache. And more");
    expect(cleanCompletion("The scheduler uses the cache\nsecond line", before, "")).toBe("uses the cache");
  });

  it("falls back to chat when FIM fails", async () => {
    const { f, calls } = fakeFetch([{ status: 400, json: { error: "x" } }, { status: 200, json: { choices: [{ message: { content: "hello" } }] } }]);
    expect(await deepseekComplete({ key: KEY, fetch: f }, "a ", "b")).toBe("hello");
    expect(calls.map((c) => c.url)).toEqual(["https://api.deepseek.com/beta/completions", "https://api.deepseek.com/chat/completions"]);
  });

  it("adds the missing space before a chat reply after a word, but not after a space or CJK", async () => {
    const { f } = fakeFetch([{ status: 400 }, { status: 200, json: { choices: [{ message: { content: "fixed-size blocks." } }] } }]);
    resetDeepseekFim();
    const before = "the block manager allocates";
    const raw = await deepseekComplete({ key: KEY, fetch: f }, before, "");
    expect(cleanCompletion(raw!, before, "")).toBe(" fixed-size blocks.");
    expect(spaceChatReply("x", "a ")).toBe("x");
    expect(spaceChatReply("分配块", "管理器")).toBe("分配块");
    expect(spaceChatReply("and more", "done.")).toBe(" and more");
    expect(spaceChatReply(", then", "word")).toBe(", then");
  });

  it("remembers a FIM rejection for the session and goes straight to chat", async () => {
    const { f, calls } = fakeFetch([{ status: 400 }, { status: 200, json: { choices: [{ message: { content: "one" } }] } }, { status: 200, json: { choices: [{ message: { content: "two" } }] } }]);
    expect(await deepseekComplete({ key: KEY, fetch: f }, "a ", "b")).toBe("one");
    expect(await deepseekComplete({ key: KEY, fetch: f }, "a ", "b")).toBe("two");
    expect(calls.map((c) => c.url.replace(/^.*\.com/, ""))).toEqual(["/beta/completions", "/chat/completions", "/chat/completions"]);
  });

  it("keeps trying FIM after a server error", async () => {
    const { f, calls } = fakeFetch([{ status: 503 }, { status: 503 }, { status: 200, json: { choices: [{ text: "x" }] } }]);
    expect(await deepseekComplete({ key: KEY, fetch: f }, "a", "b")).toBeUndefined();
    expect(await deepseekComplete({ key: KEY, fetch: f }, "a ", "b")).toBe("x");
    expect(calls[2].url).toMatch(/beta\/completions$/);
  });

  it("returns undefined on errors and without a key, without calling the network", async () => {
    const { f, calls } = fakeFetch([{ status: 500 }, { status: 500 }]);
    expect(await deepseekComplete({ key: KEY, fetch: f }, "a", "b")).toBeUndefined();
    expect(await deepseekComplete({ key: "", fetch: f }, "a", "b")).toBeUndefined();
    expect(calls.length).toBe(2);
  });

  it("aborts on the caller's signal and on timeout", async () => {
    const hang = (c: Call) => new Promise<Response>((_, rej) => c.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    const a = fakeFetch([hang, hang]);
    const ac = new AbortController();
    const p = deepseekComplete({ key: KEY, fetch: a.f, signal: ac.signal }, "a", "b");
    ac.abort();
    expect(await p).toBeUndefined();
    expect(a.calls.length).toBe(1);
    const b = fakeFetch([hang, hang]);
    const t0 = Date.now();
    expect(await deepseekComplete({ key: KEY, fetch: b.f, timeoutMs: 50 }, "a", "b")).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(b.calls.length).toBe(1);
  });
});
