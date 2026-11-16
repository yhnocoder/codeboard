import Foundation
import WebKit

/// What the sites keep in a web tabs' store (sign-ins above all), as a settings screen lists and clears it. Read from
/// the store's own records each time, so that nothing here can disagree with it
extension WebReading {
  /// One site with data in the store
  public struct SiteData: Equatable, Sendable {
    public enum Kind: Sendable {
      case cookies
      /// Local and session storage, IndexedDB, service workers and the like
      case storage
      case cache
    }

    /// Its registrable domain (`zhihu.com` for www.zhihu.com), or the host when it has none (`localhost`, an IP)
    public var domain: String
    public var kinds: Set<Kind>
  }

  /// Posted on the main thread when a store's data was cleared, the store as its object; `domain` in its user info
  /// names the one site, none means every site. Each web tab of that store showing a site cleared loads its page
  /// again (a fresh GET of its address), so that it shows what the site now shows signed out
  public static let siteDataCleared = Notification.Name("CodeBoardReading.WebReading.siteDataCleared")

  /// The sites with data in `store`, by domain
  @MainActor public static func sites(in store: WKWebsiteDataStore = websiteData) async -> [SiteData] {
    await store.dataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes())
      .map { SiteData(domain: $0.displayName, kinds: Set($0.dataTypes.map(kind))) }
      .sorted { $0.domain < $1.domain }
  }

  /// Every site's data gone from `store`
  @MainActor public static func clearAll(in store: WKWebsiteDataStore = websiteData) async {
    await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    NotificationCenter.default.post(name: siteDataCleared, object: store)
  }

  /// One site's data gone from `store`: everything its record holds, for the site and its subdomains
  @MainActor public static func clear(domain: String, in store: WKWebsiteDataStore = websiteData) async {
    let all = WKWebsiteDataStore.allWebsiteDataTypes()
    let records = await store.dataRecords(ofTypes: all).filter { $0.displayName == domain }
    if !records.isEmpty { await store.removeData(ofTypes: all, for: records) }
    NotificationCenter.default.post(name: siteDataCleared, object: store, userInfo: ["domain": domain])
  }

  /// Whether a page at `host` is of a site `domain` names
  static func host(_ host: String, isOf domain: String) -> Bool {
    let h = host.lowercased()
    let d = domain.lowercased()
    return h == d || h.hasSuffix("." + d)
  }

  private static func kind(_ type: String) -> SiteData.Kind {
    switch type {
    case WKWebsiteDataTypeCookies: .cookies
    case WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeFetchCache: .cache
    default: .storage
    }
  }

  /// What the page views say they are, after WebKit's own `Mozilla/5.0 (Macintosh; …) AppleWebKit/… (KHTML, like
  /// Gecko)`: the Safari of this macOS (since 26 the two share their version), so that sites treat a tab as the
  /// browser it is rather than as an unknown app's web view
  static var applicationName: String {
    let os = ProcessInfo.processInfo.operatingSystemVersion
    return "Version/\(os.majorVersion).\(os.minorVersion) Safari/605.1.15"
  }
}
