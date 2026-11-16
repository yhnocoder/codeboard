import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit

/// What the board asks about the sources its cards name, answered from the pane's entries: an entry's short title
/// and the page, or for a version read by blocks the paper's own number, for its source line; a region of a plain
/// PDF's page (the whole page without a rect), or a block of a version read by blocks (its rects on its first page),
/// as a picture; the author's macros; the passage shown in a tab; and the entries' questions, for the board's question
/// list. The PDFs and block lists read and the pictures drawn are kept until the sources change
@MainActor public final class ReadingSources: SourceProvider {
  let pane: ReadingPane
  public var onSourcesChanged: (() -> Void)?
  private var documents: [URL: PDFDocument] = [:]
  private var pictures: [String: CGImage] = [:]
  private var papers: [String: Paper?] = [:]

  public init(pane: ReadingPane) {
    self.pane = pane
  }

  /// The entries were read again (the shell's tree read): what was kept goes, and the board draws its sources again
  public func sourcesChanged() {
    documents = [:]
    pictures = [:]
    papers = [:]
    onSourcesChanged?()
  }

  public func sourceLabel(_ a: SourceAnchor) -> SourceLabel? {
    guard let found = pane.entries[a.entry] else { return nil }
    // the entry as a whole: its title alone
    guard let place = a.place else {
      if case .web = found.entry.origin { return SourceLabel(title: found.entry.title, number: nil, icon: .site) }
      return SourceLabel(title: Paper.shortTitle(found.entry.title), number: nil, icon: .paper)
    }
    guard found.entry.versions.contains(where: { $0.id == place.version }) else { return nil }
    var number: String?
    switch place.block {
    case .page(let n, _): number = "p. \(n)"
    case .id(let id): number = paper(a)?.labels[id]
    }
    return SourceLabel(title: Paper.shortTitle(found.entry.title), number: number, icon: .paper)
  }

  public func blockSize(_ a: SourceAnchor) -> CGSize? { region(a).map(\.rect.size) }

  public func blockImage(_ a: SourceAnchor, pixelWidth: Int) async -> CGImage? {
    let key = "\(a) \(pixelWidth)"
    if let kept = pictures[key] { return kept }
    guard let (page, r) = region(a), let image = PDFPlaces.picture(of: page, r, pixelWidth: pixelWidth) else {
      return nil
    }
    pictures[key] = image
    return image
  }

  public func mathPreamble(for a: SourceAnchor) -> String? { paper(a)?.mathPreamble }

  /// The block list and TeX of the anchor's version, read once; nil for a version without a list
  func paper(_ a: SourceAnchor) -> Paper? {
    guard let place = a.place else { return nil }
    let key = "\(a.entry.rawValue)/\(place.version.rawValue)"
    if let kept = papers[key] { return kept }
    var p: Paper?
    if let vault = pane.vault, let found = pane.entries[a.entry],
      let v = found.entry.versions.first(where: { $0.id == place.version })
    {
      p = Paper.read(v.content, in: vault.url(of: found.path))
    }
    papers[key] = .some(p)
    return p
  }

  public func reveal(_ a: SourceAnchor) {
    guard let place = a.place else { return pane.openEntry(a.entry) }
    guard let tab = pane.openPDF(.entry(a.entry, version: place.version)) else { return }
    PDFTabView.reveal(place, in: tab)
  }

  /// The page a page block is on and its region (in the page's space, from its crop box's bottom left; the whole box
  /// without a rect); a listed block's first page and its frame there (Paper.frame, as framed when it is clicked)
  private func region(_ a: SourceAnchor) -> (page: PDFPage, rect: CGRect)? {
    guard let place = a.place, let found = pane.locate(.entry(a.entry, version: place.version), scanning: false),
      let doc = document(found.url)
    else { return nil }
    if case .id(let id) = place.block {
      guard let paper = paper(a), let b = paper.block(id), let n = b.firstPage, n <= doc.pageCount,
        let page = doc.page(at: n - 1), let r = paper.frame(b, on: n, within: page.bounds(for: .cropBox))
      else { return nil }
      return (page, r)
    }
    guard case .page(let n, let rect) = place.block, n >= 1, n <= doc.pageCount, let page = doc.page(at: n - 1)
    else { return nil }
    let box = page.bounds(for: .cropBox)
    let r = rect.map { CGRect(x: box.minX + $0.x, y: box.minY + $0.y, width: $0.width, height: $0.height) } ?? box
    return (page, r)
  }

  /// The PDF at `url`, read once
  func document(_ url: URL) -> PDFDocument? {
    if let d = documents[url] { return d }
    guard let data = try? Data(contentsOf: url, options: .mappedIfSafe), let d = PDFDocument(data: data) else {
      return nil
    }
    documents[url] = d
    return d
  }

  // MARK: Questions

  /// The questions on an entry's passages (every entry's when nil), in the order they were written in each entry
  public func questions(in entry: EntryID?) -> [EntryQuestion] {
    let found = entry.map { pane.entries[$0].map { [$0] } ?? [] } ?? pane.entries.all
    return found.flatMap { f in
      f.entry.sidenotes.filter { $0.note.question != nil }.map {
        EntryQuestion(
          anchor: SourceAnchor(entry: f.entry.id, place: $0.place), sidenote: $0.id, note: $0.note,
          entryTitle: f.entry.title)
      }
    }
  }

  /// A question marked done or not, in its entry's file
  public func setDone(_ done: Bool, question: SidenoteID, in entry: EntryID) throws {
    try change(question, in: entry) { $0.done = done }
  }

  /// An answer added to a question, in its entry's file; the answer's id
  @discardableResult
  public func answer(_ text: String, question: SidenoteID, in entry: EntryID) throws -> String {
    let id = Board.newID("a")
    try change(question, in: entry) {
      $0.answers.append(Question.Answer(id: id, text: text, at: (Date().timeIntervalSince1970 * 1000).rounded()))
    }
    return id
  }

  private func change(_ question: SidenoteID, in entry: EntryID, _ f: (inout Question) -> Void) throws {
    guard let vault = pane.vault, let path = pane.entries[entry]?.path else {
      throw VaultError.unreadable(pane.vault?.root ?? URL(filePath: "/"), "no entry \(entry.rawValue)")
    }
    var e = try vault.entry(at: path)
    guard let i = e.sidenotes.firstIndex(where: { $0.id == question }), var q = e.sidenotes[i].note.question else {
      throw VaultError.malformed(vault.url(of: path), "no question \(question.rawValue)")
    }
    f(&q)
    e.sidenotes[i].note.question = q
    try vault.write(e, at: path)
    pane.entries.update(e, at: path)
  }
}
