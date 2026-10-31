// 用哪个 AI：DeepSeek（密钥在编辑器的密钥存储里，只有宿主拿得到）或编辑器提供的语言模型（Workspace.ai：VS Code 的 Copilot…）。
// Note 的灰字补全按 codeboard.ai.provider 选，图片的 AI 功能按各自的设置选（imageai.ts）；密钥的设、删和 Settings 页看到的状态也在这里
import { COMPLETE_SYSTEM, completePrompt, spaceChatReply, type AiInfo } from "@codeboard/core";
import { deepseekComplete } from "./deepseek";
import type { Prompts } from "./prompts";
import { workspace } from "./ws";

/** DeepSeek 的 API 密钥在密钥存储里的名字 */
const DEEPSEEK_SECRET = "codeboard.deepseekApiKey";

/** DeepSeek 的密钥；没设、密钥存储出错都回 undefined */
export async function deepseekKey(): Promise<string | undefined> {
  return (
    (await workspace()
      .secrets.get(DEEPSEEK_SECRET)
      .catch(() => undefined)) || undefined
  );
}

/** DeepSeek 的模型名和地址（设置 codeboard.ai.deepseekModel / deepseekBaseUrl，空 = 默认） */
export function deepseekTarget(): { model?: string; baseUrl?: string } {
  const s = workspace().settings;
  return {
    model: s.get<string>("codeboard.ai.deepseekModel") || undefined,
    baseUrl: s.get<string>("codeboard.ai.deepseekBaseUrl") || undefined,
  };
}

/** 命令 Set DeepSeek API Key 和白板上的 Set Key…：在 ask 的地方（白板的对话框或编辑器的输入框）问密钥，存进密钥存储；回设好了没有 */
export async function setDeepseekKey(ask: Prompts): Promise<boolean> {
  const key = (
    await ask.input({
      title: "DeepSeek API Key",
      ok: "Save",
      password: true,
      placeHolder: "sk-…",
      prompt:
        "Used for gray inline completions in Notes and for the AI tools (Extract Text, Convert to SVG, Auto Focus). Stored in VS Code's secret storage.",
    })
  )?.trim();
  if (!key) return false;
  await workspace().secrets.set(DEEPSEEK_SECRET, key);
  void workspace().ui.info("DeepSeek API key saved.");
  return true;
}

export async function clearDeepseekKey(): Promise<void> {
  await workspace().secrets.delete(DEEPSEEK_SECRET);
  void workspace().ui.info("DeepSeek API key cleared.");
}

const provider = () => workspace().settings.get<string>("codeboard.ai.provider") || "auto";
/** Note 的灰字补全开着没有（codeboard.ai.provider 不是 off） */
export const completionsOn = () => provider() !== "off";

const NOTE_JUSTIFY = "CodeBoard suggests gray inline completions while you write a Note.";

/**
 * Note 的灰字补全：光标前后的文字 → 模型的原话（清理交给 cleanCompletion）。auto = 有 DeepSeek 密钥用 DeepSeek，没有用编辑器的语言模型；
 * deepseek / copilot 只用那一个；off 什么都不问。对话模型的回答不带前导空格，按光标前的文字补回来（DeepSeek 的对话回退也这样）。
 * undefined = 没有模型、没同意、取消、出错
 */
export async function completeNote(before: string, after: string, signal: AbortSignal): Promise<string | undefined> {
  const p = provider();
  if (p === "off") return undefined;
  if (p === "deepseek" || p === "auto") {
    const key = await deepseekKey();
    if (key) return deepseekComplete({ key, ...deepseekTarget(), signal }, before, after);
    if (p === "deepseek") return undefined;
  }
  const ai = workspace().ai;
  if (!ai || signal.aborted) return undefined;
  const r = await ai.chat(
    undefined,
    { system: COMPLETE_SYSTEM, user: completePrompt(before, after), fast: true, maxChars: 600 },
    { signal, justification: NOTE_JUSTIFY },
  );
  return "fail" in r ? undefined : spaceChatReply(r.text, before);
}

/** Settings 的 AI 一节：DeepSeek 的密钥设了没有（只回这一位）、编辑器现在有哪些语言模型 */
export async function aiInfo(): Promise<AiInfo> {
  const [key, models] = await Promise.all([
    deepseekKey(),
    workspace()
      .ai?.models()
      .catch(() => []) ?? [],
  ]);
  return { key: !!key, models };
}
