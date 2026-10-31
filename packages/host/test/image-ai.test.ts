// The image tools' DeepSeek calls (Extract Text, Convert to SVG, Modify SVG, Draw as SVG) on a fake fetch: request shape and thinking flags,
// reusing an image already read, and what each failure turns into. No network
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAW_BG_OFF,
  DRAW_BG_ON,
  drawUser,
  IMAGE_AI_TIMEOUT,
  imageAiJob,
  imageAiRequest,
  resetImageAiCache,
  runImageAi,
  stripFence,
  SYS_DRAW,
  SYS_EXTRACT,
  SYS_MODIFY,
  SYS_SVG,
  SVG_BG_OFF,
  SVG_BG_ON,
} from "../src/imageai";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";

type Call = { url: string; body: any; headers: Record<string, string>; signal?: AbortSignal };
type Reply = ((c: Call) => Promise<Response>) | { status: number; json?: unknown };
function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c: Call = {
      url,
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
      signal: init.signal ?? undefined,
    };
    calls.push(c);
    const r = replies[calls.length - 1];
    if (!r) throw new Error("unexpected call");
    if (typeof r === "function") return r(c);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const answer = (content: string, finish = "stop") => ({
  status: 200,
  json: { choices: [{ finish_reason: finish, message: { content } }] },
});
const KEY = "sk-test-image";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const PNG2 = PNG.replace("iZk9", "iZk8");
const hang = (c: Call) =>
  new Promise<Response>((_, rej) =>
    c.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))),
  );

beforeEach(() => resetImageAiCache());

