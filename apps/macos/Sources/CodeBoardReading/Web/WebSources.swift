import CodeBoardModel
import CodeBoardResources
import Foundation

// What the board asks about cards taken from web pages: their source line and showing their place again.

extension WebReading {
  /// The heading before each place collected in this run of the app, by anchor: the anchor names none (FORMAT.md),
  /// so after a relaunch a card's source line is its title alone
  @MainActor private static var headings: [String: String] = [:]

  @MainActor static func heard(_ heading: String?, for a: SourceAnchor) { headings["\(a)"] = heading }

  /// A web entry's card foot: the site icon and the entry's title, and the heading before the place, lighter, when it
  /// is known; nil for an entry that is not a web page's, is gone, or has not the anchor's version
  @MainActor public static func sourceLabel(_ a: SourceAnchor, in pane: ReadingPane) -> SourceLabel? {
    guard let found = pane.entries[a.entry], case .web = found.entry.origin,
      a.place.map({ p in found.entry.versions.contains { $0.id == p.version } }) ?? true
    else { return nil }
    return SourceLabel(title: found.entry.title, number: headings["\(a)"], icon: .site)
  }

  /// A web entry's place shown in a web tab: a page saved whole in the saved page's tab, at its block when the reader
  /// can scroll to it; else the page online, in the tab already on it. False for an entry that is not a web page's
  @MainActor @discardableResult public static func reveal(_ a: SourceAnchor, in pane: ReadingPane) -> Bool {
    guard let found = pane.entries[a.entry], case .web(let address) = found.entry.origin,
      let url = URL(string: address)
    else { return false }
    if let p = a.place, let v = found.entry.versions.first(where: { $0.id == p.version }),
      case .page(let hash, _, _) = v.content
    {
      let page = Page.saved(hash: hash, address: url, title: found.entry.title)
      let tab = pane.open(found.entry.title, key: page.key, kind: kind, payload: page.payload)
      if case .id(let id) = p.block { WebPageView.reveal(id, range: p.range, in: tab) }
      return true
    }
    pane.open(found.entry.title, key: key(for: url), kind: kind, payload: ["url": address])
    return true
  }
}
