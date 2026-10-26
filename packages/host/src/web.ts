// 网页元信息只在贴链接那一刻抓一次，图片存进 assets/，离线也能显示。
// 不带浏览器 cookie：需要登录的页面抓不到，白板降级显示（域名首字母 + 路径 + Retry）。
import { charsetOf, parseWebMeta, type WebMeta } from "@codeboard/core";
import type { Storage } from "./storage";
import { log } from "./log";

const UA = "Mozilla/5.0 (compatible; CodeBoard; +https://github.com/yhnocoder/codeboard)";
const PAGE_MAX = 1_500_000, IMG_MAX = 3_000_000, TIMEOUT = 6000;

/** 下载（超时、限大小、跟随跳转）；html = 读到 </head> 就停 */
async function grab(url: string, accept: string, max: number, html = false): Promise<{ buf: Buffer; type: string; url: string } | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ac.signal, headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en,*;q=0.5" } });
    if (!res.ok || !res.body) { log("info", `webMeta: ${res.status} ${url}`); return null; }
    const type = res.headers.get("content-type") ?? "";
    const len = +(res.headers.get("content-length") ?? 0);
    if (!html && len > max) return null;
    const parts: Buffer[] = [];
    let n = 0;
    const rd = res.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      parts.push(Buffer.from(value));
      n += value.length;
      if (html && /<\/head\s*>/i.test(Buffer.from(value).toString("latin1"))) break;
      if (n > max) { if (!html) { await rd.cancel().catch(() => {}); return null; } break; }
    }
    await rd.cancel().catch(() => {});
    return { buf: Buffer.concat(parts), type, url: res.url || url };
  } catch (e) {
    log("info", `webMeta: ${(e as Error).name === "AbortError" ? "timeout" : (e as Error).message} ${url}`);
    return null;
  } finally { clearTimeout(t); }
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/avif": "avif" };

async function saveImage(store: Storage, url: string, kind: "og" | "icon"): Promise<string | undefined> {
  const r = await grab(url, "image/*,*/*;q=0.5", IMG_MAX);
  if (!r || !r.buf.length) return undefined;
  let mime = r.type.split(";")[0].trim().toLowerCase();
  if (!EXT[mime] && /\.ico(\?|$)/i.test(url)) mime = "image/x-icon";
  if (!EXT[mime]) return undefined;
  return store.saveAsset(`${kind}.${EXT[mime]}`, `data:${mime};base64,${r.buf.toString("base64")}`).catch(() => undefined);
}

export async function webMeta(store: Storage, url: string): Promise<WebMeta> {
  const at = Date.now();
  const page = await grab(url, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", PAGE_MAX, true);
  if (!page || !/html|xml/i.test(page.type)) return { failed: true, at };
  // 被跳到登录页：标题是「Sign in」，不是这个页面的信息
  if (page.url !== url && /(^|[/.-])(login|signin|sign-in|sign_in|sso|auth|accounts)([/.?-]|$)/i.test(page.url.replace(/^https?:\/\//, ""))) return { failed: true, at };
  let html: string;
  try { html = new TextDecoder(charsetOf(page.type, page.buf.subarray(0, 4096).toString("latin1"))).decode(page.buf); }
  catch { html = page.buf.toString("utf8"); }
  const m = parseWebMeta(html, page.url);
  const fallbackIcon = new URL("/favicon.ico", page.url).href;
  const [image, icon] = await Promise.all([
    m.image ? saveImage(store, m.image, "og") : undefined,
    (async () => (m.icon ? await saveImage(store, m.icon, "icon") : undefined) ?? (m.icon !== fallbackIcon ? await saveImage(store, fallbackIcon, "icon") : undefined))(),
  ]);
  const meta: WebMeta = { at };
  if (m.title) meta.title = m.title;
  if (m.desc) meta.desc = m.desc.length > 320 ? `${m.desc.slice(0, 317).trimEnd()}…` : m.desc; // 卡上只显示两行，白板文件别存整篇摘要
  if (m.site) meta.site = m.site;
  if (image) meta.image = image;
  if (icon) meta.icon = icon;
  if (!m.title && !m.desc) meta.failed = true; // 登录页、空页面：按「什么都没抓到」显示（图标有就留着）
  return meta;
}
