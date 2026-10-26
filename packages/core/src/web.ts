export type PageMeta = { title?: string; desc?: string; site?: string; image?: string; icon?: string };

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "—", ndash: "–", hellip: "…", middot: "·", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, k: string) => {
    if (k[0] === "#") {
      const n = k[1] === "x" || k[1] === "X" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENT[k.toLowerCase()] ?? m;
  });
}
const clean = (s?: string) => { const t = s && decodeEntities(s).replace(/\s+/g, " ").trim(); return t || undefined; };

function attrs(tag: string): Record<string, string> {
  const o: Record<string, string> = {};
  const re = /([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  const body = tag.replace(/^<\s*\w+/, "").replace(/\/?>$/, "");
  while ((m = re.exec(body))) o[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return o;
}

function abs(u: string | undefined, base: string): string | undefined {
  if (!u) return undefined;
  try {
    const r = new URL(decodeEntities(u.trim()), base);
    return /^https?:$/.test(r.protocol) ? r.href : undefined;
  } catch { return undefined; }
}

/** 解析 HTML（只看 <head> 部分就够；body 太大时截断也没关系） */
export function parseWebMeta(html: string, url: string): PageMeta {
  const end = html.search(/<\/head\s*>/i);
  const head = end > 0 ? html.slice(0, end) : html.slice(0, 300_000);
  const meta = new Map<string, string>();
  let base = url;
  const icons: { href: string; rel: string; size: number }[] = [];
  for (const m of head.matchAll(/<(meta|link|base)\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const t = m[1].toLowerCase();
    if (t === "meta") {
      const k = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase();
      if (k && a.content !== undefined && !meta.has(k)) meta.set(k, a.content);
    } else if (t === "base" && a.href) base = abs(a.href, url) ?? base;
    else if (t === "link" && a.href) {
      const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
      if (rel.includes("icon") || rel.includes("apple-touch-icon")) {
        const size = parseInt((a.sizes ?? "").split("x")[0], 10) || (rel.includes("apple-touch-icon") ? 180 : 16);
        icons.push({ href: a.href, rel: rel.join(" "), size });
      }
    }
  }
  const tm = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  const title = clean(meta.get("og:title")) ?? clean(meta.get("twitter:title")) ?? clean(tm?.[1]);
  const desc = clean(meta.get("og:description")) ?? clean(meta.get("twitter:description")) ?? clean(meta.get("description"));
  const site = clean(meta.get("og:site_name")) ?? clean(meta.get("application-name"));
  const image = abs(meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image") ?? meta.get("twitter:image:src"), base);
  // 图标：rel=icon 里挑接近 32px 的（svg 最好），都没有就 /favicon.ico
  const score = (i: { href: string; rel: string; size: number }) => (/\.svg(\?|$)/i.test(i.href) ? 0 : Math.abs(i.size - 32) + (i.rel.includes("apple") ? 8 : 0));
  const best = icons.sort((a, b) => score(a) - score(b))[0];
  let icon = best ? abs(best.href, base) : undefined;
  if (!icon) { try { icon = new URL("/favicon.ico", url).href; } catch {} }
  return { title, desc, site, image, icon };
}

/** 网址的路径部分（什么都没抓到时显示）：/wiki/x?tab=notes */
export function urlPath(url: string): string {
  try { const u = new URL(url); const p = u.pathname + u.search + u.hash; return p === "/" ? "" : p; } catch { return ""; }
}

export function charsetOf(contentType: string | null | undefined, head: string): string {
  const c = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return (c ?? "utf-8").toLowerCase();
}
