import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit

/// What the board asks about the sources its cards name, answered from the pane's entries: an entry's title and the
/// page for its source line; a region of a plain PDF's page (the whole page without a rect) as a picture; the passage
/// shown in a tab; and the entries' questions, for the board's question list. The PDFs read and the pictures drawn are
/// kept until the sources change
@MainActor public final class ReadingSources: SourceProvider {
  let pane: ReadingPane
  public var onSourcesChanged: (() -> Void)?
  private var documents: [URL: PDFDocument] = [:]
  private var pictures: [String: CGImage] = [:]

  public init(pane: ReadingPane) {
    self.pane = pane
  }

  /// The entries were read again (the shell's tree read): what was kept goes, and the board draws its sources again
  public func sourcesChanged() {
    documents = [:]
    pictures = [:]
    onSourcesChanged?()
  }

  public func sourceLabel(_ a: SourceAnchor) -> SourceLabel? {
    guard let found = pane.entries[a.entry], found.entry.versions.contains(where: { $0.id == a.place.version }) else {
      return nil
    }
    var number: String?
    if case .page(let n, _) = a.place.block { number = "p. \(n)" }
    return SourceLabel(title: found.entry.title, number: number, icon: .paper)
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

  public func reveal(_ a: SourceAnchor) {
    guard let tab = pane.openPDF(.entry(a.entry, version: a.place.version)) else { return }
    PDFTabView.reveal(a.place, in: tab)
  }

  /// The page a page block is on and its region (in the page's space, from its crop box's bottom left; the whole box
  /// without a rect)
  private func region(_ a: SourceAnchor) -> (page: PDFPage, rect: CGRect)? {
    guard case .page(let n, let rect) = a.place.block,
      let found = pane.locate(.entry(a.entry, version: a.place.version), scanning: false),
      let doc = document(found.url), n >= 1, n <= doc.pageCount, let page = doc.page(at: n - 1)
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

  /// An annotation of an entry that is a question, and where it is
  public struct EntryQuestion: Equatable, Sendable {
    public var anchor: SourceAnchor
    public var sidenote: SidenoteID
    /// Its Markdown, and its question (when asked, done, the answers)
    public var note: TextNote
    public var entryTitle: String
  }

  /// The questions on an entry's passages (every entry's when nil), in the order they were written in each entry
  public func questions(in entry: EntryID? = nil) -> [EntryQuestion] {
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
