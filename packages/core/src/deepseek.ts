// DeepSeek 的灰字补全（宿主用；密钥只在宿主里，不进白板）。先用 FIM（光标前 + 光标后，直接续写），出错再退回对话接口。
// fetch 由调用方给（VS Code 里是 Node 自带的；测试里是假的）
import { COMPLETE_SYSTEM, completePrompt } from "./complete";

export interface DeepseekOpts {
  key: string;
  /** 默认 https://api.deepseek.com */
  baseUrl?: string;
  /** 默认 deepseek-flash（Linda 的账号只能用这个） */
  model?: string;
  signal?: AbortSignal;
  /** 默认 3 秒 */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const DEEPSEEK_MODEL = "deepseek-flash";

export type DeepseekRequest = { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } };

const base = (o: DeepseekOpts) => (o.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
const headers = (key: string) => ({ "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${key}` });

/** FIM：prompt = 光标前，suffix = 光标后；到换行就停 */
export function deepseekFimRequest(o: DeepseekOpts, before: string, after: string): DeepseekRequest {
  return {
    url: `${base(o)}/beta/completions`,
    init: { method: "POST", headers: headers(o.key), body: JSON.stringify({
      model: o.model || DEEPSEEK_MODEL, prompt: before.slice(-4000), suffix: after.slice(0, 1000), max_tokens: 48, temperature: 0.2, stop: ["\n"], stream: false,
    }) },
  };
}

/** 退路：对话接口，提示词和 Copilot 那条一样 */
export function deepseekChatRequest(o: DeepseekOpts, before: string, after: string): DeepseekRequest {
  return {
    url: `${base(o)}/chat/completions`,
    init: { method: "POST", headers: headers(o.key), body: JSON.stringify({
      // deepseek-flash 默认会先“思考”，思考把 max_tokens 用光，回答是空的：关掉
      model: o.model || DEEPSEEK_MODEL, max_tokens: 64, temperature: 0.2, stream: false, thinking: { type: "disabled" },
      messages: [{ role: "system", content: COMPLETE_SYSTEM }, { role: "user", content: completePrompt(before, after) }],
    }) },
  };
}

// FIM 被拒绝过的“地址 + 模型”（进程内记着）
const noFim = new Set<string>();
const fimKey = (o: DeepseekOpts) => `${base(o)} ${o.model || DEEPSEEK_MODEL}`;
/** 测试用：忘掉 FIM 被拒绝过的记录 */
export const resetDeepseekFim = () => noFim.clear();

/** 补全光标处的文字（模型的原话，清理交给 cleanCompletion）；取消、超时、没网、接口出错都回 undefined（不抛出） */
export async function deepseekComplete(o: DeepseekOpts, before: string, after: string): Promise<string | undefined> {
  const f = o.fetch ?? fetch;
  if (!o.key || o.signal?.aborted) return undefined;
  // 外面取消或者超时都中止请求
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
    if (!noFim.has(fk)) {
      let status = 0;
      const fim = await send(deepseekFimRequest(o, before, after), (s) => (status = s)).catch((e) => { if (ac.signal.aborted) throw e; return null; });
      const text = fim?.choices?.[0]?.text;
      if (typeof text === "string") return text;
      if (ac.signal.aborted) return undefined;
      // 接口明确拒绝（4xx，比如这个模型不支持 FIM）：这个会话里以后直接走对话；超时、5xx、没网下次还试 FIM
      if (status >= 400 && status < 500 && status !== 401 && status !== 429) noFim.add(fk);
    }
    const chat = await send(deepseekChatRequest(o, before, after));
    const c = chat?.choices?.[0]?.message?.content;
    return typeof c === "string" ? c : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
    o.signal?.removeEventListener("abort", stop);
  }
}
