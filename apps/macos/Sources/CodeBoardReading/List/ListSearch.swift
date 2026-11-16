import CodeBoardModel
import CodeBoardResources
import Foundation
import PDFKit

// ⌘K's Resources group: the vault's entries found by their title and authors, or by their text. The text is what the
// app already reads: a version's block list (its blocks' TeX as Markdown), a plain PDF's pages as PDFKit gives them,
// a saved page's translation file. A saved page's own text is not searched: nothing reads its blocks file yet. Every
// word typed must be in the title and authors, or in one passage (a block, a page, a translated block); an entry found
// in several passages is listed once, at the passage whose best sentence scores highest (BoardSearch.fuzzy, word by
// word), with how many matched.

/// An entry found: where it matched, what Return opens and what ⌥↵ puts on the board
public struct ResourceHit: Equatable, Sendable {
  public var entry: EntryID
  public var title: String
  /// Under the title: the sentence that matched, or for a title or author match the authors
  public var context: String
  /// Where the sentence is (`p. 3`, `§ 2.1`, a translation's label); nil for a title or author match
  public var label: String?
  /// Passages of its text that matched; 0 for a title or author match
  public var count: Int
  /// What Return opens: the passage, or the entry as a whole
  public var anchor: SourceAnchor
  /// What ⌥↵ puts on the board: the passage with its source; nil for a title or author match
  public var collect: Collected?
  /// The preview's Markdown: the passage and what is around it, or the entry's title, authors, year and venue
  public var preview: String
  /// The preview's line above it: the resource, or the entry and the place
  public var `where`: String
}

