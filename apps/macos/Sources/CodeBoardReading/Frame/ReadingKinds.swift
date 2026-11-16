import AppKit
import CodeBoardModel

/// The kinds of view a reading tab shows, each registered by its folder (PDF/, Web/…) under its name with what makes
/// its view. `registerBuiltIn` registers this build's, called once where the pane is made (the shell); a tab of a kind
/// not registered shows a blank page
@MainActor public enum ReadingKinds {
  public struct Kind {
    /// The SF Symbol before a tab's title; nil: none
    public var icon: String?
    /// A tab's title in the vault as just read; nil: what it shows is gone and it closes. Without it a tab keeps its
    /// title
    public var follow: (@MainActor (ReadingTab, ReadingPane) -> String?)?
    public var make: @MainActor (ReadingContext) -> NSView
  }

  private static var kinds: [String: Kind] = [:]

  public static func register(
    _ kind: String, icon: String? = nil, follow: (@MainActor (ReadingTab, ReadingPane) -> String?)? = nil,
    make: @escaping @MainActor (ReadingContext) -> NSView
  ) {
    kinds[kind] = Kind(icon: icon, follow: follow, make: make)
  }

  /// This build's kinds; a new folder's goes here
  public static func registerBuiltIn() {
    PDFReading.register()
    ListReading.register()
    CodeReading.register()
  }

  static func icon(of kind: String) -> String? { kinds[kind]?.icon }

  /// A tab's title now (its kind's follow), nil when what it shows is gone
  public static func follow(_ tab: ReadingTab, in pane: ReadingPane) -> String? {
    guard let follow = kinds[tab.kind]?.follow else { return tab.title }
    return follow(tab, pane)
  }

  /// What `ReadingContext.open` hands the tab it opens, until that tab's view is made
  fileprivate static var handing: (tab: ReadingTab.ID, value: Any)?

  /// The view a tab shows, made once when it opens and kept while it is open
  static func view(for tab: ReadingTab, in paneView: ReadingPaneView) -> NSView {
    let handed = handing.flatMap { $0.tab == tab.id ? $0.value : nil }
    return kinds[tab.kind]?.make(
      ReadingContext(tab: tab.id, kind: tab.kind, pane: paneView.pane, paneView: paneView, handed: handed))
      ?? NSView()
  }
}

/// A tab's view that follows the bar look (the board's theme, light or dark) when it changes
@MainActor public protocol ReadingLookFollower {
  func barLookChanged(_ look: ReadingBarLook)
}

/// What a tab's view is given: its tab, the pane (the vault, its entries, the pasteboard), and the ways to change its
/// own tab and to hand a passage to the board
@MainActor public struct ReadingContext {
  public let tab: ReadingTab.ID
  public let kind: String
  public let pane: ReadingPane
  weak var paneView: ReadingPaneView?
  /// What the tab that opened this one handed it (`open`'s `handing`); nil for every other way a tab is made. Never
  /// saved
  public let handed: Any?

  /// What the tab saves now
  public var payload: [String: String] { pane.tabs.first { $0.id == tab }?.payload ?? [:] }

  /// The look a tab's bars share with the board's, in its theme now; a view that is a ReadingLookFollower hears when it
  /// changes
  public var bar: ReadingBarLook { pane.barLook }

  /// This kind's own data on this machine, never in the vault (`<the app's folder>/Web` for "web"); nil when the
  /// shell gave none
  public var dataFolder: URL? {
    pane.machineFolder?.appending(path: kind.prefix(1).uppercased() + kind.dropFirst(), directoryHint: .isDirectory)
  }

  /// The tab follows what it shows: its title, what it saves, the key it is gone to by; nil leaves each as it is, and
  /// an empty key clears the tab's
  public func update(title: String? = nil, payload: [String: String]? = nil, key: String? = nil) {
    pane.update(tab, title: title, payload: payload, key: key)
  }

  /// A passage taken to the board (Add to Board, ⌥↵)
  public func collect(_ c: Collected) { pane.onCollect?(c) }

  /// Another tab of a kind after the current one, selected (`ReadingPane.open`), and its view, made now; not from
  /// within a kind's `make`. `handing`: what its view is made with, its context's `handed` (what WebKit hands over for
  /// a page's new window); a tab already open for `key` is gone to and given nothing
  @discardableResult
  public func open(
    _ title: String, kind: String, payload: [String: String] = [:], key: String? = nil, handing: Any? = nil
  ) -> NSView? {
    let id = pane.open(title, key: key, kind: kind, payload: payload)
    ReadingKinds.handing = handing.map { (id, $0) }
    defer { ReadingKinds.handing = nil }
    paneView?.sync()
    return paneView?.views[id]
  }
}

/// What the board's bottom bars look like, for a tab's floating bars to match: the board toolbar's in each theme
/// (CanvasToolbar: Warm Ink's glass pill 36 high cut at a radius of 14 over the window's blur, Ink Wash's 46 high;
/// 12 above the panel's bottom, BoardPanes.toolbarFrame; buttons 30 × 28 lit at a radius of 8.5) and its colours
/// (CanvasBar BarLook: the glass laid over the blur, its hairline, the icons' ink); and, from the theme (Theme.swift),
/// the paper popups are drawn on (its surface, as the sidenote popup's), the accent a selected object is ringed in and
/// a question's colour
public struct ReadingBarLook: Equatable, Sendable {
  public var height: CGFloat
  public var radius: CGFloat
  public var bottom: CGFloat = 12
  public var button = CGSize(width: 30, height: 28)
  public var buttonRadius: CGFloat = 8.5
  public var material = NSVisualEffectView.Material.underWindowBackground
  public var blending = NSVisualEffectView.BlendingMode.withinWindow
  public var glass: CGColor
  public var ring: CGColor
  public var ink: CGColor
  public var paper: CGColor
  public var accent: CGColor
  public var ask: CGColor
  public var dark: Bool

  public static func warmInk(dark: Bool) -> ReadingBarLook {
    dark
      ? ReadingBarLook(
        height: 36, radius: 14, glass: c(40, 39, 36, 0.6), ring: c(255, 240, 220, 0.11), ink: c(236, 232, 224),
        paper: hex(0x252422), accent: hex(0xe3895f), ask: hex(0xe0b055), dark: true)
      : ReadingBarLook(
        height: 36, radius: 14, glass: c(250, 248, 244, 0.62), ring: c(60, 45, 20, 0.16), ink: c(33, 31, 27),
        paper: hex(0xfdfcfa), accent: hex(0xb5552d), ask: hex(0xc48a1f), dark: false)
  }

  public static func inkWash(dark: Bool) -> ReadingBarLook {
    dark
      ? ReadingBarLook(
        height: 46, radius: 2, glass: c(28, 27, 25), ring: c(233, 229, 218, 0.14), ink: c(233, 229, 218),
        paper: hex(0x1e1d1a), accent: hex(0xd6533a), ask: hex(0xe0b055), dark: true)
      : ReadingBarLook(
        height: 46, radius: 2, glass: c(253, 253, 251), ring: c(29, 28, 26, 0.16), ink: c(29, 28, 26),
        paper: hex(0xfdfdfb), accent: hex(0xb8321f), ask: hex(0xc48a1f), dark: false)
  }

  private static func c(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
  }

  private static func hex(_ v: UInt32) -> CGColor {
    c(CGFloat(v >> 16 & 0xff), CGFloat(v >> 8 & 0xff), CGFloat(v & 0xff))
  }
}