describe("image tools: requests", () => {
  it("Extract Text sends the image as vision content with thinking disabled", () => {
    const r = imageAiRequest({ key: KEY, baseUrl: "https://api.deepseek.com/" }, { kind: "extract", image: PNG });
    expect(r.url).toBe("https://api.deepseek.com/chat/completions");
    expect(r.init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const b = JSON.parse(r.init.body);
    expect(b).toMatchObject({
      model: "deepseek-flash",
      max_tokens: 4000,
      stream: false,
      thinking: { type: "disabled" },
    });
    expect(b.reasoning_effort).toBeUndefined();
    expect(b.messages[0]).toEqual({ role: "system", content: SYS_EXTRACT });
    expect(b.messages[1].content).toEqual([
      { type: "text", text: "Transcribe this image to Markdown." },
      { type: "image_url", image_url: { url: PNG } },
    ]);
  });

  it("Convert to SVG gives the size and the background rule, and thinks (effort low) only with Think First", () => {
    const fast = JSON.parse(
      imageAiRequest(
        { key: KEY, model: "m-vision" },
        { kind: "svg", image: PNG, size: { w: 1200, h: 800 }, noBg: true, think: false },
      ).init.body,
    );
    expect(fast).toMatchObject({ model: "m-vision", max_tokens: 16000, thinking: { type: "disabled" } });
    expect(fast.reasoning_effort).toBeUndefined();
    expect(fast.messages[0].content).toBe(`${SYS_SVG}\n${SVG_BG_ON}`);
    expect(fast.messages[1].content[0].text).toBe("Redraw this image as SVG. The image is 1200×800 pixels.");
    const slow = JSON.parse(
      imageAiRequest({ key: KEY }, { kind: "svg", image: PNG, size: { w: 10, h: 20 }, noBg: false, think: true }).init
        .body,
    );
    expect(slow).toMatchObject({ max_tokens: 32000, thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(slow.messages[0].content).toBe(`${SYS_SVG}\n${SVG_BG_OFF}`);
  });

  it("Modify SVG sends the instruction and the current source as text, thinking with effort low", () => {
    const b = JSON.parse(
      imageAiRequest({ key: KEY }, { kind: "modify", svg: "<svg/>", instruction: "  make it blue " }).init.body,
    );
    expect(b).toMatchObject({ max_tokens: 24000, thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(b.messages).toEqual([
      { role: "system", content: SYS_MODIFY },
      { role: "user", content: "Instruction: make it blue\n\nSVG:\n<svg/>" },
    ]);
  });

  it("Draw as SVG sends the text alone (no image) in <text> tags with the drawing rules and the background rule, thinking only with Think First", () => {
    const fast = JSON.parse(
      imageAiRequest({ key: KEY }, { kind: "draw", text: "  prefill → decode\n", noBg: true, think: false }).init.body,
    );
    expect(fast).toMatchObject({ max_tokens: 16000, thinking: { type: "disabled" } });
    expect(fast.reasoning_effort).toBeUndefined();
    expect(fast.messages).toEqual([
      { role: "system", content: `${SYS_DRAW}\n${DRAW_BG_ON}` },
      { role: "user", content: "Draw this as an SVG.\n\n<text>\nprefill → decode\n</text>" },
    ]);
    expect(SYS_DRAW).toMatch(/self-contained/i);
    expect(SYS_DRAW).toMatch(/no <script>, <foreignObject>, <image>/);
    const slow = JSON.parse(
      imageAiRequest({ key: KEY }, { kind: "draw", text: "x", noBg: false, think: true }).init.body,
    );
    expect(slow).toMatchObject({ max_tokens: 32000, thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(slow.messages[0].content).toBe(`${SYS_DRAW}\n${DRAW_BG_OFF}`);
    expect(slow.messages[1].content).toBe(drawUser("x"));
  });

  it("Draw as SVG refuses a cut-off answer, never caches, and has the SVG time limits", async () => {
    vi.useFakeTimers();
    try {
      const { f, calls } = fakeFetch([
        answer("<svg viewBox='0 0 1 1'><rect", "length"),
        answer("```svg\n<svg/>\n```"),
        hang,
      ]);
      const op = { kind: "draw", text: "a box", noBg: true, think: false } as const;
      expect(await runImageAi({ key: KEY, fetch: f }, op)).toEqual({ fail: "cut", via: "DeepSeek" });
      expect(await runImageAi({ key: KEY, fetch: f }, op)).toEqual({ text: "<svg/>" });
      const late = runImageAi({ key: KEY, fetch: f }, op);
      await vi.advanceTimersByTimeAsync(IMAGE_AI_TIMEOUT.svg);
      expect(await late).toMatchObject({ fail: "timeout", via: "DeepSeek" });
      expect(calls.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("strips only a fence around the whole answer", () => {
    expect(stripFence("```markdown\n# T\n\n```py\nx\n```\n```")).toBe("# T\n\n```py\nx\n```");
    expect(stripFence("  plain text \n")).toBe("plain text");
    expect(stripFence("a\n```py\nx\n```")).toBe("a\n```py\nx\n```");
  });
});

describe("image tools: answers", () => {
  it("reads an image once: the same image again is answered without a call, another image is asked", async () => {
    const { f, calls } = fakeFetch([answer("```markdown\n# Wave count\n\n$x$\n```"), answer("other")]);
    expect(await runImageAi({ key: KEY, fetch: f }, { kind: "extract", image: PNG })).toEqual({
      text: "# Wave count\n\n$x$",
    });
    expect(await runImageAi({ key: KEY, fetch: f }, { kind: "extract", image: PNG })).toEqual({
      text: "# Wave count\n\n$x$",
      reused: true,
    });
    expect(calls.length).toBe(1);
    expect(await runImageAi({ key: KEY, fetch: f }, { kind: "extract", image: PNG2 })).toEqual({ text: "other" });
    // another model reads it anew
    expect(calls.length).toBe(2);
  });

  it("does not keep a cut-off transcription, and asks again next time", async () => {
    const { f, calls } = fakeFetch([answer("# Half", "length"), answer("# Whole")]);
    expect(await runImageAi({ key: KEY, fetch: f }, { kind: "extract", image: PNG })).toEqual({
      text: "# Half",
      cut: true,
    });
    expect(await runImageAi({ key: KEY, fetch: f }, { kind: "extract", image: PNG })).toEqual({ text: "# Whole" });
    expect(calls.length).toBe(2);
  });

  it("refuses a cut-off SVG, and never caches SVG work", async () => {
    const { f, calls } = fakeFetch([
      answer("<svg viewBox='0 0 1 1'><rect", "length"),
      answer("<svg/>"),
      answer("<svg/>"),
    ]);
    const op = { kind: "svg", image: PNG, size: { w: 1, h: 1 }, noBg: true, think: false } as const;
    expect(await runImageAi({ key: KEY, fetch: f }, op)).toEqual({ fail: "cut", via: "DeepSeek" });
    expect(await runImageAi({ key: KEY, fetch: f }, op)).toEqual({ text: "<svg/>" });
    expect(await runImageAi({ key: KEY, fetch: f }, op)).toEqual({ text: "<svg/>" });
    expect(calls.length).toBe(3);
  });

  it("names the failures: bad key, balance used up, other HTTP errors, network, empty answer", async () => {
    const op = { kind: "modify", svg: "<svg/>", instruction: "x" } as const;
    const { f } = fakeFetch([
      { status: 401, json: { error: { message: "Authentication Fails" } } },
      { status: 402, json: { error: { message: "Insufficient Balance" } } },
      { status: 400, json: { error: { message: "image too large" } } },
      async () => {
        throw new TypeError("fetch failed");
      },
      answer(""),
    ]);
    expect(await runImageAi({ key: KEY, fetch: f }, op)).toEqual({
      fail: "badkey",
      message: "Authentication Fails",
      via: "DeepSeek",
    });
    expect(await runImageAi({ key: KEY, fetch: f }, op)).toEqual({
      fail: "balance",
      message: "Insufficient Balance",
      via: "DeepSeek",
    });
    expect(await runImageAi({ key: KEY, fetch: f }, op)).toEqual({
      fail: "http",
      message: "image too large",
      via: "DeepSeek",
    });
    expect(await runImageAi({ key: KEY, fetch: f }, op)).toEqual({
      fail: "network",
      message: "fetch failed",
      via: "DeepSeek",
    });
    expect(((await runImageAi({ key: KEY, fetch: f }, op)) as { fail: string }).fail).toBe("http");
  });

  it("is canceled by the caller's signal and gives up at its time limit", async () => {
    const a = fakeFetch([hang]);
    const ac = new AbortController();
    const p = runImageAi({ key: KEY, fetch: a.f, signal: ac.signal }, { kind: "extract", image: PNG });
    await vi.waitFor(() => expect(a.calls.length).toBe(1));
    ac.abort();
    expect(await p).toEqual({ fail: "canceled" });
    const b = fakeFetch([hang]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let done = false;
      const q = runImageAi({ key: KEY, fetch: b.f, timeoutMs: 80 }, { kind: "extract", image: PNG }).finally(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(79);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await q).toMatchObject({ fail: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("image tools: the host's job", () => {
  const conf = new Map<string, unknown>();
  let key: string | undefined;
  const W = nodeWorkspace();
  W.settings = { ...W.settings, get: <T>(k: string) => conf.get(k) as T };
  W.secrets = { ...W.secrets, get: async () => key };
  beforeEach(() => {
    conf.clear();
    key = KEY;
    useWorkspace(W);
  });

  it("says there is no key without calling the network", async () => {
    key = undefined;
    const { f, calls } = fakeFetch([]);
    expect(await imageAiJob(new Map(), 1, { kind: "extract", image: PNG }, f)).toMatchObject({ fail: "nokey" });
    expect(calls.length).toBe(0);
  });

  it("uses the key from secret storage and the model and base URL from settings", async () => {
    conf.set("codeboard.ai.deepseekModel", "deepseek-vision-x");
    conf.set("codeboard.ai.deepseekBaseUrl", "http://proxy.local/v1/");
    const { f, calls } = fakeFetch([answer("hi")]);
    expect(await imageAiJob(new Map(), 1, { kind: "extract", image: PNG }, f)).toEqual({ text: "hi" });
    expect(calls[0].url).toBe("http://proxy.local/v1/chat/completions");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body.model).toBe("deepseek-vision-x");
  });

  it("is canceled by its job number, and forgets the job when it ends", async () => {
    const jobs = new Map<number, AbortController>();
    const { f, calls } = fakeFetch([hang]);
    const p = imageAiJob(jobs, 7, { kind: "svg", image: PNG, size: { w: 1, h: 1 }, noBg: true, think: true }, f);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    jobs.get(7)!.abort();
    expect(await p).toEqual({ fail: "canceled" });
    expect(jobs.size).toBe(0);
  });
});
