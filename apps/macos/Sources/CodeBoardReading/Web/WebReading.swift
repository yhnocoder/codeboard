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
    /// The page's title or address changed, so that the tab can follow
    public var changed: (_ title: String?, _ url: URL?) -> Void
    /// Where saved links and pages go; none: the save button is off
    public var saving: (any WebSaving)?
    /// The saving service's scripts (`hooks.js`, `capture.js`), outside the app; none: a page cannot be saved
    /// whole, only as a link
    public var scripts: URL?

    public init(
      dataDirectory: URL, websiteData: WKWebsiteDataStore = WebReading.websiteData, look: BarLook = BarLook(),
      saving: (any WebSaving)? = nil, scripts: URL? = nil,
      changed: @escaping (_ title: String?, _ url: URL?) -> Void = { _, _ in }
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

  /// A tab's view: `url` loaded, or with none a blank page and its address being edited
  @MainActor public static func makeView(url: URL?, context: Context) -> NSView {
    WebPageView(url: url, context: context)
  }
}
