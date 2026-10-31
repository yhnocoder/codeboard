import { COMPLETE_SYSTEM, completePrompt, spaceChatReply, type WorkspaceAi } from "@codeboard/core";

/**
 * A Note's ghost completion from a chat model (WorkspaceAi.ask: Copilot and the like): the reply has no leading space, so one is put
 * back from the text before the cursor, as with DeepSeek's chat fallback. undefined = no model, no consent or canceled
 */
export async function chatComplete(ask: WorkspaceAi["ask"], before: string, after: string, signal?: AbortSignal): Promise<string | undefined> {
  const r = await ask(COMPLETE_SYSTEM, completePrompt(before, after), { signal, maxChars: 600 });
  return r === undefined ? r : spaceChatReply(r, before);
}
