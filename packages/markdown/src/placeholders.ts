// Private-use characters that stand in for others while text goes through a parser that would read or change them. They
// keep the length and position of what they replace; each use has its own block, so two never meet in one text

/** Marks the caret's place while a document is serialized (AI completion, source mode) */
export const CARET_MARK = "";
/** What an escaped \$ is read as (see TEXT_MATH in schema.ts): always a literal $, never a formula's */
export const ESC_DOLLAR = "";
/** Added to a character's code to hide it from TipTap's escaping (tiptap-markdown-patch.ts) */
export const SHIELD = 0xe200;
/** Added to a character's code to hide it from the parser while a pasted slice's marks are read (editor/pastemarks.ts) */
export const HIDE = 0xe400;

/** Every character in base + [lo, hi], for turning them back */
export const shifted = (base: number, lo: number, hi: number) =>
  new RegExp(`[${String.fromCharCode(base + lo)}-${String.fromCharCode(base + hi)}]`, "g");
