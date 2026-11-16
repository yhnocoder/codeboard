import CodeBoardModel
import Foundation

// Papers from arXiv: an id read from what the user typed or pasted, the paper's metadata from the arXiv API (Atom), its
// PDF, and the entry made of them. Every request goes through one transport, so tests answer it without the network.

/// What arXiv says about a paper
public struct ArxivPaper: Equatable, Sendable {
  /// Without a version: `1706.03762`, `hep-th/9901001`
  public var id: String
  public var title: String
  public var authors: [String]
  /// When its first version came out
  public var year: Int?
  /// Where it was published, when its authors told arXiv (its journal reference)
  public var venue: String?
  /// Its newest version's number
  public var latest: Int

  public init(id: String, title: String, authors: [String], year: Int?, venue: String? = nil, latest: Int) {
    self.id = id
    self.title = title
    self.authors = authors
    self.year = year
    self.venue = venue
    self.latest = latest
  }
}

public enum ArxivError: Error, Equatable, CustomStringConvertible {
  case notAnID(String)
  case notFound(String)
  case offline(String)
  case http(Int)
  case unreadable

  public var description: String {
    switch self {
    case .notAnID(let s): "“\(s)” is not an arXiv id or address."
    case .notFound(let id): "arXiv has no paper \(id)."
    case .offline(let why): "Could not reach arXiv: \(why)"
    case .http(let status): "arXiv answered with an error (HTTP \(status)). Try again later."
    case .unreadable: "arXiv's answer could not be read. Try again later."
    }
  }
}

public struct Arxiv: Sendable {
  /// One request and its answer; the default is URLSession's
  public typealias Transport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

  public var transport: Transport

  public static let session: Transport = { req in
    let (data, response) = try await URLSession.shared.data(for: req)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    return (data, http)
  }

  public init(transport: @escaping Transport = Arxiv.session) { self.transport = transport }

  /// The id and the version asked for, from `1706.03762`, `1706.03762v7`, `arXiv:1706.03762`, an abs, pdf or html
  /// address, or an old-style id (`hep-th/9901001`); nil when it is none of these
  public static func parse(_ text: String) -> (id: String, version: Int?)? {
    var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.lowercased().hasPrefix("arxiv:") { s.removeFirst(6) }
    if let url = URLComponents(string: s), let host = url.host?.lowercased(),
      host == "arxiv.org" || host.hasSuffix(".arxiv.org")
    {
      guard let prefix = ["/abs/", "/pdf/", "/html/"].first(where: url.path.hasPrefix) else { return nil }
      s = String(url.path.dropFirst(prefix.count))
      while s.hasSuffix("/") { s.removeLast() }
      if s.hasSuffix(".pdf") { s.removeLast(4) }
    }
    guard let m = s.wholeMatch(of: /(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v(\d+))?/) else { return nil }
    return (String(m.1), m.2.flatMap { Int($0) })
  }

  /// The paper's metadata from `export.arxiv.org/api/query`
  public func paper(_ id: String) async throws(ArxivError) -> ArxivPaper {
    var q = URLComponents(string: "https://export.arxiv.org/api/query")!
    q.queryItems = [URLQueryItem(name: "id_list", value: id)]
    let data = try await get(q.url!, of: id)
    let feed = AtomFeed(data)
    guard feed.read else { throw .unreadable }
    // an id arXiv does not know: no entry, or one whose id is the API's error page
    guard let e = feed.entries.first, let latest = Self.parse(e.id).flatMap(\.version) else { throw .notFound(id) }
    let title = e.title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return ArxivPaper(
      id: id, title: title, authors: e.authors, year: Int(e.published.prefix(4)),
      venue: e.venue.isEmpty ? nil : e.venue.split(whereSeparator: \.isWhitespace).joined(separator: " "),
      latest: latest)
  }

  /// Version `version` of the paper's PDF
  public func pdf(_ id: String, version: Int) async throws(ArxivError) -> Data {
    let data = try await get(URL(string: "https://arxiv.org/pdf/\(id)v\(version)")!, of: "\(id)v\(version)")
    guard data.starts(with: Data("%PDF".utf8)) else { throw .notFound("\(id)v\(version)") }
    return data
  }