/// The entries' texts, read once and kept in memory until a file they came from changes, and the search over them;
/// an actor, so that reading and searching are off the main thread
// ponytail: a linear scan of every kept passage on each query; an inverted index (kept in Caches, per vault) when
// vaults hold thousands of papers
public actor ResourceTexts {
  /// A block, a page or a translated block
  struct Passage: Sendable {
    var version: VersionID
    var block: Place.Block
    var label: String
    var text: String
    var low: String
    /// A block taken whole as Markdown; nil: a page, of which ⌥↵ takes the sentence
    var markdown: String?
  }

  private var kept: [EntryID: (stamp: [String: Date], passages: [Passage])] = [:]

  public init() {}

  /// The entries the cards of `board` take from (its Shelf's too): ⌘F's
  public static func entries(on board: Board) -> Set<EntryID> {
    let cards = board.cards + board.shelf.flatMap(\.cards)
    return Set(
      cards.flatMap { c -> [EntryID] in if case .own(let o) = c.content { EntryBoards.entries(o) } else { [] } })
  }

  /// What `q` finds among `entries` (only those in `only` when given), title and author matches first, 60 at most;
  /// none once the task is cancelled
  public func search(
    _ q: String, in entries: [EntryIndex.Found], vault: Vault, only: Set<EntryID>? = nil
  ) -> [ResourceHit] {
    let words = q.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    guard !words.isEmpty else { return [] }
    var scored: [(s: Double, hit: ResourceHit)] = []
    for f in entries where only?.contains(f.entry.id) ?? true {
      if Task.isCancelled { return [] }
      if let s = Self.metaScore(words, f.entry) {
        scored.append((s + 1_000_000, Self.metaHit(f)))
      } else if let h = textHit(words, f, vault: vault) {
        scored.append(h)
      }
    }
    return scored.enumerated().sorted { ($0.element.s, -$0.offset) > ($1.element.s, -$1.offset) }.prefix(60).map(
      \.element.hit)
  }

  // MARK: Matching

  /// Every word in the title or the authors: the sum of their best scores; nil when one is in neither
  static func metaScore(_ words: [String], _ e: Entry) -> Double? {
    let authors = (e.authors ?? []).joined(separator: ", ")
    var total = 0.0
    for w in words {
      let s = max(BoardSearch.fuzzy(w, e.title), BoardSearch.fuzzy(w, authors))
      guard s >= 0 else { return nil }
      total += s
    }
    return total
  }

  static func metaHit(_ f: EntryIndex.Found) -> ResourceHit {
    let e = f.entry
    let authors = (e.authors ?? []).joined(separator: ", ")
    let line = [e.year.map(String.init), e.venue].compactMap { $0 }.joined(separator: " · ")
    let md = ["**\(e.title)**", authors, line].filter { !$0.isEmpty }.joined(separator: "\n\n")
    return ResourceHit(
      entry: e.id, title: e.title, context: authors, label: nil, count: 0, anchor: SourceAnchor(entry: e.id),
      collect: nil, preview: md, where: Self.resource(f.path))
  }

  /// The passage of `f`'s text whose best sentence scores highest, and how many passages hold every word
  private func textHit(_ words: [String], _ f: EntryIndex.Found, vault: Vault) -> (Double, ResourceHit)? {
    var best: (s: Double, p: Passage, sentence: NSRange)?
    var count = 0
    for p in passages(f, vault: vault) where words.allSatisfy({ p.low.contains($0) }) {
      count += 1
      let (s, r) = Self.bestSentence(words, in: p.text)
      if best == nil || s > best!.s { best = (s, p, r) }
    }
    guard let (s, p, r) = best else { return nil }
    let text = p.text as NSString
    let sentence = text.substring(with: r)
    let place = Place(version: p.version, block: p.block, range: p.markdown == nil ? r.lowerBound..<r.upperBound : nil)
    let anchor = SourceAnchor(entry: f.entry.id, place: place)
    // a page: what is around the sentence; a block: itself
    let around = NSRange(
      location: max(0, r.location - 600), length: min(text.length, r.upperBound + 600) - max(0, r.location - 600))
    let preview = p.markdown ?? text.substring(with: around)
    return (
      s,
      ResourceHit(
        entry: f.entry.id, title: f.entry.title, context: Self.near(sentence, words), label: p.label, count: count,
        anchor: anchor,
        collect: Collected(
          body: .note(markdown: p.markdown ?? sentence.trimmingCharacters(in: .whitespacesAndNewlines)),
          source: anchor, title: f.entry.title, label: p.label),
        preview: preview, where: "\(f.entry.title) › \(p.label)")
    )
  }

  /// The sentence of `text` whose words score highest (each word's fuzzy score where it is in it), and the score
  static func bestSentence(_ words: [String], in text: String) -> (Double, NSRange) {
    let ns = text as NSString
    var best: (Double, NSRange) = (-1, NSRange(location: 0, length: ns.length))
    ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: .bySentences) { s, r, _, _ in
      guard let s else { return }
      let low = s.lowercased()
      let score = words.reduce(0.0) { $0 + (low.contains($1) ? BoardSearch.fuzzy($1, s) + 200 : 0) }
      if score > best.0 { best = (score, r) }
    }
    return best
  }

  /// A long sentence from a little before its first word, so that the word shows on one line
  static func near(_ sentence: String, _ words: [String]) -> String {
    let s = sentence.trimmingCharacters(in: .whitespacesAndNewlines).replacing(/\s+/, with: " ")
    let ns = s as NSString
    let at = words.map { ns.range(of: $0, options: .caseInsensitive).location }.filter { $0 != NSNotFound }.min() ?? 0
    guard at > 40 else { return s }
    return "…" + ns.substring(from: at - 30)
  }

  /// The resource an entry's folder is in, by its title
  static func resource(_ path: String) -> String {
    let parts = path.split(separator: "/")
    return parts.last { $0.hasSuffix(".resource") }.map { String($0.dropLast(".resource".count)) } ?? ""
  }

  // MARK: The texts

  /// The files of `v` its text is read from
  static func files(_ v: Version) -> [String] {
    switch v.content {
    case .pdf(let file, let blocks, let source): [file] + [blocks, source].compactMap { $0 }
    case .translation(let file): [file]
    case .page, .file: []
    }
  }

  /// `f`'s passages, read again only when one of the files they come from changed
  func passages(_ f: EntryIndex.Found, vault: Vault) -> [Passage] {
    let folder = vault.url(of: f.path)
    let stamp = Dictionary(
      f.entry.versions.flatMap(Self.files).map { name in
        let url = folder.appending(path: name)
        let date = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
        return (url.path, date ?? .distantPast)
      }, uniquingKeysWith: { a, _ in a })
    if let k = kept[f.entry.id], k.stamp == stamp { return k.passages }
    let out = f.entry.versions.flatMap { Self.read($0, of: f, vault: vault, folder: folder) }
    kept[f.entry.id] = (stamp, out)
    return out
  }

  static func read(_ v: Version, of f: EntryIndex.Found, vault: Vault, folder: URL) -> [Passage] {
    func passage(_ block: Place.Block, _ label: String, _ text: String, md: String?) -> Passage {
      Passage(version: v.id, block: block, label: label, text: text, low: text.lowercased(), markdown: md)
    }
    switch v.content {
    case .pdf(let file, _, _):
      if let paper = Paper.read(v.content, in: folder) {
        // a parent's lines take in its children's: the children only
        let parents = Set(paper.list.blocks.compactMap(\.parent))
        return paper.list.blocks.compactMap { b in
          guard !parents.contains(b.id), let md = paper.markdown([(b, nil)]) else { return nil }
          return passage(.id(b.id), paper.labels[b.id] ?? PDFPlaces.label(b.firstPage.map { [$0] } ?? []), md, md: md)
        }
      }
      guard let doc = PDFDocument(url: folder.appending(path: file)) else { return [] }
      return (0..<doc.pageCount).compactMap { i in
        guard let t = doc.page(at: i)?.string, !t.isEmpty else { return nil }
        return passage(.page(i + 1), PDFPlaces.label([i + 1]), t, md: nil)
      }
    case .translation:
      guard let of = v.of, let lang = v.language,
        let t = try? vault.translations(of: of, language: lang, in: f.path)
      else { return [] }
      return t.blocks.sorted { $0.key < $1.key }.map { id, b in
        passage(.id(id), v.label ?? lang, b.text, md: b.text)
      }
    case .page, .file: return []
    }
  }
}

extension ReadingPane {
  /// A search result opened: a place of a PDF version shown as a card's source is, anything else its entry opened
  public func open(found a: SourceAnchor) {
    if let p = a.place, let tab = openPDF(.entry(a.entry, version: p.version)) { return PDFTabView.reveal(p, in: tab) }
    openEntry(a.entry)
  }
}
