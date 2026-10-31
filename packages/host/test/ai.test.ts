// Which model a Note's gray completion asks (codeboard.ai.provider: auto / deepseek / copilot / off), on a fake DeepSeek (global fetch)
// and a fake editor language model (Workspace.ai.chat); and the DeepSeek key commands. No network
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiChatResult } from "@codeboard/core";
import { aiInfo, clearDeepseekKey, completeNote, completionsOn, setDeepseekKey } from "../src/ai";
import { resetDeepseekFim } from "../src/deepseek";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";

const conf = new Map<string, unknown>();
let chats: { model: string | undefined; req: AiChatRequest; justification: string }[] = [];
let reply: AiChatResult = { text: "and more", via: "GPT-4o mini" };
let fetches: string[] = [];
const W = nodeWorkspace();
W.settings = { ...W.settings, get: <T>(k: string) => conf.get(k) as T };
const withModels = {
  models: async () => [],
  chat: async (model: string | undefined, req: AiChatRequest, o: { justification: string }) => {
    chats.push({ model, req, justification: o.justification });
    return reply;
  },
};
const signal = () => new AbortController().signal;

beforeEach(async () => {
  conf.clear();
  chats = [];
  fetches = [];
  reply = { text: "and more", via: "GPT-4o mini" };
  W.ai = withModels;
  await W.secrets.delete("codeboard.deepseekApiKey");
  resetDeepseekFim();
  useWorkspace(W);
  vi.stubGlobal("fetch", async (url: string) => {
    fetches.push(url);
    return new Response(JSON.stringify({ choices: [{ text: " from deepseek" }] }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const setKey = () => W.secrets.set("codeboard.deepseekApiKey", "sk-test");

describe("Note completion: which model", () => {
  it("Auto without a DeepSeek key asks the editor's quick model, and puts back the leading space the chat reply lacks", async () => {
    expect(await completeNote("done.", "", signal())).toBe(" and more");
    expect(await completeNote("done. ", "", signal())).toBe("and more");
    expect(chats[0].model).toBeUndefined();
    expect(chats[0].req).toMatchObject({ fast: true, maxChars: 600 });
    expect(chats[0].justification).toContain("gray inline completions");
    expect(fetches).toEqual([]);
  });

  it("Auto with a key asks DeepSeek only", async () => {
    await setKey();
    expect(await completeNote("a", "b", signal())).toBe(" from deepseek");
    expect(fetches.length).toBe(1);
    expect(chats).toEqual([]);
  });

  it("DeepSeek without a key asks nobody; Copilot never asks DeepSeek; Off asks nobody and turns completions off", async () => {
    conf.set("codeboard.ai.provider", "deepseek");
    expect(await completeNote("a", "b", signal())).toBeUndefined();
    await setKey();
    conf.set("codeboard.ai.provider", "copilot");
    expect(await completeNote("done.", "", signal())).toBe(" and more");
    expect(fetches).toEqual([]);
    expect(completionsOn()).toBe(true);
    conf.set("codeboard.ai.provider", "off");
    expect(await completeNote("a", "b", signal())).toBeUndefined();
    expect(completionsOn()).toBe(false);
    expect(chats.length).toBe(1);
  });

  it("no answer when the editor has no models, or the model fails", async () => {
    reply = { fail: "noconsent" };
    expect(await completeNote("a", "b", signal())).toBeUndefined();
    W.ai = undefined;
    expect(await completeNote("a", "b", signal())).toBeUndefined();
  });
});

describe("DeepSeek key", () => {
  it("Set asks for the key (trimmed) and stores it in secret storage; an empty answer stores nothing; Clear removes it", async () => {
    const asked: string[] = [];
    expect(
      await setDeepseekKey({
        input: async (o) => {
          asked.push(o.title ?? "");
          return "";
        },
        pick: async () => undefined,
      }),
    ).toBe(false);
    expect((await aiInfo()).key).toBe(false);
    expect(
      await setDeepseekKey({
        input: async (o) => {
          asked.push(o.title ?? "");
          expect(o.password).toBe(true);
          return "  sk-new ";
        },
        pick: async () => undefined,
      }),
    ).toBe(true);
    expect(await W.secrets.get("codeboard.deepseekApiKey")).toBe("sk-new");
    expect(asked).toEqual(["DeepSeek API Key", "DeepSeek API Key"]);
    await clearDeepseekKey();
    expect(await aiInfo()).toEqual({ key: false, models: [] });
  });
});
