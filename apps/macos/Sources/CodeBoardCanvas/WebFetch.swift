import CryptoKit
import Foundation

// Reading a page once for its card (the web board's host/src/web.ts): its title, description, site name, picture and
// icon, off the main thread. Only the page's head is read (1.5 MB at most), pictures up to 3 MB; a page that is not
// HTML, answers with an error or sends to a sign-in page is a failed read. Tests give their own fetcher.

/// What was read of a page; images as their bytes and the file extension their bytes say
package struct WebPage: Sendable, Equatable {
  package var title: String?
  package var description: String?
  package var site: String?
  package var image: Asset?
  package var icon: Asset?
  package var failed: Bool

  package struct Asset: Sendable, Equatable {
    package var data: Data
    package var ext: String

    package init(data: Data, ext: String) {
      self.data = data
      self.ext = ext
    }

    /// Its file name in the board's images: the first 16 of its SHA-1, then its extension
    package var name: String {
      Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(16) + "." + ext
    }
  }

  package init(
    title: String? = nil, description: String? = nil, site: String? = nil, image: Asset? = nil, icon: Asset? = nil,
    failed: Bool = false
  ) {
    self.title = title
    self.description = description
    self.site = site
    self.image = image
    self.icon = icon
    self.failed = failed
  }

  package static let failure = WebPage(failed: true)
}

package typealias WebFetch = @Sendable (URL) async -> WebPage