  /// `paper`: what was asked for, as a paper not found is named
  private func get(_ url: URL, of paper: String) async throws(ArxivError) -> Data {
    var req = URLRequest(url: url, timeoutInterval: 60)
    req.setValue("CodeBoard", forHTTPHeaderField: "User-Agent")
    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport(req)
    } catch {
      throw .offline(error.localizedDescription)
    }
    switch response.statusCode {
    case 200..<300: return data
    case 404: throw .notFound(paper)
    default: throw .http(response.statusCode)
    }
  }

  /// The file a version's PDF is kept as in its entry's folder: `1706.03762v7.pdf` (`/` of an old id as `_`)
  public static func fileName(_ id: String, version: Int) -> String {
    "\(id.replacing("/", with: "_"))v\(version).pdf"
  }

  /// The number of a version labelled `v<n>`
  public static func number(_ v: Version) -> Int? {
    v.label.flatMap { $0.wholeMatch(of: /v(\d+)/) }.flatMap { Int($0.1) }
  }

  /// The paper's newest version added to its entry (at `found`) as one more Version, when arXiv has one newer than any
  /// it holds; the version added, nil when there was none newer. Nothing it held changes
  public func addLatestVersion(to found: EntryIndex.Found, in vault: Vault) async throws -> Version? {
    guard case .arxiv(let id)? = found.entry.origin else { return nil }
    let held = found.entry.versions.filter { $0.of == nil }.compactMap(Self.number).max() ?? 0
    let latest = try await paper(id).latest
    guard latest > held else { return nil }
    let pdf = try await pdf(id, version: latest)
    let file = try vault.addEntryFile(pdf, named: Self.fileName(id, version: latest), to: found.path)
    let v = Version(
      id: VersionID(rawValue: Board.newID("v")), label: "v\(latest)", added: Entry.now, language: "en",
      content: .pdf(file: file))
    var e = try vault.entry(at: found.path)
    e.versions.append(v)
    try vault.write(e, at: found.path)
    return v
  }
}

extension Vault {
  /// A new entry for the paper in the resource at `resource`, holding its version `version` as `pdf`: the entry folder
  /// named for its title, made with the file in it whole. Its entry and folder
  public func newEntry(_ paper: ArxivPaper, version: Int, pdf: Data, in resource: String) throws -> (Entry, String) {
    let file = Arxiv.fileName(paper.id, version: version)
    let now = Entry.now
    let e = Entry(
      id: EntryID(rawValue: Board.newID("e")), title: paper.title, added: now, origin: .arxiv(paper.id),
      authors: paper.authors, year: paper.year, venue: paper.venue,
      versions: [
        Version(
          id: VersionID(rawValue: Board.newID("v")), label: "v\(version)", added: now, language: "en",
          content: .pdf(file: file))
      ])
    return (e, try newEntry(e, in: resource, with: [file: pdf]))
  }
}

extension Entry {
  /// Now, as entry files keep times (ms since 1970)
  public static var now: Double { (Date().timeIntervalSince1970 * 1000).rounded() }
}

/// The parts of the API's Atom feed a paper is made of
private final class AtomFeed: NSObject, XMLParserDelegate {
  struct Item {
    var id = ""
    var title = ""
    var published = ""
    var venue = ""
    var authors: [String] = []
  }

  private(set) var entries: [Item] = []
  private(set) var read = false
  private var item: Item?
  private var text = ""
  private var inAuthor = false

  init(_ data: Data) {
    super.init()
    let p = XMLParser(data: data)
    p.delegate = self
    read = p.parse()
  }

  func parser(
    _ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?,
    attributes: [String: String] = [:]
  ) {
    text = ""
    if name == "entry" { item = Item() }
    if name == "author" { inAuthor = true }
  }

  func parser(_ parser: XMLParser, foundCharacters string: String) { text += string }

  func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    switch name {
    case "entry":
      if let item { entries.append(item) }
      item = nil
    case "author": inAuthor = false
    case "name" where inAuthor: item?.authors.append(t)
    case "id": item?.id = t
    case "title": item?.title = t
    case "published": item?.published = t
    case "arxiv:journal_ref", "journal_ref": item?.venue = t
    default: break
    }
    text = ""
  }
}
