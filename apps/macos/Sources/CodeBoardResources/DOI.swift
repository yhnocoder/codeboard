import CodeBoardModel
import Foundation

// Papers by DOI: the DOI read from what the user typed or pasted, the paper's metadata from doi.org by content
// negotiation (CSL JSON, as Crossref and DataCite answer it), and the entry made of it. A DOI gives no PDF. Every
// request goes through one transport, as arXiv's do, so tests answer it without the network.

/// What doi.org says about a paper
public struct DOIPaper: Equatable, Sendable {
  /// As given; DOIs are compared lowercased
  public var doi: String
  /// Nil when the metadata has none
  public var title: String?
  public var authors: [String]
  public var year: Int?
  /// Its journal or proceedings; for a book, report, thesis or dataset (which are in none), its publisher
  public var venue: String?

  public init(doi: String, title: String?, authors: [String], year: Int?, venue: String? = nil) {
    self.doi = doi
    self.title = title
    self.authors = authors
    self.year = year
    self.venue = venue
  }
}

public enum DOIError: Error, Equatable, CustomStringConvertible {
  case notADOI(String)
  case notFound(String)
  case offline(String)
  case http(Int)
  case unreadable

  public var description: String {
    switch self {
    case .notADOI(let s): "“\(s)” is not a DOI or a doi.org address."
    case .notFound(let doi): "No paper has the DOI \(doi)."
    case .offline(let why): "Could not reach doi.org: \(why)"
    case .http(let status): "doi.org answered with an error (HTTP \(status)). Try again later."
    case .unreadable: "doi.org's answer could not be read. Try again later."
    }
  }
}

/// What a paper is known by, read from what the user typed or pasted
public enum PaperID: Equatable, Sendable {
  /// An arXiv id without its version, and the version asked for
  case arxiv(String, version: Int?)
  case doi(String)

  /// An arXiv id or address, or a DOI (an arXiv DOI, `10.48550/arXiv.<id>`, is that arXiv paper); nil when it is
  /// neither
  public static func parse(_ text: String) -> PaperID? {
    if let (id, v) = Arxiv.parse(text) { return .arxiv(id, version: v) }
    return DOI.parse(text).map(of)
  }

  /// The DOI as the paper it names
  static func of(_ doi: String) -> PaperID {
    if let m = doi.wholeMatch(of: /(?i)10\.48550\/arxiv\.(.+)/), let (id, v) = Arxiv.parse(String(m.1)) {
      return .arxiv(id, version: v)
    }
    return .doi(doi)
  }
}

public struct DOI: Sendable {
  public var transport: Arxiv.Transport

  public init(transport: @escaping Arxiv.Transport = Arxiv.session) { self.transport = transport }

  /// The DOI in `10.1145/3292500.3330701`, `doi:10.…` or a `doi.org` / `dx.doi.org` address, as given; nil when it is
  /// none of these
  public static func parse(_ text: String) -> String? {
    var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.lowercased().hasPrefix("doi:") { s = String(s.dropFirst(4)).trimmingCharacters(in: .whitespaces) }
    if let url = URLComponents(string: s), let host = url.host?.lowercased() {
      guard ["doi.org", "dx.doi.org", "www.doi.org"].contains(host) else { return nil }
      s = String(url.path.dropFirst())
    }
    return s.wholeMatch(of: /10\.\d{4,9}\/\S+/) != nil ? s : nil
  }

  /// The paper's metadata from `https://doi.org/<doi>`, asked for as CSL JSON
  public func paper(_ doi: String) async throws(DOIError) -> DOIPaper {
    var url = URLComponents(string: "https://doi.org")!
    url.path = "/" + doi
    var req = URLRequest(url: url.url!, timeoutInterval: 60)
    req.setValue("CodeBoard", forHTTPHeaderField: "User-Agent")
    req.setValue("application/vnd.citationstyles.csl+json", forHTTPHeaderField: "Accept")
    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport(req)
    } catch {
      throw .offline(error.localizedDescription)
    }
    switch response.statusCode {
    case 200..<300: break
    case 404: throw .notFound(doi)
    default: throw .http(response.statusCode)
    }
    guard let csl = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw .unreadable }
    return Self.paper(doi, csl)
  }

  /// CSL JSON's fields as a paper's
  static func paper(_ doi: String, _ csl: [String: Any]) -> DOIPaper {
    // a title or a container may be a string or a list of them; Crossref's titles may carry HTML (`<i>`)
    func text(_ key: String) -> String? {
      let v = csl[key]
      let s = (v as? String) ?? (v as? [String])?.first
      let t = s?.replacing(/<[^>]+>/, with: "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
      return t?.isEmpty == false ? t : nil
    }
    let authors = (csl["author"] as? [[String: Any]] ?? []).compactMap { a -> String? in
      if let l = a["literal"] as? String { return l }
      let name = [a["given"], a["family"]].compactMap { $0 as? String }.joined(separator: " ")
      return name.isEmpty ? nil : name
    }
    let first = ((csl["issued"] as? [String: Any])?["date-parts"] as? [[Any]])?.first?.first
    let year = (first as? Int) ?? (first as? String).flatMap { Int($0) }
    // a book, report, thesis or dataset is in no journal: where it was published is its publisher
    let alone = ["book", "monograph", "report", "thesis", "dataset"].contains(csl["type"] as? String ?? "")
    return DOIPaper(
      doi: doi, title: text("title"), authors: authors, year: year,
      venue: text("container-title") ?? (alone ? text("publisher") : nil))
  }
}

extension Vault {
  /// A new entry for the paper in the resource at `resource`, with no version (a DOI gives no PDF): the entry folder
  /// named for its title (its DOI when it has none). Its entry and folder
  public func newEntry(_ paper: DOIPaper, in resource: String) throws -> (Entry, String) {
    let e = Entry(
      id: EntryID(rawValue: Board.newID("e")), title: paper.title ?? paper.doi, added: Entry.now,
      origin: .doi(paper.doi), authors: paper.authors.isEmpty ? nil : paper.authors, year: paper.year,
      venue: paper.venue)
    return (e, try newEntry(e, in: resource))
  }
}
