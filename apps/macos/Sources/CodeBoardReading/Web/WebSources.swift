import CodeBoardModel
import CodeBoardResources
import Foundation

// What the board asks about cards taken from web pages: their source line and showing their place again.

extension WebReading {
  /// A web entry's card foot: the site's icon and the entry's title, and the nearest heading above the place, lighter,
  /// when the page's blocks file has one; nil for an entry that is not a web page's, is gone, or has not the anchor's
  /// version
  @MainActor public static func sourceLabel(_ a: SourceAnchor, in pane: ReadingPane) -> SourceLabel? {
    guard let found = pane.entries[a.entry], case .web = found.entry.origin else { return nil }
    var heading: String?
    if let p = a.place {
      guard let v = found.entry.versions.first(where: { $0.id == p.version }) else { return nil }
      heading = Self.heading(at: p, in: v, of: found, in: pane)
    }
    return SourceLabel(title: found.entry.title, number: heading, icon: icon(of: found, in: pane))
  }

  /// The headings of the blocks files read, by file: each block's nearest heading at or before it, by block id. The
  /// board asks for its feet on every change, and a long page's file takes a while to read
  @MainActor private static var headings: [URL: (modified: Date?, byBlock: [String: String])] = [:]

  /// The nearest heading at or before the place's block, from the blocks file of its page (a translation's: the page
  /// it translates)
  @MainActor private static func heading(
    at p: Place, in v: Version, of found: EntryIndex.Found, in pane: ReadingPane
  ) -> String? {
    let page = v.of.flatMap { of in found.entry.versions.first { $0.id == of } } ?? v
    guard case .id(let id) = p.block, case .page(_, _, let name?) = page.content, let vault = pane.vault else {
      return nil
    }
    let file = vault.url(of: found.path).appending(path: name)
    let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    if let kept = headings[file], kept.modified == modified { return kept.byBlock[id] }
    guard let blocks = try? vault.pageBlocks(name, in: found.path) else { return nil }
    var byBlock: [String: String] = [:]
    var last: String?
    for b in blocks {
      if b.kind == "heading" { last = b.text }
      byBlock[b.id] = last
    }
    headings[file] = (modified, byBlock)
    return byBlock[id]
  }

  /// The site's own icon when it can be drawn: the file kept with the entry (the board draws files only)
  @MainActor private static func icon(of found: EntryIndex.Found, in pane: ReadingPane) -> SourceLabel.Icon {
    switch found.entry.meta?.icon {
    case .file(let name)?:
      guard Vault.isFileName(name), let vault = pane.vault else { return .site }
      let file = vault.url(of: found.path).appending(path: Vault.imagesFolder).appending(path: name)
      return FileManager.default.fileExists(atPath: file.path) ? .image(file) : .site
    default: return .site
    }
  }

  /// A web entry's place shown in a web tab: a page saved whole in the saved page's tab, at its block when the reader
  /// can scroll to it; else the page online, in the tab already on it, in another window's pane (`elsewhere`, by the
  /// tab's key) when that has it. False for an entry that is not a web page's
  @MainActor @discardableResult public static func reveal(
    _ a: SourceAnchor, in pane: ReadingPane, elsewhere: (String?) -> ReadingPane? = { _ in nil }
  ) -> Bool {
    guard let found = pane.entries[a.entry], case .web(let address) = found.entry.origin,
      let url = URL(string: address)
    else { return false }
    if let p = a.place, let v = found.entry.versions.first(where: { $0.id == p.version }),
      case .page(let hash, _, _) = v.content
    {
      let page = Page.saved(hash: hash, address: url, title: found.entry.title)
      let tab = (elsewhere(page.key) ?? pane).open(found.entry.title, key: page.key, kind: kind, payload: page.payload)
      if case .id(let id) = p.block { WebPageView.reveal(id, range: p.range, in: tab) }
      return true
    }
    let online = key(for: url)
    (elsewhere(online) ?? pane).open(found.entry.title, key: online, kind: kind, payload: ["url": address])
    return true
  }
}
