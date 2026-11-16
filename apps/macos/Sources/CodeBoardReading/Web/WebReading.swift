import AppKit
import WebKit

/// Web pages in a tab of the app's own: the page fills the tab, its bar floats over the page's bottom edge
public enum WebReading {
  /// The bar's size and place in the pane. The defaults are the board's bottom toolbar in Warm Ink (CanvasToolbar's
  /// bar height and squircle, BoardPanes.toolbarFrame's 12 above the bottom edge), so that beside the board the two
  /// bars' top and bottom edges are on one line
  public struct BarLook: Equatable, Sendable {
    public var height: CGFloat
    public var radius: CGFloat
    /// From the pane's bottom edge to the bar's
    public var bottom: CGFloat
    /// From each side of the pane to the bar
    public var side: CGFloat

    public init(height: CGFloat = 36, radius: CGFloat = 14, bottom: CGFloat = 12, side: CGFloat = 12) {
      self.height = height
      self.radius = radius
      self.bottom = bottom
      self.side = side
    }
  }

  @MainActor public struct Context {
    public var look: BarLook
    /// The Mac's own web data (the history the address suggests from), never in the vault
    public var dataDirectory: URL
    /// Cookies and site data: `websiteData` by default, the app's own on this Mac and not Safari's
    public var websiteData: WKWebsiteDataStore
    /// The page's title or what the tab shows changed, so that the tab can follow and open it again
    public var changed: (_ title: String?, _ page: Page) -> Void
    /// Where saved links and pages go and saved pages come from; none: nothing is saved, and a saved page says it is
    /// not on this Mac
    public var saving: (any WebSaving)?
    /// The saving service's scripts (`hooks.js`, `capture.js`, `reader.js`), outside the app; none: a page is
    /// saved as a link only, and a saved page is shown whole
    public var scripts: URL?

    public init(
      dataDirectory: URL, websiteData: WKWebsiteDataStore = WebReading.websiteData, look: BarLook = BarLook(),
      saving: (any WebSaving)? = nil, scripts: URL? = nil,
      changed: @escaping (_ title: String?, _ page: Page) -> Void = { _, _ in }
    ) {
      self.look = look
      self.dataDirectory = dataDirectory
      self.websiteData = websiteData
      self.saving = saving
      self.scripts = scripts
      self.changed = changed
    }
  }

  /// Every web tab's store: one fixed identifier, so that sign-ins outlive the tab and the app
  @MainActor public static let websiteData = WKWebsiteDataStore(
    forIdentifier: UUID(uuidString: "507E237B-B859-48BE-8256-545F6EFC3F99")!)

  /// What a web tab shows
  public enum Page: Codable, Equatable, Sendable {
    /// A page of the web; none: a blank page, its address being edited
    case online(URL?)
    /// A page as it was saved, by its hash, with the address and title it was saved from
    case saved(hash: String, address: URL, title: String)
  }

  /// A tab's view, showing `page`
  @MainActor public static func makeView(_ page: Page, context: Context) -> NSView {
    WebPageView(page: page, context: context)
  }
}
