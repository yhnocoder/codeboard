// How a long web address written as it is shows, in the editor and in the static render alike (so the text does not reflow
// when editing starts or ends)

/** A web address too long to read at a glance shows as its site and an ellipsis */
export const LONG_URL = 40;
export function shortUrl(u: string): string {
  try {
    const x = new URL(/^www\./i.test(u) ? `https://${u}` : u);
    const rest = x.pathname.length > 1 || x.search || x.hash;
    return x.host.replace(/^www\./, "") + (rest ? "/…" : "");
  } catch {
    return u.length > 24 ? `${u.slice(0, 22)}…` : u;
  }
}
