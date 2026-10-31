/** 网址的路径部分（什么都没抓到时显示）：/wiki/x?tab=notes */
export function urlPath(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname + u.search + u.hash;
    return p === "/" ? "" : p;
  } catch {
    return "";
  }
}
