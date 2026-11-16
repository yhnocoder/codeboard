import AppKit
import CodeBoardCanvas
import CodeBoardReading
import SwiftUI
import UniformTypeIdentifiers

/// The D2 window: sidebar on the window's own warm-grey ground, the board and the reading pane as floating rounded
/// panels, each with its tabs in its top bar. Traffic lights, the sidebar toggle, back / forward and both panels' tabs
/// share one title line, whichever is shown.
@MainActor func makeMainWindow(shell: Shell) -> (NSWindow, BoardPanes) {
  let window = BoardWindow(
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
  let panes = root.panes
  shell.confirm = { [weak window, weak panes] alert in await panes?.confirm(alert, window) ?? false }
  shell.askPDFs = { [weak window] in
    guard let window else { return [] }
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.pdf]
    panel.allowsMultipleSelection = true
    panel.prompt = "Add"
    return await panel.beginSheetModal(for: window) == .OK ? panel.urls : []
  }
  shell.askArxiv = { [weak window, weak shell] resource in
    guard let window, let shell else { return }
    var sheet: ArxivSheet?
    sheet = ArxivSheet(
      missing: shell.reading.translations.map { $0.missing } ?? "Translations are not set up.",
      add: { await shell.addArxiv($0, translate: $1, to: resource) },
      done: {
        if let s = sheet?.window { window.endSheet(s) }
        sheet = nil
      })
    if let s = sheet?.window { window.beginSheet(s) }
  }
  if !window.setFrameUsingName("main") { window.center() }
  window.setFrameAutosaveName("main")
  return (window, panes)
}

/// Re-runs `apply` whenever what it read from an @Observable changes
@MainActor func track(_ apply: @escaping @MainActor @Sendable () -> Void) {
  withObservationTracking(apply) { Task { @MainActor in track(apply) } }
}

/// A hosting view laid out exactly where it is put (no title-bar safe area) whose clicks are its own: the window's
/// title-bar band would otherwise move the window on a drag
private class ChromeHost<Content: View>: NSHostingView<Content> {
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
  let panes: BoardPanes
  let panel: Panel
  let reading: Panel
  let readingView: ReadingPaneView
  private let shell: Shell
  private let sidebar: NSView
  private let controls: NSView
  private let edge: SidebarEdge
  private let divider: ReadingDivider
  private var laidOut: Arrangement?

  /// What is shown and where: a change of it slides into place
  private struct Arrangement: Equatable {
    var sidebar: Bool
    var reading: Bool
    var side: ReadingPane.Side
  }

