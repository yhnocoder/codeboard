// Table column widths, row heights and whether a code block wraps: not Markdown (GFM cannot hold them), so the caller
// keeps them in its own data (the board: on the Note card), matched by position (nth table, nth code block). In the
// editor they are attributes of the table and code block nodes (editor/srcdoc.ts); the static render gets them from
// applyMdLayout. Keeping them out of the Markdown keeps Notes plain GFM for every other reader.

/** Per table (null = all automatic), and which code blocks wrap */
export type MdLayout = { tables?: (TableLayout | null)[]; wrap?: number[] };
/** Column widths and row heights in px; null = automatic */
export type TableLayout = { cols?: (number | null)[]; rows?: (number | null)[] };

/** As in the editor's tables (prosemirror-tables column widths): a column without a width is at least 25px */
export const CELL_MIN = 25;

/** Call after renderMd's HTML is put into el (again after each re-render): sizes the tables, wraps the code blocks */
export function applyMdLayout(el: HTMLElement, layout: MdLayout | null | undefined) {
  if (!layout && !el.querySelector("table[data-md-style], pre.md-code.wrap")) return;
  el.querySelectorAll("table").forEach((t, i) => sizeTable(t, layout?.tables?.[i] ?? null));
  const codes = [...el.querySelectorAll<HTMLElement>(".mmd, pre.md-code")].filter(
    (p) => !p.parentElement?.closest(".mmd"),
  );
  codes.forEach((p, i) => p.classList.toggle("wrap", !!layout?.wrap?.includes(i)));
}

/** Sizes the static render's table: its own colgroup (one col per column, min-width CELL_MIN) gets the widths; the
 *  table's own style is kept aside and put back when the layout goes */
function sizeTable(t: HTMLTableElement, l: TableLayout | null) {
  if (t.dataset.mdStyle === undefined) t.dataset.mdStyle = t.getAttribute("style") ?? "";
  t.setAttribute("style", t.dataset.mdStyle);
  const rows = t.rows;
  for (let r = 0; r < rows.length; r++) rows[r].style.height = l?.rows?.[r] ? `${l.rows[r]}px` : "";
  const cols = l?.cols ?? [],
    n = Math.max(rows[0]?.cells.length ?? 0, cols.length);
  let g = t.querySelector<HTMLTableColElement>(":scope > colgroup");
  if (!g && !cols.some((w) => w)) return;
  if (!g) {
    g = document.createElement("colgroup");
    t.prepend(g);
  }
  while (g.children.length < n) g.append(document.createElement("col"));
  let total = 0,
    fixed = true;
  [...g.children].forEach((c, i) => {
    const w = cols[i] ?? null,
      st = (c as HTMLElement).style;
    if (w) {
      st.width = `${Math.max(w, CELL_MIN)}px`;
      st.minWidth = "";
    } else {
      st.width = "";
      st.minWidth = `${CELL_MIN}px`;
      fixed = false;
    }
    total += w ? Math.max(w, CELL_MIN) : CELL_MIN;
  });
  if (!cols.some((w) => w)) return;
  if (fixed) {
    t.style.width = `${total}px`;
    t.style.minWidth = "";
  } else {
    t.style.width = "";
    t.style.minWidth = `${total}px`;
  }
}
