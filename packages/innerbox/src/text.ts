// What gets embedded: a document cut into short pieces (a few sentences each), each piece written with EmbeddingGemma's
// task prompt and the document's title, so a piece still says what it belongs to. A document matches by its best piece.

/** One thing to find: an id the caller knows, its title and its text. Where it sits is left out on purpose: renaming a board or
 *  a Section, or moving a card into another, would otherwise embed every card it holds again */
export type Doc = { id: string; title: string; text: string };

/** About this many characters per piece: a few sentences, short enough that one idea is not diluted by the rest */
const PIECE_CHARS = 280;
/** Pieces per document, at most: a very long Note still costs a bounded number of embeddings */
const MAX_PIECES = 24;

/** EmbeddingGemma's prompt for a search query */
export const queryText = (q: string) => `task: search result | query: ${q}`;

/** EmbeddingGemma's prompt for a document piece: the title and the text */
function pieceText(d: Pick<Doc, "title">, text: string): string {
  const title = d.title.trim();
  return `title: ${title || "none"} | text: ${text.trim() || title || "none"}`;
}

/** Sentences and lines: split after 。！？.!? and at line breaks, keeping each mark with its sentence */
function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[。！？!?])|(?<=[.;:])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A document's pieces as written in it: sentences packed up to PIECE_CHARS; a title-only document is one empty piece */
export function pieceBodies(d: Doc): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const s of sentences(d.text)) {
    for (let i = 0; i < s.length; i += PIECE_CHARS) {
      const part = s.slice(i, i + PIECE_CHARS);
      if (cur && cur.length + part.length + 1 > PIECE_CHARS) flush();
      cur = cur ? `${cur} ${part}` : part;
    }
    if (out.length >= MAX_PIECES) break;
  }
  flush();
  if (!out.length) out.push("");
  return out.slice(0, MAX_PIECES);
}

/** A document's pieces as embedded: each with the prompt and the title */
export const pieces = (d: Doc): string[] => pieceBodies(d).map((b) => pieceText(d, b));

/** A short fingerprint of a string (cyrb53): the key a piece's vector is kept under, so unchanged text is never embedded again */
export function fingerprint(s: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + s.length.toString(36);
}
