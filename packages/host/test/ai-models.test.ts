// Which model each AI tool asks (Settings › AI: codeboard.ai.textModel / svgModel / focusModel), on a fake DeepSeek (fetch) and a
// fake VS Code language model (Workspace.ai.chat): Auto, DeepSeek, a picked model; images sent as bytes; Copilot's failures; the
// Auto Focus request; the key status the Settings page gets. No network
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiChatResult, AiModel } from "@codeboard/core";
import { aiInfo } from "../src/ai";
import { focusUser, imageAiJob, imageAiRequest, resetImageAiCache, SYS_FOCUS } from "../src/imageai";
import { makeHandler } from "../src/handlers";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";

const KEY = "sk-test-models";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const MODELS: AiModel[] = [
  { id: "gpt-4o", name: "GPT-4o", vendor: "copilot", vision: true },
  { id: "o3-mini", name: "o3-mini", vendor: "copilot", vision: false },
];

type Chat = { model: string | undefined; req: AiChatRequest; signal: AbortSignal; justification: string };
const conf = new Map<string, unknown>();
let key: string | undefined;
let chats: Chat[] = [];
let chatReply: (c: Chat) => Promise<AiChatResult> = async () => ({ text: "from copilot", via: "GPT-4o" });
let fetches: { url: string; body: any }[] = [];
const fetchFake = (async (url: string, init: RequestInit) => {
  fetches.push({ url, body: JSON.parse(String(init.body)) });
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "from deepseek" } }] }), {
    status: 200,
  });
}) as unknown as typeof fetch;

const W = nodeWorkspace();
W.settings = { ...W.settings, get: <T>(k: string) => conf.get(k) as T };
let cleared = 0;
W.secrets = {
  get: async () => key,
  set: async (_k, v) => {
    key = v;
  },
  delete: async () => {
    cleared++;
    key = undefined;
  },
};
W.ui = { ...W.ui, input: async () => " sk-new " };
W.ai = {
  models: async () => MODELS,
  chat: (model, req, o) => {
    const c = { model, req, signal: o.signal, justification: o.justification };
    chats.push(c);
    return chatReply(c);
  },
};
beforeEach(() => {
  conf.clear();
  key = KEY;
  chats = [];
  fetches = [];
  cleared = 0;
  resetImageAiCache();
  useWorkspace(W);
  chatReply = async () => ({ text: "from copilot", via: "GPT-4o" });
});

const extract = { kind: "extract", image: PNG } as const;
const svg = { kind: "svg", image: PNG, size: { w: 1, h: 1 }, noBg: true, think: true } as const;

