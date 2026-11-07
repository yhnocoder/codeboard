// ⌘K's preview pane: a card or sidenote as Markdown, and where it sits. Both the word matches (search.ts) and Related by
// Meaning (meaning.ts) send it with their results, so moving through the list shows each one without asking the host again.
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
      case "image": {
        // as a Note writes it, so the preview shows the picture the way a Note does (its smaller copies included)
        const src = /^(data:|https?:|assets\/)/.test(c.src) ? c.src : `assets/${c.src}`;
        return `![${(c.alt ?? "").replace(/[[\]]/g, "")}](<${src}>)${c.alt ? `\n\n*${c.alt}*` : ""}`;
      }
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

export function preview(md: string, where: string, hit?: string): SearchPreview {
  if (md.length <= PREVIEW_CHARS) return { md, where, ...(hit ? { hit } : {}) };
  // a long card: the stretch around the passage that matched (from a line start), so its mark is in what is sent
  const at = hit ? md.indexOf(hit.split(/\s+/).slice(0, 4).join(" ").slice(0, 40)) : -1;
  const from = at > PREVIEW_CHARS / 4 ? md.lastIndexOf("\n", at - PREVIEW_CHARS / 4) + 1 : 0;
  const part = md.slice(from, from + PREVIEW_CHARS);
  return { md: `${from ? "…\n\n" : ""}${part}\n\n…`, where, ...(hit ? { hit } : {}) };
}
