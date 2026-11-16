import AppKit
import CodeBoardModel
import CodeBoardResources

/// Reading PDFs in a tab: a version of an entry, or a file that is an entry alone
public enum PDFReading {
  public static let kind = "pdf"

  @MainActor static func register() {
    ReadingKinds.register(
      kind,
      follow: { tab, pane in PDFTarget(payload: tab.payload).flatMap { pane.locate($0, scanning: false)?.title } },
      make: { PDFTabView(context: $0) })
  }
}

/// What a PDF tab shows: a version of an entry by their ids, or a file that is an entry alone by its path in the vault
public enum PDFTarget: Equatable, Sendable {
  case entry(EntryID, version: VersionID)
  case file(String)

  init?(payload: [String: String]) {
    if let e = payload["entry"], let v = payload["version"] {
      self = .entry(EntryID(rawValue: e), version: VersionID(rawValue: v))
    } else if let f = payload["file"] {
      self = .file(f)
    } else {
      return nil
    }
  }

  var payload: [String: String] {
    switch self {
    case .entry(let e, let v): ["entry": e.rawValue, "version": v.rawValue]
    case .file(let f): ["file": f]
    }
  }

  /// What its tab is gone to by
  var key: String {
    switch self {
    case .entry(let e, let v): "pdf:\(e.rawValue)/\(v.rawValue)"
    case .file(let f): "pdf-file:\(f)"
    }
  }
}

/// A PDF found in the vault: its file, its tab's title, and its entry with the entry's folder when it has one
struct PDFFound {
  var url: URL
  var title: String
  var entry: EntryIndex.Found?
}

extension ReadingPane {
  /// A PDF in a tab, titled as its entry (a file's name without its extension): opened, or gone to when it is open.
  /// Nil when it is not in the vault
  @discardableResult public func openPDF(_ t: PDFTarget) -> ReadingTab.ID? {
    guard let found = locate(t, scanning: true) else { return nil }
    return open(found.title, key: t.key, kind: PDFReading.kind, payload: t.payload)
  }

  /// Where `t` is now; nil when its entry, version or file is gone. `scanning`: an entry the last tree read did not
  /// see is looked for in the vault as it is now (a tab made before the first read)
  func locate(_ t: PDFTarget, scanning: Bool) -> PDFFound? {
    guard let vault else { return nil }
    switch t {
    case .file(let path):
      let url = vault.url(of: path)
      guard FileManager.default.fileExists(atPath: url.path) else { return nil }
      return PDFFound(url: url, title: url.deletingPathExtension().lastPathComponent)
    case .entry(let id, let version):
      var found = entries[id]
      if found == nil, scanning, let tree = try? vault.tree() { found = EntryIndex(vault, tree)[id] }
      guard let found, let v = found.entry.versions.first(where: { $0.id == version }),
        case .pdf(let file, _, _) = v.content
      else { return nil }
      let url = vault.url(of: Vault.join(found.path, file))
      guard FileManager.default.fileExists(atPath: url.path) else { return nil }
      return PDFFound(url: url, title: found.entry.title, entry: found)
    }
  }
}
