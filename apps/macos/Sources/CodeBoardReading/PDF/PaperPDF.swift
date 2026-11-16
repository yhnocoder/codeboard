import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit
import os

extension PDFClues {
  /// What the PDF at `url` says about itself; nil when it is not one PDFKit reads
  init?(pdf url: URL) {
    guard let doc = PDFDocument(url: url) else { return nil }
    let info = doc.documentAttributes ?? [:]
    let keywords = info[PDFDocumentAttribute.keywordsAttribute]
    var metadata = [
      info[PDFDocumentAttribute.subjectAttribute] as? String,
      (keywords as? [String])?.joined(separator: " ") ?? keywords as? String,
    ].compactMap { $0 }
    var xmp: CGPDFStreamRef?
    var format = CGPDFDataFormat.raw
    if let catalog = doc.documentRef?.catalog, CGPDFDictionaryGetStream(catalog, "Metadata", &xmp), let xmp,
      let data = CGPDFStreamCopyData(xmp, &format)
    {
      metadata.append(String(decoding: data as Data, as: UTF8.self))
    }
    var lines: [Line] = []
    if let page = doc.page(at: 0)?.attributedString {
      let text = page.string as NSString
      text.enumerateSubstrings(in: NSRange(location: 0, length: text.length), options: .byLines) { s, range, _, _ in
        var sizes: [CGFloat: Int] = [:]
        page.enumerateAttribute(.font, in: range) { f, r, _ in
          if let f = f as? NSFont { sizes[f.pointSize, default: 0] += r.length }
        }
        lines.append(Line(s ?? "", size: Double(sizes.max { $0.value < $1.value }?.key ?? 0)))
      }
    }
    self.init(
      title: info[PDFDocumentAttribute.titleAttribute] as? String,
      author: info[PDFDocumentAttribute.authorAttribute] as? String, metadata: metadata.joined(separator: "\n"),
      firstPage: lines)
  }
}

extension ReadingPane {
  /// The PDF at `url` (outside the vault, or a file alone of the resource, which moves into the entry) made a paper
  /// entry of `resource` at once, titled from the PDF itself (its document info, else its first page's largest line,
  /// else its file's name) with the authors its document info names. When it carries an arXiv id or a DOI, arXiv or
  /// doi.org are asked in the background and the entry takes what they say, unless it was renamed meanwhile; offline
  /// or not found, it stays as it is. The entry with its folder, and that lookup's task
  @discardableResult public func addPaper(
    pdf url: URL, to resource: VaultResource
  ) throws -> (found: EntryIndex.Found, lookup: Task<Void, Never>?) {
    guard let vault else { throw VaultError.unwritable(url, "no vault is open") }
    let clues = PDFClues(pdf: url) ?? PDFClues()
    let file = Vault.plainFileName(url.lastPathComponent)
    let now = Entry.now
    let e = Entry(
      id: EntryID(rawValue: Board.newID("e")), title: clues.paperTitle ?? url.deletingPathExtension().lastPathComponent,
      added: now, authors: clues.authors,
      versions: [Version(id: VersionID(rawValue: Board.newID("v")), added: now, content: .pdf(file: file))])
    let path: String
    if let inside = vault.path(of: url), inside == Vault.join(resource.path, url.lastPathComponent) {
      path = try vault.promote(file: inside, to: e, as: file)
    } else {
      let data: Data
      do { data = try Data(contentsOf: url) } catch { throw VaultError.unreadable(url, error.localizedDescription) }
      path = try vault.newEntry(e, in: resource.path, with: [file: data])
    }
    entries.update(e, at: path)
    let found = EntryIndex.Found(entry: e, path: path)
    guard let id = clues.paperID else { return (found, nil) }
    let (arxiv, doi) = (arxiv, doi)
    return (
      found,
      Task { [weak self] in
        guard let meta = await PaperMetadata.look(up: id, arxiv: arxiv, doi: doi), let self else { return }
        // where its folder is now: the last tree read's, else where it was made
        let at = entries[e.id]?.path ?? path
        do {
          guard let taken = try vault.take(meta, into: at, titled: e.title) else { return }
          entries.update(taken, at: at)
          for tab in tabs where tab.payload["entry"] == e.id.rawValue { update(tab.id, title: taken.title) }
        } catch {
          Logger(subsystem: Bundle.main.bundleIdentifier ?? "CodeBoard", category: "papers").error(
            "\(at, privacy: .public): \(error, privacy: .public)")
        }
      }
    )
  }
}
