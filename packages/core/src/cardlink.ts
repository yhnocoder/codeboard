// A link to a board, a card or a Section (Copy Link): `<board file>#<id>`, the board alone as its file, a shared card as its
// file in the card library (cards/<id>.json#<id>). The same text points Claude Code at the item in the terminal and, put on
// words in a Note, links them to the item. Both the host (writing it) and the board (reading it in a Note) use this file only

const ID = /^[\w-]{1,80}$/;
/** The card library's folder in the storage folder */
export const CARD_LIBRARY = "cards";

/** The link to item (none: the board itself) whose content is in file, as the host shows that file's path */
export const cardLink = (file: string, item?: string) => (item ? `${file}#${item}` : file);

/** What a card link names: the board its file is (absent for the card library), and the item in it (absent for the board) */
export type CardLinkTo = { board?: string; item?: string };

/**
 * The board and item a link's address names, or null when it is no card link (a web address, any other file). Read as written
 * in Markdown too: in <angle brackets>, with its spaces and other characters %-encoded
 */
export function parseCardLink(href: string): CardLinkTo | null {
  let s = href.trim();
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);
  try {
    s = decodeURI(s);
  } catch {
    return null;
  }
  // a scheme (https:, mailto:, file:), but not a Windows drive (C:\…)
  if (/^[a-z][\w+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) return null;
  const k = s.lastIndexOf("#"),
    file = k < 0 ? s : s.slice(0, k),
    item = k < 0 ? undefined : s.slice(k + 1);
  const parts = file.split(/[\\/]/),
    name = /^(.+)\.json$/.exec(parts[parts.length - 1] ?? "")?.[1];
  if (!name || !ID.test(name) || (item !== undefined && !ID.test(item))) return null;
  if (parts[parts.length - 2] === CARD_LIBRARY) return item === undefined || item === name ? { item: name } : null;
  return item === undefined ? { board: name } : { board: name, item };
}
