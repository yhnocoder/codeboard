import CodeBoardModel
import Foundation

// A paper's title and authors without AI: what its PDF says about itself (document info, XMP, the first page's lines
// with their font sizes, read by CodeBoardReading), and, when it carries an arXiv id or a DOI, what arXiv or doi.org
// say. Everything here is plain functions of that text.

/// What a PDF says about itself
public struct PDFClues: Equatable, Sendable {
  /// A line of its first page, in reading order, with the font size most of its characters are in
  public struct Line: Equatable, Sendable {
    public var text: String
    public var size: Double

    public init(_ text: String, size: Double) {
      self.text = text
      self.size = size
    }
  }

  /// Its document info's Title and Author
  public var title: String?
  public var author: String?
  /// Its document info's Subject and Keywords and its XMP, looked into for an id only
  public var metadata: String
  public var firstPage: [Line]

  public init(title: String? = nil, author: String? = nil, metadata: String = "", firstPage: [Line] = []) {
    self.title = title
    self.author = author
    self.metadata = metadata
    self.firstPage = firstPage
  }

  /// The paper it is by an id it carries: any arXiv id or DOI in its metadata, else on its first page arXiv's stamp
  /// (`arXiv:2401.01234v2 [cs.LG] 3 Jan 2024`; an id cited there has no version and date after it) or a DOI written
  /// as one (`doi.org/10.…`, `DOI: 10.…`)
  public var paperID: PaperID? {
    let page = firstPage.map(\.text).joined(separator: "\n")
    if let id = Self.arxiv(metadata, stamp: false) ?? Self.arxiv(page, stamp: true) { return .arxiv(id, version: nil) }
    return [metadata, page].lazy.compactMap(Self.doi).first.map(PaperID.of)
  }

  /// Its title: the document info's when it reads as one, else its first page's largest line(s) near the top; nil
  /// when neither (the file's name, then)
  public var paperTitle: String? { Self.real(title) ?? Self.largest(firstPage) }

  /// Its authors, from its document info only (never guessed from the page)
  public var authors: [String]? {
    guard let author else { return nil }
    let parts = (author.contains(";") ? author.split(separator: ";") : author.split(separator: /,|\band\b|&/))
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { p in
        p.filter(\.isLetter).count >= 2
          && !["author", "authors", "unknown", "anonymous", "admin", "administrator", "user", "owner"]
            .contains(p.lowercased())
      }
    return parts.isEmpty ? nil : parts
  }

  /// The first arXiv id in `text` (without its version): any `arXiv:…` or arxiv.org address, or with `stamp` only
  /// arXiv's stamp
  static func arxiv(_ text: String, stamp: Bool) -> String? {
    let id =
      stamp
      ? text.firstMatch(of: /arXiv:(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})v\d+\s+(?:\[|\d)/)?.1
      : text.firstMatch(
        of: /(?i)(?:arxiv:\s?|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})/)?.1
    return id.map(String.init)
  }

  /// The first DOI written as one in `text`, without the punctuation after it
  static func doi(_ text: String) -> String? {
    guard let m = text.firstMatch(of: /(?i)(?:doi\.org\/|(?:^|[^a-z])doi\s*[:>]?\s*)(10\.\d{4,9}\/[^\s"<>]+)/) else {
      return nil
    }
    var d = Substring(m.1)
    while let last = d.last, ".,;:".contains(last) || (")]".contains(last) && !d.contains(last == ")" ? "(" : "[")) {
      d.removeLast()
    }
    return String(d)
  }

  /// `s` with its whitespace made single spaces, when it reads as a title: not empty, not a file's name
  /// (`paper.dvi`, `Microsoft Word - draft.docx`), not a placeholder (`untitled`)
  static func real(_ s: String?) -> String? {
    guard let t = s?.split(whereSeparator: \.isWhitespace).joined(separator: " "), t.count >= 4, t.count <= 300,
      t.filter(\.isLetter).count >= 3
    else { return nil }
    let l = t.lowercased()
    let placeholders = ["title", "no title", "paper", "main", "manuscript", "document", "article", "slide 1"]
    if placeholders.contains(l) || l.hasPrefix("untitled") || l.hasPrefix("microsoft ") || l.hasPrefix("arxiv:") {
      return nil
    }
    if l.contains(/\.(dvi|pdf|docx?|tex|ps|eps|indd|rtf|odt|pages)$/) { return nil }
    return t
  }

  /// The largest line among the first 20, with the lines in the same size right after it (a title in two or three),
  /// when it is clearly larger than the page's text
  static func largest(_ lines: [Line]) -> String? {
    let lines = lines.filter { $0.text.contains(where: \.isLetter) && arxiv($0.text, stamp: true) == nil }
    var chars: [Double: Int] = [:]
    for l in lines { chars[(l.size * 2).rounded() / 2, default: 0] += l.text.count }
    guard let body = chars.max(by: { ($0.value, $1.key) < ($1.value, $0.key) })?.key else { return nil }
    let top = lines.prefix(20)
    guard let big = top.map(\.size).max(), big >= body * 1.2, let start = top.firstIndex(where: { $0.size == big })
    else { return nil }
    return real(top[start...].prefix { abs($0.size - big) < 0.5 }.prefix(3).map(\.text).joined(separator: " "))
  }
}

/// What arXiv or doi.org say about a paper, as an entry keeps it
public struct PaperMetadata: Equatable, Sendable {
  public var origin: Entry.Origin
  public var title: String?
  public var authors: [String]
  public var year: Int?
  public var venue: String?

  public init(origin: Entry.Origin, title: String?, authors: [String], year: Int?, venue: String?) {
    self.origin = origin
    self.title = title
    self.authors = authors
    self.year = year
    self.venue = venue
  }

  /// The paper `id` names, asked of arXiv or doi.org; nil when it cannot be had (offline, not found)
  public static func look(up id: PaperID, arxiv: Arxiv, doi: DOI) async -> PaperMetadata? {
    switch id {
    case .arxiv(let a, _):
      guard let p = try? await arxiv.paper(a) else { return nil }
      return PaperMetadata(origin: .arxiv(a), title: p.title, authors: p.authors, year: p.year, venue: p.venue)
    case .doi(let d):
      guard let p = try? await doi.paper(d) else { return nil }
      return PaperMetadata(origin: .doi(d), title: p.title, authors: p.authors, year: p.year, venue: p.venue)
    }
  }
}

extension Vault {
  /// The entry at `path` given `meta`'s title, authors, year and venue (each kept where `meta` has none), and its
  /// origin unless another entry of its resource has that one, when it still has the title `titled` it was made with:
  /// one the user renamed meanwhile is left as it is. Only its entry file is written; its folder keeps its name. The
  /// entry written, nil when nothing was
  public func take(_ meta: PaperMetadata, into path: String, titled: String) throws -> Entry? {
    var e = try entry(at: path)
    guard e.title == titled else { return nil }
    let resource = path.split(separator: "/").dropLast().joined(separator: "/")
    let taken = try items(in: resource).contains { i in
      if case .entry(let other, _) = i { other.id != e.id && other.origin == meta.origin } else { false }
    }
    let before = e
    if !taken { e.origin = meta.origin }
    e.title = meta.title ?? e.title
    if !meta.authors.isEmpty { e.authors = meta.authors }
    e.year = meta.year ?? e.year
    e.venue = meta.venue ?? e.venue
    guard e != before else { return nil }
    try write(e, at: path)
    return e
  }
}
