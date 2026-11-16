import Foundation

/// What is typed in the address, read as an address
enum WebAddress {
  /// An http(s) address as typed, or a host with a dot (or localhost, or an IP address) and maybe a port and path,
  /// over https (http for localhost and IP addresses). Anything else, words to search for among them, is not an
  /// address: nil
  static func url(from text: String) -> URL? {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, !t.contains(where: \.isWhitespace) else { return nil }
    if let u = URL(string: t), let scheme = u.scheme?.lowercased() {
      if ["http", "https"].contains(scheme) { return u.host()?.isEmpty == false ? u : nil }
      // another scheme, unless it is a host before its port (localhost:8080)
      guard t.dropFirst(scheme.count + 1).first?.isNumber == true else { return nil }
    }
    guard let u = URL(string: "http://" + t), u.user() == nil, let host = u.host()?.lowercased(), !host.isEmpty
    else { return nil }
    let local = host == "localhost" || host.contains(":") || isIPv4(host)
    let tld = host.split(separator: ".").last.map(String.init) ?? ""
    guard local || (host.contains(".") && tld.count >= 2 && tld.allSatisfy(\.isLetter)) else { return nil }
    return URL(string: (local ? "http://" : "https://") + t)
  }

  /// What the bar shows of an address: its host without www., or the whole address when it has none
  static func shown(_ url: URL?) -> String {
    guard let url else { return "" }
    guard let host = url.host(), !host.isEmpty else { return url.absoluteString }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
  }

  private static func isIPv4(_ host: String) -> Bool {
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    return parts.count == 4 && parts.allSatisfy { UInt8($0) != nil }
  }
}

/// The addresses visited in web tabs, which the address suggests from: one small JSON file in the Mac's web data
struct WebHistory: Equatable {
  struct Entry: Codable, Equatable {
    var url: URL
    var title: String
    var lastVisit: Date
    var count: Int
  }

  var entries: [Entry] = []
  /// The most kept; past it the least recently visited go
  static let cap = 1000

  /// `url` visited (its fragment is the same page); not `counted`: only its title came, which may be before or after
  /// the visit
  mutating func visit(_ url: URL, title: String?, at date: Date, counted: Bool = true) {
    guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
    c.fragment = nil
    guard let page = c.url else { return }
    let title = title.flatMap { $0.isEmpty ? nil : $0 }
    if let i = entries.firstIndex(where: { $0.url == page }) {
      if counted {
        entries[i].count += 1
        entries[i].lastVisit = date
      }
      if let title { entries[i].title = title }
    } else {
      entries.append(Entry(url: page, title: title ?? "", lastVisit: date, count: counted ? 1 : 0))
    }
    if entries.count > Self.cap {
      entries.sort { $0.lastVisit > $1.lastVisit }
      entries.removeLast(entries.count - Self.cap)
    }
  }

  /// The entries `text` names, best first: those whose address (without its scheme and www.) starts with it, then
  /// those whose host or title holds it; among them the most visited, then the latest
  func matches(_ text: String, limit: Int = 6) -> [Entry] {
    let q = text.trimmingCharacters(in: .whitespaces).lowercased()
    guard !q.isEmpty else { return [] }
    func rank(_ e: Entry) -> Int? {
      var address = e.url.absoluteString.lowercased()
      for p in ["https://", "http://", "www."] where address.hasPrefix(p) { address.removeFirst(p.count) }
      if address.hasPrefix(q) { return 0 }
      if (e.url.host() ?? "").lowercased().contains(q) || e.title.lowercased().contains(q) { return 1 }
      return nil
    }
    let ranked: [(entry: Entry, rank: Int)] = entries.compactMap { e in rank(e).map { (e, $0) } }
    return ranked.sorted { a, b in
      if a.rank != b.rank { return a.rank < b.rank }
      if a.entry.count != b.entry.count { return a.entry.count > b.entry.count }
      return a.entry.lastVisit > b.entry.lastVisit
    }
    .prefix(limit).map(\.entry)
  }

  /// Nothing there or unreadable: no history
  static func read(_ file: URL) -> WebHistory {
    guard let data = try? Data(contentsOf: file), let entries = try? JSONDecoder().decode([Entry].self, from: data)
    else { return WebHistory() }
    return WebHistory(entries: entries)
  }

  func write(_ file: URL) throws {
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(entries).write(to: file, options: .atomic)
  }
}

/// The history file read and written off the main thread, one visit at a time, so that tabs do not write over each
/// other's visits
actor WebHistoryFile {
  static let shared = WebHistoryFile()

  func visit(_ url: URL, title: String?, at date: Date, counted: Bool = true, in file: URL) {
    var h = WebHistory.read(file)
    h.visit(url, title: title, at: date, counted: counted)
    try? h.write(file)
  }

  func read(_ file: URL) -> WebHistory { WebHistory.read(file) }
}
