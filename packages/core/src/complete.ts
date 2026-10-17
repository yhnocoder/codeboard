// Note 编辑时的灰字补全：提示词和回答的清理（和宿主无关；宿主只负责把提示交给语言模型）
export const COMPLETE_SYSTEM = [
  "You are an inline autocomplete engine inside a whiteboard app where developers write Markdown notes while reading code.",
  "Continue the note at the cursor. Reply with ONLY the text to insert at the cursor: no explanation, no quotes, no code fences around the reply.",
  "Keep it short: finish the current sentence, or add at most one short sentence (about 20 words). Stay on one line.",
  "Match the language of the note (for example Chinese or English), its tone and its Markdown style. Keep code identifiers exactly as written.",
  "If nothing useful can be added, reply with nothing.",
].join("\n");

/** 光标前最多 2000 字、光标后最多 400 字 */
export function completePrompt(before: string, after: string): string {
  const b = before.slice(-2000), a = after.slice(0, 400);
  return `<note_before_cursor>\n${b}\n</note_before_cursor>\n<note_after_cursor>\n${a}\n</note_after_cursor>\nText to insert at the cursor:`;
}

/** 对话模型的回答不带开头的空格：光标前是英文单词或标点结尾、回答以单词开头时补一个（FIM 会接半个单词，不走这里） */
export function spaceChatReply(raw: string, before: string): string {
  return /[A-Za-z0-9.,;:!?)\]]$/.test(before) && /^[A-Za-z0-9(`*$[]/.test(raw) ? " " + raw : raw;
}

/** 清理模型的回答：去掉围栏 / 引号、只留一行、去掉重复光标前已有的字；没用的回 "" */
export function cleanCompletion(raw: string, before: string, after: string): string {
  let s = raw.replace(/\r/g, "");
  s = s.replace(/^\s*```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
  s = s.replace(/^<\/?note[^>]*>/g, "");
  if (/^\s*\n/.test(s)) s = s.replace(/^\s*\n/, "");
  s = s.split("\n")[0] ?? "";
  if (/^(["“'`]).*\1$/.test(s.trim()) && s.trim().length > 2) s = s.trim().slice(1, -1);
  // 模型把光标前的结尾又写了一遍：去掉重叠的部分
  const tail = before.slice(-60);
  for (let k = Math.min(tail.length, s.length); k >= 4; k--) if (tail.endsWith(s.slice(0, k))) { s = s.slice(k); break; }
  if (/\s$/.test(before)) s = s.replace(/^\s+/, "");
  s = s.replace(/\s+$/, "");
  if (s.length > 240) s = s.slice(0, 240).replace(/\s+\S*$/, "");
  if (!s.trim() || (after && after.startsWith(s))) return "";
  return s;
}
