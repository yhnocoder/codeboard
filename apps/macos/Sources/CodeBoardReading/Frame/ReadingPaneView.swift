import AppKit

/// The reading pane's content below its tab row: each open tab's view, made when the tab opens and kept while it is
/// open, the current one on screen; with no tab, nothing but the panel. A click in it, or a tab opened or switched to,
/// gives it the keys (the current tab's view takes them when it can), and while it has them the tab keys (Close Tab,
/// Show Next and Previous Tab) are its tabs'
public final class ReadingPaneView: NSView, NSMenuItemValidation {
  public let pane: ReadingPane
  private(set) var views: [ReadingTab.ID: NSView] = [:]
  /// The tab on screen at the last sync, once there was one
  private var synced: ReadingTab.ID??
  /// The bar look the tabs' views last followed
  private var look: ReadingBarLook?

  public init(pane: ReadingPane) {
    self.pane = pane
    super.init(frame: .zero)
    setAccessibilityIdentifier("ui-readingpane")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("ReadingPaneView is not loaded from nibs")
  }

  public override var isFlipped: Bool { true }
  public override var acceptsFirstResponder: Bool { true }
  public override func mouseDown(with event: NSEvent) { takeKeys() }

  /// Follows the tabs: new tabs get their view, closed ones lose it, the current one shows; one switched to since
  /// the last sync takes the keys
  public func sync() {
    let live = Set(pane.tabs.map(\.id))
    for (id, view) in views where !live.contains(id) {
      view.removeFromSuperview()
      views[id] = nil
    }
    for tab in pane.tabs where views[tab.id] == nil {
      let view = ReadingKinds.view(for: tab, in: self)
      view.frame = bounds
      view.autoresizingMask = [.width, .height]
      addSubview(view)
      views[tab.id] = view
    }
    for (id, view) in views { view.isHidden = id != pane.selected }
    if look != pane.barLook {
      look = pane.barLook
      for case let v as ReadingLookFollower in views.values { v.barLookChanged(pane.barLook) }
    }
    if let was = synced, was != pane.selected, pane.selected != nil { takeKeys() }
    synced = .some(pane.selected)
  }

  /// The keys go to the current tab's view when it takes them, else here; they stay where they are when a view in the
  /// current tab has them already (a web tab's address field), or something outside the pane is being typed in (the
  /// sidebar's rename or search field)
  public func takeKeys() {
    guard let window else { return }
    if let text = window.firstResponder as? NSText, !text.isDescendant(of: self) { return }
    let current = pane.selected.flatMap { views[$0] }
    if let current, let r = window.firstResponder as? NSView, r.isDescendant(of: current) { return }
    window.makeFirstResponder(current?.acceptsFirstResponder == true ? current : self)
  }

  /// Whether the keys are here or in a view inside
  public var hasKeys: Bool {
    guard let r = window?.firstResponder as? NSView else { return false }
    return r === self || r.isDescendant(of: self)
  }

  // The tab keys, by the selectors of the app's menu items: the responder chain brings them here first
  @objc func closeTab(_ sender: Any?) {
    if let tab = pane.selected { pane.close(tab) }
  }
  @objc func showNextTab(_ sender: Any?) { pane.selectTab(by: 1) }
  @objc func showPreviousTab(_ sender: Any?) { pane.selectTab(by: -1) }

  public func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(closeTab(_:)):
      item.title = "Close Tab"
      return pane.selected != nil
    case #selector(showNextTab(_:)), #selector(showPreviousTab(_:)): return pane.tabs.count > 1
    default: return true
    }
  }
}
