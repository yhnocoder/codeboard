// ⌘K's preview pane: a card or sidenote as Markdown, and where it sits. Both the word matches (search.ts) and Related by
// Meaning (meaning.ts) send it with their results, so moving through the list shows each one without asking the host again.
// Also what both of them look through: a sidenote's text, and which cards are left out.
import { cardTitle, type Board, type Card, type SearchPreview, type Sidenote } from "@codeboard/core";

/** Enough of a card to read in the pane (each word match carries one, up to 60 of them); the rest is cut: the card is one
 *  Enter away */
const PREVIEW_CHARS = 2000;

/** board › Section › … the card is in */
export function whereOf(b: Board, card: string): string {
  const out: string[] = [];
  for (
    let s = b.sections.find((x) => x.id === b.place[card]?.section);
    s;
    s = b.sections.find((x) => x.id === s!.parent)
  ) {
    out.unshift(s.title);
    if (out.length > 8) break;
  }
  return [b.name, ...out].filter(Boolean).join(" › ");
}

const fence = (lang: string, text: string) => {
  const ticks = /```/.test(text) ? "````" : "```";
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

/** A card's content as Markdown: its description, then what it shows */
export function cardMarkdown(c: Card, b: Board): string {
  const own = (() => {
    switch (c.kind) {
      case "note":
        return c.md;
      case "code":
        return c.segments
          .map(
            (s) =>
              `\`${s.path ? `${s.path}:${s.start}` : (s.symbol?.qual ?? "code")}\`\n\n${fence(s.lang, s.text.join("\n"))}`,
          )
          .join("\n\n");
      case "image":
        return `![${(c.alt ?? "").replace(/[[\]]/g, "")}](<${imageSrc(c)}>)${c.alt ? `\n\n*${c.alt}*` : ""}`;
      case "web":
        return [c.meta?.title && `**${c.meta.title}**`, c.meta?.desc, c.url].filter(Boolean).join("\n\n");
      case "links":
        return c.items.map((i) => `- ${i.title ?? i.meta?.title ?? i.url} — ${i.url}`).join("\n");
      default:
        return `**${cardTitle(c, b)}**`;
    }
  })();
  return [c.desc, own].filter(Boolean).join("\n\n");
}

/** An Image card's picture as a Note writes it, so the preview shows it the way a Note does (its smaller copies included) */
export const imageSrc = (c: Extract<Card, { kind: "image" }>) =>
  /^(data:|https?:|assets\/)/.test(c.src) ? c.src : `assets/${c.src}`;

export function sidenoteMarkdown(n: Sidenote): string {
  switch (n.kind) {
    case "text":
      return n.md;
    case "code":
      return fence(n.code.lang, n.code.text.join("\n"));
    case "paste":
      return fence(n.lang, n.text);
    case "link":
      return `[${n.title || n.url}](${n.url})`;
    default:
      return "";
  }
}

/** A sidenote's text, as both searches read it */
export function sidenoteText(n: Sidenote): string {
  return n.kind === "text"
    ? n.md
    : n.kind === "code"
      ? n.code.text.join("\n")
      : n.kind === "paste"
        ? n.text
        : n.kind === "link"
          ? `${n.title ?? ""} ${n.url}`
          : "";
}

/** A code card shown only as a column of a Compare (not placed on its own): searches find the Compare, not it */
export const compareColumn = (b: Board, c: Card) =>
  !b.place[c.id] && c.kind === "code" && b.cards.some((k) => k.kind === "compare" && k.cols.includes(c.id));

/** hit: the passage that matched; picture: the picture that did (its address as md writes it) */
export function preview(md: string, where: string, hit?: string, picture?: string): SearchPreview {
  const marks = { ...(hit ? { hit } : {}), ...(picture ? { picture } : {}) };
  if (md.length <= PREVIEW_CHARS) return { md, where, ...marks };
  // a long card: the stretch around what matched (from a line start), so its mark is in what is sent
  const at = picture ? md.indexOf(picture) : hit ? md.indexOf(hit.split(/\s+/).slice(0, 4).join(" ").slice(0, 40)) : -1;
  const from = at > PREVIEW_CHARS / 4 ? md.lastIndexOf("\n", at - PREVIEW_CHARS / 4) + 1 : 0;
  const part = md.slice(from, from + PREVIEW_CHARS);
  return { md: `${from ? "…\n\n" : ""}${part}\n\n…`, where, ...marks };
}