  init(shell: Shell) {
    self.shell = shell
    panes = BoardPanes(shell: shell)
    let empty = NSButton(title: "Open Vault…", target: nil, action: #selector(AppDelegate.openVault(_:)))
    empty.bezelStyle = .push
    empty.controlSize = .large
    panel = Panel(
      shell: shell, content: panes, tabs: BoardTabRow(rootView: TabStrip(source: shell)), empty: empty,
      trailing: ReadingControls(pane: shell.reading), sync: { [weak panes] in panes?.sync() })
    readingView = ReadingPaneView(pane: shell.reading)
    reading = Panel(
      shell: shell, content: readingView, tabs: ReadingTabRow(rootView: TabStrip(source: shell.reading)),
      sync: { [weak readingView] in
        // the board's bar look reaches the tabs' bars
        let t = shell.look
        let look = t.id == .inkWash ? ReadingBarLook.inkWash(dark: t.dark) : .warmInk(dark: t.dark)
        if shell.reading.barLook != look { shell.reading.barLook = look }
        readingView?.sync()
      })
    sidebar = ChromeHost(rootView: Sidebar(shell: shell))
    controls = ChromeHost(rootView: TitleControls(shell: shell))
    edge = SidebarEdge(shell: shell)
    divider = ReadingDivider(pane: shell.reading)
    super.init(frame: .zero)
    for view in [sidebar, reading, panel, divider, controls, edge] { addSubview(view) }
    track { [weak self] in
      guard let self else { return }
      _ = shell.sidebarShown
      _ = shell.sidebarWidth
      _ = arrangement
      _ = shell.reading.width
      needsLayout = true
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("RootView is not loaded from nibs")
  }

  override var isFlipped: Bool { true }

  private var arrangement: Arrangement {
    Arrangement(
      sidebar: shell.sidebarShown, reading: shell.vault != nil && shell.reading.shown, side: shell.reading.side)
  }

  override func layout() {
    let now = arrangement
    if !now.reading, readingView.hasKeys { panes.takeKeys() }
    if now.reading { reading.isHidden = false }
    guard laidOut == nil || laidOut == now else {
      laidOut = now
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.22
        context.allowsImplicitAnimation = true
        place(now)
      } completionHandler: { [weak self] in
        // hidden once it is out of sight, unless shown again meanwhile
        MainActor.assumeIsolated {
          guard let self, self.laidOut?.reading == false else { return }
          self.reading.isHidden = true
        }
      }
      return
    }
    laidOut = now
    reading.isHidden = !now.reading
    place(now)
  }

  private func place(_ a: Arrangement) {
    let inset = ShellTheme.inset
    let width = shell.sidebarWidth
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
    sidebar.frame = NSRect(x: a.sidebar ? 0 : -width, y: top, width: width, height: bounds.height - top)
    sidebar.alphaValue = a.sidebar ? 1 : 0
    edge.frame = NSRect(x: width - 3, y: top, width: 6, height: bounds.height - top)
    edge.isHidden = !a.sidebar
    // The board and the reading pane share what is right of the sidebar, a gap as wide as the inset between them
    let x = a.sidebar ? width : inset
    let room = bounds.width - x - inset
    // hidden, the pane stays where it shows, faded out under the board panel
    let r = ReadingPane.fit(shell.reading.width, in: room - inset)
    let beside = room - inset - r
    let left = a.side == .left
    let height = bounds.height - 2 * inset
    panel.frame = NSRect(
      x: a.reading && left ? x + r + inset : x, y: inset, width: a.reading ? beside : room, height: height)
    reading.frame = NSRect(x: left ? x : x + beside + inset, y: inset, width: r, height: height)
    reading.alphaValue = a.reading ? 1 : 0
    divider.frame = NSRect(x: left ? x + r : x + beside, y: inset, width: inset, height: height)
    divider.room = room - inset
    divider.isHidden = !a.reading
    // The leftmost panel's tabs begin after the title controls when the sidebar is hidden
    let first = a.reading && left ? reading : panel
    for p in [panel, reading] {
      p.barHeight = 2 * (line - inset)
      p.tabsLeading = !a.sidebar && p === first ? controls.frame.maxX + inset - p.frame.minX : inset
      p.layoutSubtreeIfNeeded()
    }
  }
}

/// The sidebar's right edge: dragged, it sets the sidebar's width
private final class SidebarEdge: NSView {
  private let shell: Shell
  private var from: (x: CGFloat, width: CGFloat)?

  init(shell: Shell) {
    self.shell = shell
    super.init(frame: .zero)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("SidebarEdge is not loaded from nibs")
  }

  override var mouseDownCanMoveWindow: Bool { false }

  override func resetCursorRects() { addCursorRect(bounds, cursor: .columnResize) }

  override func mouseDown(with event: NSEvent) { from = (event.locationInWindow.x, shell.sidebarWidth) }

  override func mouseDragged(with event: NSEvent) {
    guard let from else { return }
    let w = from.width + event.locationInWindow.x - from.x
    shell.sidebarWidth = min(max(w.rounded(), Shell.sidebarWidths.lowerBound), Shell.sidebarWidths.upperBound)
  }

  override func mouseUp(with event: NSEvent) { from = nil }
}

/// The reading pane's divider: dragged, it sets how wide the pane is, within both panels' minimums
private final class ReadingDivider: NSView {
  private let pane: ReadingPane
  /// What the two panels share now (the window lays it out)
  var room: CGFloat = 0
  private var from: (x: CGFloat, width: CGFloat)?

  init(pane: ReadingPane) {
    self.pane = pane
    super.init(frame: .zero)
    setAccessibilityIdentifier("ui-readingdivider")
    setAccessibilityElement(true)
    setAccessibilityRole(.splitter)
    setAccessibilityLabel("Reading Pane Divider")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("ReadingDivider is not loaded from nibs")
  }

  override var mouseDownCanMoveWindow: Bool { false }

  override func resetCursorRects() { addCursorRect(bounds, cursor: .columnResize) }

  override func mouseDown(with event: NSEvent) {
    from = (event.locationInWindow.x, ReadingPane.fit(pane.width, in: room))
  }

  override func mouseDragged(with event: NSEvent) {
    guard let from else { return }
    let dx = event.locationInWindow.x - from.x
    pane.width = ReadingPane.fit(pane.side == .right ? from.width - dx : from.width + dx, in: room)
  }