package enum WebFetcher {
  package static let live: WebFetch = { url in await fetch(url) }

  static let agent = "Mozilla/5.0 (compatible; CodeBoard; +https://github.com/yhnocoder/codeboard)"
  static let pageLimit = 1_500_000
  static let imageLimit = 3_000_000

  static let session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 6
    c.timeoutIntervalForResource = 6
    c.httpAdditionalHeaders = ["User-Agent": agent, "Accept-Language": "en,*;q=0.5"]
    return URLSession(configuration: c)
  }()

  package static func fetch(_ url: URL, session: URLSession = WebFetcher.session) async -> WebPage {
    guard let (head, final) = await page(url, session: session) else { return .failure }
    let m = parse(head, base: final)
    var out = WebPage(title: m.title, description: m.description, site: m.site)
    if let u = m.image { out.image = await asset(u, session: session) }
    for u in m.icons {
      if let a = await asset(u, session: session) {
        out.icon = a
        break
      }
    }
    out.failed = out.title == nil && out.description == nil
    return out
  }

  /// The page's head as text, and where it was read from after redirects; nil: not a page that can be read
  static func page(_ url: URL, session: URLSession) async -> (String, URL)? {
    var req = URLRequest(url: url)
    req.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "Accept")
    guard let (bytes, resp) = try? await session.bytes(for: req), let http = resp as? HTTPURLResponse,
      (200..<300).contains(http.statusCode)
    else { return nil }
    let type = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
    guard type.isEmpty || type.contains("html") else { return nil }
    let final = http.url ?? url
    // sent to sign in: nothing of the page itself
    let path = final.path.lowercased()
    if ["login", "signin", "sign-in", "sign_in", "sso", "auth", "accounts"].contains(where: { path.contains($0) }) {
      return nil
    }
    var data = Data()
    let end = Array("</head>".utf8)
    do {
      for try await b in bytes {
        data.append(b)
        if data.count >= pageLimit { break }
        if b == UInt8(ascii: ">"), data.count >= end.count, data.suffix(end.count).elementsEqual(end) { break }
      }
    } catch {
      if data.isEmpty { return nil }
    }
    let charset =
      type.firstMatch(of: /charset=([\w-]+)/).map { String($0.1) }
      ?? String(decoding: data.prefix(4096), as: UTF8.self).lowercased()
      .firstMatch(of: /<meta[^>]*charset=["']?([\w-]+)/).map { String($0.1) }
    var enc = String.Encoding.utf8
    if let charset {
      let cf = CFStringConvertIANACharSetNameToEncoding(charset as CFString)
      if cf != kCFStringEncodingInvalidId {
        enc = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(cf))
      }
    }
    let text = String(data: data, encoding: enc) ?? String(decoding: data, as: UTF8.self)
    return (text, final)
  }

  /// What a page's head says of it: the first of each meta, by property, name or itemprop
  package static func parse(_ html: String, base page: URL) -> (
    title: String?, description: String?, site: String?, image: URL?, icons: [URL]
  ) {
    var meta: [String: String] = [:]
    for tag in html.matches(of: /<meta\b[^>]*>/.ignoresCase()) {
      let a = attributes(String(tag.0))
      guard let key = (a["property"] ?? a["name"] ?? a["itemprop"])?.lowercased(), let v = a["content"] else {
        continue
      }
      if meta[key] == nil { meta[key] = v }
    }
    let base =
      html.firstMatch(of: /<base\b[^>]*>/.ignoresCase()).flatMap { attributes(String($0.0))["href"] }
      .flatMap { URL(string: $0, relativeTo: page) } ?? page
    func pick(_ keys: [String]) -> String? {
      keys.lazy.compactMap { meta[$0].map(clean) }.first { !$0.isEmpty }
    }
    let titleTag = html.firstMatch(of: /<title[^>]*>([\s\S]*?)<\/title>/.ignoresCase()).map { clean(String($0.1)) }
    let title = pick(["og:title", "twitter:title"]) ?? titleTag.flatMap { $0.isEmpty ? nil : $0 }
    var desc = pick(["og:description", "twitter:description", "description"])
    if let d = desc, d.count > 320 { desc = String(d.prefix(317)) + "…" }
    let site = pick(["og:site_name", "application-name"])
    func http(_ s: String?) -> URL? {
      guard let s, let u = URL(string: s, relativeTo: base)?.absoluteURL, ["http", "https"].contains(u.scheme ?? "")
      else { return nil }
      return u
    }
    let image = http(
      pick(["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]))
    // icons: the one nearest 32 across, an SVG first, an apple-touch one after the others of its size
    var icons: [(URL, Double)] = []
    for tag in html.matches(of: /<link\b[^>]*>/.ignoresCase()) {
      let a = attributes(String(tag.0))
      let rel = (a["rel"] ?? "").lowercased().split(separator: " ")
      let apple = rel.contains("apple-touch-icon")
      guard apple || rel.contains("icon"), let u = http(a["href"]) else { continue }
      let size = (a["sizes"] ?? "").split(separator: "x").first.flatMap { Double($0) } ?? (apple ? 180 : 16)
      let svg = u.pathExtension.lowercased() == "svg" || (a["type"] ?? "").contains("svg")
      icons.append((u, svg ? 0 : abs(size - 32) + (apple ? 8 : 0)))
    }
    var urls = icons.sorted { $0.1 < $1.1 }.map(\.0)
    if let f = URL(string: "/favicon.ico", relativeTo: base)?.absoluteURL { urls.append(f) }
    return (title, desc, site, image, urls)
  }

  /// A tag's attributes, names lowercased, entities decoded
  static func attributes(_ tag: String) -> [String: String] {
    var out: [String: String] = [:]
    for m in tag.matches(of: /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/) {
      let v = m.2 ?? m.3 ?? m.4 ?? ""
      out[m.1.lowercased()] = entities(String(v))
    }
    return out
  }

  /// Whitespace collapsed, entities decoded
  static func clean(_ s: String) -> String {
    entities(s).split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  static func entities(_ s: String) -> String {
    guard s.contains("&") else { return s }
    var out = s.replacing(/&#[xX]([0-9a-fA-F]+);/) { m in
      UInt32(m.1, radix: 16).flatMap(Unicode.Scalar.init).map { String(Character($0)) } ?? String(m.0)
    }
    out = out.replacing(/&#([0-9]+);/) { m in
      UInt32(m.1).flatMap(Unicode.Scalar.init).map { String(Character($0)) } ?? String(m.0)
    }
    for (k, v) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&nbsp;", " ")] {
      out = out.replacingOccurrences(of: k, with: v)
    }
    return out.replacingOccurrences(of: "&amp;", with: "&")
  }

  /// A picture's bytes, when they are a picture of a kind the board shows
  static func asset(_ url: URL, session: URLSession) async -> WebPage.Asset? {
    guard let (data, resp) = try? await session.data(from: url), let http = resp as? HTTPURLResponse,
      (200..<300).contains(http.statusCode), data.count <= imageLimit, let ext = sniff(data)
    else { return nil }
    return WebPage.Asset(data: data, ext: ext)
  }

  /// What its bytes say it is: png, jpeg, gif, webp, svg, ico or avif
  package static func sniff(_ d: Data) -> String? {
    let b = [UInt8](d.prefix(32))
    func starts(_ p: [UInt8], at i: Int = 0) -> Bool { b.count >= i + p.count && Array(b[i..<i + p.count]) == p }
    if starts([0x89, 0x50, 0x4E, 0x47]) { return "png" }
    if starts([0xFF, 0xD8, 0xFF]) { return "jpeg" }
    if starts(Array("GIF8".utf8)) { return "gif" }
    if starts(Array("RIFF".utf8)), starts(Array("WEBP".utf8), at: 8) { return "webp" }
    if starts([0, 0, 1, 0]) { return "ico" }
    if starts(Array("ftypavif".utf8), at: 4) { return "avif" }
    let head = String(decoding: d.prefix(512), as: UTF8.self).lowercased()
    if head.contains("<svg") { return "svg" }
    return nil
  }
}
