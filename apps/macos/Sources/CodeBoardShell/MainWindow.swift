import AppKit
import CodeBoardCanvas
import SwiftUI

/// The D2 window: sidebar on the window's own warm-grey ground, the board as a floating rounded panel with its tabs in
/// its top bar. Traffic lights, the sidebar toggle, back / forward and the tabs share one title line, sidebar shown or not.
@MainActor func makeMainWindow(shell: Shell) -> (NSWindow, BoardPanes) {
  let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
    styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
    backing: .buffered, defer: false)
  window.titlebarAppearsTransparent = true
  window.titleVisibility = .hidden
  // An empty unified toolbar only to lower the traffic lights; the title line follows wherever they end up
  window.toolbar = NSToolbar(identifier: "main")
  window.toolbarStyle = .unified
  window.backgroundColor = ShellTheme.ground
  window.minSize = NSSize(width: 640, height: 400)
  window.isReleasedWhenClosed = false
  let root = RootView(shell: shell)
  window.contentView = root
  if !window.setFrameUsingName("main") { window.center() }
  window.setFrameAutosaveName("main")
  return (window, root.panel.panes)
}

/// Re-runs `apply` whenever what it read from an @Observable changes
@MainActor func track(_ apply: @escaping @MainActor @Sendable () -> Void) {
  withObservationTracking(apply) { Task { @MainActor in track(apply) } }
}

/// A hosting view laid out exactly where it is put (no title-bar safe area) whose clicks are its own: the window's
/// title-bar band would otherwise move the window on a drag
private final class ChromeHost<Content: View>: NSHostingView<Content> {
  required init(rootView: Content) {
    super.init(rootView: rootView)
    safeAreaRegions = []
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("ChromeHost is not loaded from nibs")
  }

  override var mouseDownCanMoveWindow: Bool { false }
}

private final class RootView: NSView {
  let panel: Panel
  private let shell: Shell
  private let sidebar: NSView
  private let controls: NSView
  private var shownLaidOut: Bool?

  init(shell: Shell) {
    self.shell = shell
    panel = Panel(shell: shell)
    sidebar = ChromeHost(rootView: Sidebar(shell: shell))
    controls = ChromeHost(rootView: TitleControls(shell: shell))
    super.init(frame: .zero)
    for view in [sidebar, panel, controls] { addSubview(view) }
    track { [weak self] in
      guard let self else { return }
      _ = shell.sidebarShown
      needsLayout = true
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("RootView is not loaded from nibs")
  }

  override var isFlipped: Bool { true }

  override func layout() {
    let shown = shell.sidebarShown
    guard shownLaidOut == nil || shownLaidOut == shown else {
      shownLaidOut = shown
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.22
        context.allowsImplicitAnimation = true
        place(shown: shown)
      }
      return
    }
    shownLaidOut = shown
    place(shown: shown)
  }

  private func place(shown: Bool) {
    let inset = ShellTheme.inset
    let width = ShellTheme.sidebarWidth
    // The title line runs through the traffic lights' centre
    var line: CGFloat = 26
    var lightsEnd: CGFloat = 70
    if let zoom = window?.standardWindowButton(.zoomButton), let parent = zoom.superview {
      let r = convert(zoom.frame, from: parent)
      line = r.midY
      lightsEnd = r.maxX
    }
    let size = controls.fittingSize
    controls.frame = NSRect(x: lightsEnd + 12, y: line - size.height / 2, width: size.width, height: size.height)
    let top = line + 22
    sidebar.frame = NSRect(x: shown ? 0 : -width, y: top, width: width, height: bounds.height - top)
    sidebar.alphaValue = shown ? 1 : 0
    let x = shown ? width : inset
    panel.frame = NSRect(x: x, y: inset, width: bounds.width - x - inset, height: bounds.height - 2 * inset)
    panel.barHeight = 2 * (line - inset)
    panel.tabsLeading = shown ? inset : controls.frame.maxX + inset - x
    panel.layoutSubtreeIfNeeded()
  }
}

