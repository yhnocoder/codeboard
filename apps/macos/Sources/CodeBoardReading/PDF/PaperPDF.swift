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
  /// PDFs (outside the vault, or files alone of the resource, which move into their entries) made paper entries of
  /// `resource` at once, all of them or (one that cannot be read or written) none: each titled from the PDF itself (its
  /// document info, else its first page's largest line, else its file's name) with the authors its document info
  /// names. One that carries an arXiv id or a DOI has arXiv or doi.org asked in the background, and its entry takes what
  /// they say unless it was renamed meanwhile; offline or not found, it stays as it is. Each entry with its folder, and
  /// its lookup's task
  @discardableResult public func addPapers(
    pdfs urls: [URL], to resource: VaultResource
  ) throws -> [(found: EntryIndex.Found, lookup: Task<Void, Never>?)] {
    guard let vault else { throw VaultError.unwritable(URL(filePath: resource.path), "no vault is open") }
    var made: [(found: EntryIndex.Found, id: PaperID?, from: String?)] = []
    do {
      for url in urls { made.append(try paper(pdf: url, in: vault, resource)) }
    } catch {
      // all or nothing: what was made goes again, a file alone first back where it was
      for m in made {
        if let from = m.from, case .pdf(let file, _, _) = m.found.entry.versions[0].content {
          do {
            try FileManager.default.moveItem(at: vault.url(of: Vault.join(m.found.path, file)), to: vault.url(of: from))
          } catch {
            continue
          }
        }
        try? FileManager.default.removeItem(at: vault.url(of: m.found.path))
      }
      throw error
    }
    return made.map { m in
      entries.update(m.found.entry, at: m.found.path)
      return (m.found, m.id.map { lookUp($0, for: m.found, in: vault) })
    }
  }

  /// The entry the vault has for the paper `id` names, wherever it is; nil when it has none
  public func paper(_ id: PaperID) -> EntryIndex.Found? {
    switch id {
    case .arxiv(let a, _): entries.arxiv(a)
    case .doi(let d): entries.doi(d)
    }
  }

  /// The paper `id` names in the vault: the entry it has for it (`paper(_:)`, whichever resource it is in, nothing
  /// asked of the network), else a new entry of `resource` made from arXiv (its metadata and the PDF of the version
  /// asked for, else its newest) or doi.org (its metadata; no version). The entry with its folder, and whether it is
  /// new. Throws ArxivError or DOIError (said in plain words), or VaultError
  public func addPaper(_ id: PaperID, to resource: VaultResource) async throws -> (found: EntryIndex.Found, isNew: Bool)
  {
    if let found = paper(id) { return (found, false) }
    guard let vault else { throw VaultError.unwritable(URL(filePath: resource.path), "no vault is open") }
    let (e, path): (Entry, String)
    switch id {
    case .arxiv(let a, let version):
      let p = try await arxiv.paper(a)
      let n = version ?? p.latest
      let pdf = try await arxiv.pdf(a, version: n)
      (e, path) = try vault.newEntry(p, version: n, pdf: pdf, in: resource.path)
    case .doi(let d):
      (e, path) = try vault.newEntry(try await doi.paper(d), in: resource.path)
    }
    entries.update(e, at: path)
    return (EntryIndex.Found(entry: e, path: path), true)
  }

  /// A paper entry made of the PDF at `url`, written; not yet in `entries`. The id it carries, and where it was in the
  /// vault when it moved into the entry
  private func paper(pdf url: URL, in vault: Vault, _ resource: VaultResource) throws -> (
    found: EntryIndex.Found, id: PaperID?, from: String?
  ) {
    let clues = PDFClues(pdf: url) ?? PDFClues()
    let file = Vault.plainFileName(url.lastPathComponent)
    let now = Entry.now
    let e = Entry(
      id: EntryID(rawValue: Board.newID("e")), title: clues.paperTitle ?? url.deletingPathExtension().lastPathComponent,
      added: now, authors: clues.authors,
      versions: [Version(id: VersionID(rawValue: Board.newID("v")), added: now, content: .pdf(file: file))])
    if let inside = vault.path(of: url), inside == Vault.join(resource.path, url.lastPathComponent) {
      return (EntryIndex.Found(entry: e, path: try vault.promote(file: inside, to: e, as: file)), clues.paperID, inside)
    }
    let data: Data
    do { data = try Data(contentsOf: url) } catch { throw VaultError.unreadable(url, error.localizedDescription) }
    return (
      EntryIndex.Found(entry: e, path: try vault.newEntry(e, in: resource.path, with: [file: data])), clues.paperID, nil
    )
  }

  /// What arXiv or doi.org say of `id` taken into the entry in the background
  private func lookUp(_ id: PaperID, for made: EntryIndex.Found, in vault: Vault) -> Task<Void, Never> {
    let (arxiv, doi, e) = (arxiv, doi, made.entry)
    return Task { [weak self] in
      guard let meta = await PaperMetadata.look(up: id, arxiv: arxiv, doi: doi), let self else { return }
      // where its folder is now: the last tree read's, else where it was made
      let at = entries[e.id]?.path ?? made.path
      do {
        guard let taken = try vault.take(meta, into: at, titled: e.title) else { return }
        entries.update(taken, at: at)
        for tab in tabs where tab.payload["entry"] == e.id.rawValue { update(tab.id, title: taken.title) }
      } catch {
        Logger(subsystem: Bundle.main.bundleIdentifier ?? "CodeBoard", category: "papers").error(
          "\(at, privacy: .public): \(error, privacy: .public)")
      }
    }
  }
}
