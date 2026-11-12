// DeepSeek 的灰字补全（密钥只在宿主里，不进白板）。先用 FIM（光标前 + 光标后，直接续写），出错再退回对话接口。
import { COMPLETE_SYSTEM, completePrompt, spaceChatReply } from "@codeboard/core";

export interface DeepseekOpts {
  key: string;
  baseUrl?: string;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Endpoints and models that turned FIM down (the host's, so a refusal is remembered while it runs; none: not remembered) */
  noFim?: Set<string>;
}

export const DEEPSEEK_MODEL = "deepseek-flash";

export type DeepseekRequest = { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } };

/** The API's address (codeboard.ai.deepseekBaseUrl; none = DeepSeek's own) */
export const deepseekBase = (o: { baseUrl?: string }) => (o.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");

/** A POST of body as JSON to the API's endpoint at (a path such as "/chat/completions"), with the key */
export function deepseekPost(o: { key: string; baseUrl?: string }, at: string, body: unknown): DeepseekRequest {
  return {
    url: `${deepseekBase(o)}${at}`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${o.key}` },
      body: JSON.stringify(body),
    },
  };
}

export function deepseekFimRequest(o: DeepseekOpts, before: string, after: string): DeepseekRequest {
  return deepseekPost(o, "/beta/completions", {
    model: o.model || DEEPSEEK_MODEL,
    prompt: before.slice(-4000),
    suffix: after.slice(0, 1000),
    max_tokens: 48,
    temperature: 0.2,
    stop: ["\n"],
    stream: false,
  });
}

export function deepseekChatRequest(o: DeepseekOpts, before: string, after: string): DeepseekRequest {
  return deepseekPost(o, "/chat/completions", {
    // deepseek-flash 默认会先“思考”，思考把 max_tokens 用光，回答是空的：关掉
    model: o.model || DEEPSEEK_MODEL,
    max_tokens: 64,
    temperature: 0.2,
    stream: false,
    thinking: { type: "disabled" },
    messages: [
      { role: "system", content: COMPLETE_SYSTEM },
      { role: "user", content: completePrompt(before, after) },
    ],
  });
}

const fimKey = (o: DeepseekOpts) => `${deepseekBase(o)} ${o.model || DEEPSEEK_MODEL}`;

/** 补全光标处的文字（模型的原话，清理交给 cleanCompletion）；取消、超时、没网、接口出错都回 undefined（不抛出） */
export async function deepseekComplete(o: DeepseekOpts, before: string, after: string): Promise<string | undefined> {
  const f = o.fetch ?? fetch;
  if (!o.key || o.signal?.aborted) return undefined;
  const ac = new AbortController();
  const stop = () => ac.abort();
  o.signal?.addEventListener("abort", stop);
  const t = setTimeout(stop, o.timeoutMs ?? 3000);
  const send = async (r: DeepseekRequest, onStatus?: (s: number) => void) => {
    const res = await f(r.url, { ...r.init, signal: ac.signal });
    onStatus?.(res.status);
    if (!res.ok) return null;
    return (await res.json()) as { choices?: { text?: string; message?: { content?: string } }[] };
  };
  const fk = fimKey(o);
  try {
    if (!o.noFim?.has(fk)) {
      let status = 0;
      const fim = await send(deepseekFimRequest(o, before, after), (s) => (status = s)).catch((e) => {
        if (ac.signal.aborted) throw e;
        return null;
      });
      const text = fim?.choices?.[0]?.text;
      if (typeof text === "string") return text;
      if (ac.signal.aborted) return undefined;
      // 接口明确拒绝（4xx，比如这个模型不支持 FIM）：这个会话里以后直接走对话；超时、5xx、没网下次还试 FIM
      if (status >= 400 && status < 500 && status !== 401 && status !== 429) o.noFim?.add(fk);
    }
    const chat = await send(deepseekChatRequest(o, before, after));
    const c = chat?.choices?.[0]?.message?.content;
    return typeof c === "string" ? spaceChatReply(c, before) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
    o.signal?.removeEventListener("abort", stop);
  }
}