  override func mouseUp(with event: NSEvent) { from = nil }
}

/// A floating panel: one canvas-coloured surface (top bar, content, empty and error states alike), the tabs at the
/// top with nothing between them and the content. The board's and the reading pane's
private final class Panel: NSView {
  let content: NSView
  var barHeight: CGFloat = 36 { didSet { needsLayout = true } }
  var tabsLeading: CGFloat = 8 { didSet { needsLayout = true } }
  private let clip = FlippedView()
  private let glass = TopGlass()
  private let tabs: NSView
  /// In the middle while no vault is open
  private let empty: NSView?
  /// At the right end of the top bar
  private let trailing: NSView?

  /// `sync`: brings the content up to the shell, run again whenever what it read changes
  init(
    shell: Shell, content: NSView, tabs: NSView, empty: NSView? = nil, trailing: NSView? = nil,
    sync: @escaping @MainActor () -> Void
  ) {
    self.content = content
    self.tabs = tabs
    self.empty = empty
    self.trailing = trailing
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
    addSubview(clip)
    for view in [content, glass, tabs] + [trailing, empty].compactMap(\.self) { clip.addSubview(view) }
    track { [weak self] in
      guard let self else { return }
      self.empty?.isHidden = shell.vault != nil
      self.trailing?.isHidden = shell.vault == nil
      tabs.isHidden = shell.vault == nil
      let look = shell.look
      clip.layer?.backgroundColor = ShellTheme.board(look)
      clip.layer?.borderColor = ShellTheme.cg(ShellTheme.shadeNS.withAlphaComponent(0.14), dark: look.dark)
      layer?.shadowColor = ShellTheme.cg(ShellTheme.dropNS, dark: look.dark)
      glass.theme = look
      sync()
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
    var end = bounds.width - 8
    if let trailing {
      let size = trailing.fittingSize
      end -= size.width
      trailing.frame = NSRect(x: end, y: (barHeight - size.height) / 2, width: size.width, height: size.height)
      end -= 4
    }
    tabs.frame = NSRect(x: tabsLeading, y: 0, width: max(0, end - tabsLeading), height: barHeight)
    content.frame = NSRect(x: 0, y: barHeight, width: bounds.width, height: max(0, bounds.height - barHeight))
    glass.frame = NSRect(x: 0, y: 0, width: bounds.width, height: barHeight + ShellTheme.glassDissolve)
    glass.place(bar: barHeight)
    if let empty {
      let size = empty.fittingSize
      empty.frame = NSRect(
        x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width,
        height: size.height)
    }
  }
}

/// The board's tab row and the reading pane's, each a view of its own class (what the acceptance driver finds)
private final class BoardTabRow: ChromeHost<TabStrip<Shell>> {
  required init(rootView: TabStrip<Shell>) {
    super.init(rootView: rootView)
    setAccessibilityIdentifier("ui-boardtabs")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("BoardTabRow is not loaded from nibs")
  }
}

private final class ReadingTabRow: ChromeHost<TabStrip<ReadingPane>> {
  required init(rootView: TabStrip<ReadingPane>) {
    super.init(rootView: rootView)
    setAccessibilityIdentifier("ui-readingtabs")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("ReadingTabRow is not loaded from nibs")
  }
}

/// At the far right of the board's top bar: the reading pane's switch, two cells with the pane's side filled, which
/// shows and hides it; the small arrow before it moves the pane to the other side
final class ReadingControls: NSView {
  let pane: ReadingPane
  let toggle: ChromeIconButton
  let flip: ChromeIconButton

  init(pane: ReadingPane) {
    self.pane = pane
    toggle = ChromeIconButton(width: 28, size: 14)
    flip = ChromeIconButton(width: 16, size: 9)
    super.init(frame: .zero)
    toggle.setAccessibilityIdentifier("ui-readingswitch")
    flip.setAccessibilityIdentifier("ui-readingside")
    toggle.target = self
    toggle.action = #selector(toggled)
    flip.target = self
    flip.action = #selector(flipped)
    addSubview(flip)
    addSubview(toggle)
    track { [weak self] in
      guard let self else { return }
      let side = pane.side
      let words = pane.shown ? "Hide Reading Pane" : "Show Reading Pane"
      toggle.symbol = Self.symbol(side)
      toggle.toolTip = words
      toggle.setAccessibilityLabel(words)
      flip.symbol = side == .right ? "chevron.left" : "chevron.right"
      let move = side == .right ? "Move Reading Pane to the Left" : "Move Reading Pane to the Right"
      flip.toolTip = move
      flip.setAccessibilityLabel(move)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("ReadingControls is not loaded from nibs")
  }

  /// Two cells, the one the pane is on filled
  static func symbol(_ side: ReadingPane.Side) -> String {
    side == .right ? "rectangle.righthalf.filled" : "rectangle.lefthalf.filled"
  }

  override var isFlipped: Bool { true }
  override var fittingSize: NSSize { NSSize(width: flip.frame.width + toggle.frame.width, height: toggle.frame.height) }

  override func layout() {
    super.layout()
    flip.setFrameOrigin(.zero)
    toggle.setFrameOrigin(NSPoint(x: flip.frame.width, y: 0))
  }

  @objc private func toggled() { pane.shown.toggle() }
  @objc private func flipped() { pane.side = pane.side.other }
}

/// A borderless icon button of the window chrome in AppKit, as ChromeButtonStyle draws it in SwiftUI: muted, a tint
/// under it on hover and a darker one while pressed
final class ChromeIconButton: NSButton {
  private let size: CGFloat
  private var hovered = false { didSet { needsDisplay = true } }
  var symbol = "" {
    didSet {
      guard symbol != oldValue else { return }
      image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(
        .init(pointSize: size, weight: .medium))
    }
  }

