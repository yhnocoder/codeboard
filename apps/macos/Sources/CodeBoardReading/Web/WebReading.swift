import AppKit
import CodeBoardResources
import WebKit

/// Web pages in reading tabs of their own kind: the page fills the tab, its bar floats over the page's bottom edge
public enum WebReading {
  public static let kind = "web"

  /// Web tabs, registered by the shell at launch. `saving` keeps saved links and pages whole outside the vault; none:
  /// links are saved into the vault alone, nothing is saved whole and a saved page is not on this Mac. `scripts` is the
  /// folder of the saving service's page scripts (`hooks.js`, `capture.js`, `reader.js`), read as each tab opens; none
  /// there: nothing is saved whole and a saved page is not read in body view
  @MainActor public static func register(saving: (any PageStore)?, scripts: URL?) {
    register(saving: saving, scripts: scripts, websiteData: websiteData)
  }

  /// The vault's entries read again, as the shell reads them after opening the vault, often after a tab restored at
  /// launch has loaded its page: each open tab asks again how its page is saved
  @MainActor static func register(saving: (any PageStore)?, scripts: URL?, websiteData: WKWebsiteDataStore) {
    ReadingKinds.register(
      kind, icon: "globe",
      follow: { tab, _ in
        WebPageView.view(of: tab.id)?.entriesRead()
        return tab.title
      },
      make: { WebPageView(context: $0, store: saving, scripts: scripts, websiteData: websiteData) })
  }

  /// Every web tab's store: one fixed identifier, so that sign-ins outlive the tab and the app. WebKit keeps it where
  /// it keeps an app's web data; it has no way to put it in a folder of the app's choosing
  @MainActor public static let websiteData = WKWebsiteDataStore(
    forIdentifier: UUID(uuidString: "507E237B-B859-48BE-8256-545F6EFC3F99")!)

  /// What a web tab shows, as its tab keeps it: `["url": address]` a page of the web (no address: a blank page, its
  /// address being edited), `["url": address, "hash": hash, "title": title]` a page as it was saved, with the address
  /// and title it was saved from
  enum Page: Equatable, Sendable {
    case online(URL?)
    case saved(hash: String, address: URL, title: String)

    init(payload: [String: String]) {
      let url = payload["url"].flatMap(URL.init(string:))
      if let hash = payload["hash"], let url {
        self = .saved(hash: hash, address: url, title: payload["title"] ?? "")
      } else {
        self = .online(url)
      }
    }

    var payload: [String: String] {
      switch self {
      case .online(let url): url.map { ["url": $0.absoluteString] } ?? [:]
      case .saved(let hash, let address, let title): ["url": address.absoluteString, "hash": hash, "title": title]
      }
    }

    /// What its tab is gone to by: a saved page's hash; a page online has none
    var key: String? {
      if case .saved(let hash, _, _) = self { "web:" + hash } else { nil }
    }
  }
}