describe("AI tools: which model", () => {
  it("Auto asks DeepSeek when a key is set, and a VS Code model when none is", async () => {
    expect(await imageAiJob(new Map(), 1, extract, fetchFake)).toEqual({ text: "from deepseek" });
    expect(fetches.length).toBe(1);
    expect(chats.length).toBe(0);
    key = undefined;
    resetImageAiCache();
    expect(await imageAiJob(new Map(), 2, extract, fetchFake)).toEqual({ text: "from copilot" });
    expect(chats.length).toBe(1);
    expect(chats[0].model).toBeUndefined();
    expect(fetches.length).toBe(1);
  });

  it("sends the image to the VS Code model as bytes with its type, and the prompt as system + user", async () => {
    key = undefined;
    await imageAiJob(new Map(), 1, extract, fetchFake);
    const r = chats[0].req;
    expect(r.image?.mime).toBe("image/png");
    expect(Buffer.from(r.image!.data).toString("base64")).toBe(PNG.split(",")[1]);
    expect(r.user).toBe("Transcribe this image to Markdown.");
    expect(r.system).toMatch(/^You transcribe images into Markdown/);
    expect(r.fast).toBe(true);
    expect(chats[0].justification).toMatch(/Settings › AI/);
  });

  it("each tool has its own choice: a picked model is used even with a key, DeepSeek without a key says so", async () => {
    conf.set("codeboard.ai.svgModel", "gpt-4o");
    conf.set("codeboard.ai.focusModel", "deepseek");
    expect(await imageAiJob(new Map(), 1, svg, fetchFake)).toEqual({ text: "from copilot" });
    expect(chats.map((c) => c.model)).toEqual(["gpt-4o"]);
    // Think First is DeepSeek's: the VS Code model gets the same prompt, with no thinking flags
    expect(chats[0].req.fast).toBe(false);
    expect(fetches.length).toBe(0);
    expect(await imageAiJob(new Map(), 2, { kind: "focus", md: "a b" }, fetchFake)).toEqual({ text: "from deepseek" });
    expect(fetches.length).toBe(1);
    key = undefined;
    expect(await imageAiJob(new Map(), 3, { kind: "focus", md: "a b" }, fetchFake)).toMatchObject({ fail: "nokey" });
    expect(fetches.length).toBe(1);
    expect(chats.length).toBe(1);
  });

  it("Draw as SVG uses the SVG tool's model and sends the VS Code model only text", async () => {
    conf.set("codeboard.ai.svgModel", "o3-mini");
    const draw = { kind: "draw", text: "a pipeline", noBg: true, think: false } as const;
    expect(await imageAiJob(new Map(), 1, draw, fetchFake)).toEqual({ text: "from copilot" });
    expect(chats.map((c) => c.model)).toEqual(["o3-mini"]);
    expect(chats[0].req.image).toBeUndefined();
    expect(chats[0].req.user).toContain("<text>\na pipeline\n</text>");
    expect(chats[0].justification).toMatch(/Draw as SVG/);
    conf.set("codeboard.ai.svgModel", "auto");
    expect(await imageAiJob(new Map(), 2, draw, fetchFake)).toEqual({ text: "from deepseek" });
    expect(fetches[0].body.messages[1].content).toContain("a pipeline");
  });

  it("caches text read by each model on its own", async () => {
    conf.set("codeboard.ai.textModel", "gpt-4o");
    expect(await imageAiJob(new Map(), 1, extract, fetchFake)).toEqual({ text: "from copilot" });
    expect(await imageAiJob(new Map(), 2, extract, fetchFake)).toEqual({ text: "from copilot", reused: true });
    expect(chats.length).toBe(1);
    conf.set("codeboard.ai.textModel", "auto");
    expect(await imageAiJob(new Map(), 3, extract, fetchFake)).toEqual({ text: "from deepseek" });
  });

  it("passes on the VS Code model's failures with its name: no consent, model gone; Auto with nothing at all says what to do", async () => {
    conf.set("codeboard.ai.svgModel", "gpt-4o");
    chatReply = async () => ({ fail: "noconsent", message: "denied", via: "GPT-4o" });
    expect(await imageAiJob(new Map(), 1, svg, fetchFake)).toEqual({
      fail: "noconsent",
      message: "denied",
      via: "GPT-4o",
    });
    chatReply = async () => ({ fail: "nomodel", message: "The language model “gpt-4o” isn't available" });
    expect(await imageAiJob(new Map(), 2, svg, fetchFake)).toMatchObject({
      fail: "nomodel",
      message: "The language model “gpt-4o” isn't available",
    });
    key = undefined;
    chatReply = async () => ({ fail: "nomodel" });
    const r = await imageAiJob(new Map(), 3, extract, fetchFake);
    expect(r).toMatchObject({ fail: "nomodel" });
    expect((r as { message: string }).message).toMatch(/No DeepSeek API key, and no VS Code language model/);
  });

  it("cancels the VS Code model by job number", async () => {
    key = undefined;
    chatReply = (c) => new Promise((ok) => c.signal.addEventListener("abort", () => ok({ fail: "canceled" })));
    const jobs = new Map<number, AbortController>();
    const p = imageAiJob(jobs, 9, extract, fetchFake);
    await vi.waitFor(() => expect(chats.length).toBe(1));
    jobs.get(9)!.abort();
    expect(await p).toEqual({ fail: "canceled" });
    expect(jobs.size).toBe(0);
  });
});

describe("Auto Focus request", () => {
  it("sends the rules and the Markdown in <document> tags, without thinking, and keeps the answer's own fences", async () => {
    const md = "```py\nx = 1\n```";
    const b = JSON.parse(imageAiRequest({ key: KEY }, { kind: "focus", md }).init.body);
    expect(b).toMatchObject({ thinking: { type: "disabled" }, stream: false });
    expect(b.reasoning_effort).toBeUndefined();
    expect(b.messages).toEqual([
      { role: "system", content: SYS_FOCUS },
      { role: "user", content: focusUser(md) },
    ]);
    expect(focusUser(md)).toBe(`Add the marks to this Markdown document.\n\n<document>\n${md}\n</document>`);
    expect(SYS_FOCUS).toMatch(/==text==/);
    expect(SYS_FOCUS).toMatch(/Never touch code or formulas/);
    key = undefined;
    chatReply = async () => ({ text: md, via: "GPT-4o" });
    expect(await imageAiJob(new Map(), 1, { kind: "focus", md }, fetchFake)).toEqual({ text: md });
  });
});

describe("Settings › AI", () => {
  it("tells the board only whether a key is set, and the models; Set Key… asks for the key and stores it, Clear removes it", async () => {
    const info = await aiInfo();
    expect(info).toEqual({ key: true, models: MODELS });
    expect(JSON.stringify(info)).not.toContain(KEY);
    const h = makeHandler({ store: {} } as never);
    expect(await h(undefined as never, { type: "aiKey", req: 1, action: "clear" })).toEqual({
      key: false,
      models: MODELS,
    });
    expect(cleared).toBe(1);
    const after = await h(undefined as never, { type: "aiKey", req: 2, action: "set" });
    expect(after).toEqual({ key: true, models: MODELS });
    expect(key).toBe("sk-new");
    expect(JSON.stringify(after)).not.toContain("sk-new");
  });
});