/// The floating board panel: one canvas-coloured surface (top bar, canvases, empty and error states alike), the tabs
/// at the top with nothing between them and the canvas
private final class Panel: NSView {
  let panes: BoardPanes
  var barHeight: CGFloat = 36 { didSet { needsLayout = true } }
  var tabsLeading: CGFloat = 8 { didSet { needsLayout = true } }
  private let shell: Shell
  private let clip = FlippedView()
  private let glass = TopGlass()
  private let tabs: NSView
  private let empty = NSButton(title: "Open Vault…", target: nil, action: #selector(AppDelegate.openVault(_:)))

  init(shell: Shell) {
    self.shell = shell
    panes = BoardPanes(shell: shell)
    tabs = ChromeHost(rootView: TabStrip(shell: shell))
    super.init(frame: .zero)
    wantsLayer = true
    layer?.shadowOpacity = 0.08
    layer?.shadowRadius = 1.5
    layer?.shadowOffset = CGSize(width: 0, height: -1)
    clip.wantsLayer = true
    clip.layer?.cornerRadius = ShellTheme.panelRadius
    clip.layer?.cornerCurve = .continuous
    clip.layer?.masksToBounds = true
    clip.layer?.borderWidth = 0.5
    empty.bezelStyle = .push
    empty.controlSize = .large
    addSubview(clip)
    for view in [panes, glass, tabs, empty] { clip.addSubview(view) }
    track { [weak self] in
      guard let self else { return }
      empty.isHidden = shell.vault != nil
      tabs.isHidden = shell.vault == nil
      let look = shell.look
      clip.layer?.backgroundColor = ShellTheme.board(look)
      clip.layer?.borderColor = ShellTheme.cg(ShellTheme.shadeNS.withAlphaComponent(0.14), dark: look.dark)
      layer?.shadowColor = ShellTheme.cg(ShellTheme.dropNS, dark: look.dark)
      glass.theme = look
      panes.sync()
    }
    track { [weak self] in
      guard let self else { return }
      glass.look = shell.glass
      needsLayout = true
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("Panel is not loaded from nibs")
  }

  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    clip.frame = bounds
    layer?.shadowPath = CGPath(
      roundedRect: bounds, cornerWidth: ShellTheme.panelRadius, cornerHeight: ShellTheme.panelRadius, transform: nil)
    tabs.frame = NSRect(x: tabsLeading, y: 0, width: max(0, bounds.width - tabsLeading - 8), height: barHeight)
    panes.frame = NSRect(x: 0, y: barHeight, width: bounds.width, height: max(0, bounds.height - barHeight))
    glass.frame = NSRect(x: 0, y: 0, width: bounds.width, height: barHeight + glass.look.dissolve)
    glass.place(bar: barHeight)
    let size = empty.fittingSize
    empty.frame = NSRect(
      x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
  }
}

/// The canvas runs on under the top bar, so cards pass under the tabs: there they are seen blurred through frosted glass
/// tinted with the canvas colour, which dissolves into the canvas over a few points below the bar so it has no edge.
/// Core Animation blurs what is behind it on the GPU as it composites; nothing here runs per frame
final class TopGlass: NSView {
  /// What the glass is made of; the defaults are ShellTheme's
  struct Look: Equatable, Sendable {
    var kind = Kind.material
    var material = ShellTheme.glassMaterial
    var tint = ShellTheme.glassTint
    var dissolve = ShellTheme.glassDissolve
    var emphasized = false
    /// The rest of the panel looks the same when the window is in the background, so the row does too
    var state = NSVisualEffectView.State.active
  }

  // ponytail: two ways of making the glass while the owner compares them in GlassTuning; keep one, drop the enum. A
  // layer blurring what is behind it by a radius of our own was tried: background filters (CIGaussianBlur) draw nothing
  // within the window on macOS 27, and nothing else public blurs what is behind a layer
  enum Kind: String, Sendable {
    /// A system material (NSVisualEffectView)
    case material
    /// Liquid Glass in its clear style (NSGlassEffectView)
    case glass
  }

  var theme = Theme.warmInk { didSet { retint() } }
  var look = Look() {
    didSet {
      guard look != oldValue else { return }
      if look.kind != oldValue.kind { rebuild() }
      adopt()
      retint()
    }
  }
  /// What blurs, by the kind: built in GlassTuning
  private(set) var effect = NSView()
  private var bar: CGFloat = 0
  private let tint = GradientView()

  override init(frame: NSRect) {
    super.init(frame: frame)
    tint.frame = bounds
    tint.autoresizingMask = [.width, .height]
    addSubview(tint)
    rebuild()
    adopt()
    retint()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("TopGlass is not loaded from nibs")
  }

  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func layout() {
    super.layout()
    effect.layer?.mask?.frame = effect.bounds
  }

  func place(bar: CGFloat) {
    guard bar != self.bar else { return }
    self.bar = bar
    adopt()
    retint()
  }

  private func rebuild() {
    effect.removeFromSuperview()
    effect = TopGlass.effect(look.kind)
    effect.frame = bounds
    effect.autoresizingMask = [.width, .height]
    addSubview(effect, positioned: .below, relativeTo: tint)
  }

  private func adopt() { TopGlass.adopt(look, on: effect, stops: TopGlass.stops(bar: bar, dissolve: look.dissolve)) }

  /// The effect's mask fades it out below the bar; the tint, which it does not mask, fades along the same curve
  private func retint() {
    let stops = TopGlass.stops(bar: bar, dissolve: look.dissolve)
    tint.gradient.colors = stops.map { theme.canvas.copy(alpha: look.tint * $0.alpha) ?? theme.canvas }
    tint.gradient.locations = stops.map { NSNumber(value: Double($0.at)) }
  }

  /// A material's mask: its one opaque row stretched over the bar
  static func mask(dissolve d: CGFloat) -> NSImage {
    let stops = TopGlass.stops(bar: 1, dissolve: d)
    let img = NSImage(size: NSSize(width: 1, height: 1 + d), flipped: true) { r in
      NSGradient(
        colors: stops.map { NSColor(white: 0, alpha: $0.alpha) }, atLocations: stops.map(\.at), colorSpace: .sRGB
      )?.draw(in: r, angle: 90)
      return true
    }
    img.capInsets = NSEdgeInsets(top: 0, left: 0, bottom: d, right: 0)
    img.resizingMode = .stretch
    return img
  }

  /// Opacity down the glass, at fractions of its height: whole over the bar, then out to nothing along a smoothstep
  static func stops(bar: CGFloat, dissolve d: CGFloat) -> [(at: CGFloat, alpha: CGFloat)] {
    let n = 8
    return [(0, 1)]
      + (0...n).map { i in
        let t = CGFloat(i) / CGFloat(n)
        return ((bar + t * d) / max(bar + d, 1), 1 - t * t * (3 - 2 * t))
      }
  }
}

private final class GradientView: NSView {
  let gradient = CAGradientLayer()

  override init(frame: NSRect) {
    super.init(frame: frame)
    layer = gradient
    wantsLayer = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("GradientView is not loaded from nibs")
  }

  override var isFlipped: Bool { true }
}

private final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}

/// Sidebar toggle, back and forward, right of the traffic lights; they never move
private struct TitleControls: View {
  let shell: Shell

  var body: some View {
    HStack(spacing: 2) {
      Button {
        shell.sidebarShown.toggle()
      } label: {
        Image(systemName: "sidebar.left").font(.system(size: 14))
      }
      .help(shell.sidebarShown ? "Hide Sidebar" : "Show Sidebar")
      Button(action: shell.goBack) {
        Image(systemName: "chevron.left").font(.system(size: 13, weight: .medium))
      }
      .disabled(!shell.canGoBack)
      .help("Back")
      Button(action: shell.goForward) {
        Image(systemName: "chevron.right").font(.system(size: 13, weight: .medium))
      }
      .disabled(!shell.canGoForward)
      .help("Forward")
    }
    .buttonStyle(ChromeButtonStyle())
    .opacity(shell.vault == nil ? 0 : 1)
  }
}