  init(width: CGFloat, size: CGFloat) {
    self.size = size
    super.init(frame: NSRect(x: 0, y: 0, width: width, height: 26))
    isBordered = false
    imagePosition = .imageOnly
    imageScaling = .scaleNone
    contentTintColor = NSColor(ShellTheme.muted)
    focusRingType = .none
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("ChromeIconButton is not loaded from nibs")
  }

  override var mouseDownCanMoveWindow: Bool { false }
  override var intrinsicContentSize: NSSize { frame.size }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { hovered = true }
  override func mouseExited(with event: NSEvent) { hovered = false }

  override func draw(_ dirtyRect: NSRect) {
    let tint: CGFloat = isHighlighted ? 0.12 : hovered ? 0.06 : 0
    if tint > 0 {
      ShellTheme.shadeNS.withAlphaComponent(tint).setFill()
      NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
    }
    super.draw(dirtyRect)
  }
}

/// The canvas runs on under the top bar, so cards pass under the tabs: there they are behind a material in the canvas
/// colour, which dissolves into the canvas over a few points below the bar so it has no edge. Core Animation composites
/// it on the GPU; nothing here runs per frame
final class TopGlass: NSVisualEffectView {
  var theme = Theme.warmInk { didSet { retint() } }
  private var bar: CGFloat = 0
  private let tint = GradientView()

  override init(frame: NSRect) {
    super.init(frame: frame)
    blendingMode = .withinWindow
    material = ShellTheme.glassMaterial
    // The rest of the panel looks the same when the window is in the background, so the row does too
    state = .active
    maskImage = TopGlass.mask
    tint.frame = bounds
    tint.autoresizingMask = [.width, .height]
    addSubview(tint)
    retint()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("TopGlass is not loaded from nibs")
  }

  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func place(bar: CGFloat) {
    guard bar != self.bar else { return }
    self.bar = bar
    retint()
  }

  /// The material's own mask stretches its one opaque row over the bar; the tint, which it does not mask, fades along
  /// the same curve
  private func retint() {
    let stops = TopGlass.stops(bar: bar)
    tint.gradient.colors = stops.map { theme.canvas.copy(alpha: ShellTheme.glassTint * $0.alpha) ?? theme.canvas }
    tint.gradient.locations = stops.map { NSNumber(value: Double($0.at)) }
  }

  private static let mask: NSImage = {
    let d = ShellTheme.glassDissolve
    let stops = TopGlass.stops(bar: 1)
    let img = NSImage(size: NSSize(width: 1, height: 1 + d), flipped: true) { r in
      NSGradient(
        colors: stops.map { NSColor(white: 0, alpha: $0.alpha) }, atLocations: stops.map(\.at), colorSpace: .sRGB
      )?.draw(in: r, angle: 90)
      return true
    }
    img.capInsets = NSEdgeInsets(top: 0, left: 0, bottom: d, right: 0)
    img.resizingMode = .stretch
    return img
  }()

  /// Opacity down the glass, at fractions of its height: whole over the bar, then out to nothing along a smoothstep
  static func stops(bar: CGFloat) -> [(at: CGFloat, alpha: CGFloat)] {
    let d = ShellTheme.glassDissolve
    let n = 8
    return [(0, 1)]
      + (0...n).map { i in
        let t = CGFloat(i) / CGFloat(n)
        return ((bar + t * d) / (bar + d), 1 - t * t * (3 - 2 * t))
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
struct TitleControls: View {
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
