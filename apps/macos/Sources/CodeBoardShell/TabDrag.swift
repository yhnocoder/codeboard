import AppKit
import SwiftUI

/// Which tabs a row holds: a tab is let go only on a row of its kind
enum TabKind { case board, reading }

/// A board or reading tab dragged out of its row (TabStrip asks it at every step): past `threshold` above or below the
/// row, or out of the window, the tab leaves the row and its picture follows the pointer in a borderless window of its
/// own, moved as a whole (nothing is drawn again while it moves). Let go on another window's row of its kind it moves
/// there, at the place the row marks; where no such row is, to a window of its own with the tab under the pointer (a
/// reading tab's shows only the reading pane). Esc, or its own row, puts it back
@MainActor final class TabDrag: TabDragging {
  private weak var set: WindowSet?
  let kind: TabKind
  static let threshold: CGFloat = 16
  /// Puts the picture on screen; tests, whose windows never are, keep it off
  var showPicture: (NSWindow) -> Void = { $0.orderFront(nil) }

  private struct Drag {
    let tab: UUID
    let from: WindowSet.Entry
    /// Where the press was, on screen, and where in the tab (y down)
    let start: CGPoint
    let grab: CGPoint
    var out = false
    var cancelled = false
    var picture: NSWindow?
    var over: WindowSet.Entry?
    /// Every window's row, found once as it leaves its own
    var rows: [(entry: WindowSet.Entry, frame: CGRect)] = []
    var row: CGRect?
  }
  private var drag: Drag?
  private var escape: Any?

  init(set: WindowSet, kind: TabKind) {
    self.set = set
    self.kind = kind
  }

  /// Whether a tab is out of its row now (and so not put back yet)
  var isOut: Bool { drag?.out == true && drag?.cancelled == false }

  func dragged(_ tab: UUID, title: String, at p: CGPoint, grab: CGPoint) -> Bool {
    guard let set else { return false }
    if drag?.tab != tab {
      guard let from = set.entry(holding: tab, kind) else { return false }
      drag = Drag(tab: tab, from: from, start: p, grab: grab)
    }
    guard var d = drag else { return false }
    // put back with Esc: out of the row's reordering until it is let go
    if d.cancelled { return true }
    if !d.out {
      if d.row == nil { d.row = set.tabRow(of: d.from, kind) }
      drag = d
      guard let row = d.row else { return false }
      let away = p.y < row.minY - Self.threshold || p.y > row.maxY + Self.threshold || !d.from.window.frame.contains(p)
      guard away else { return false }
      d.out = true
      d.rows = set.tabRows(kind)
      d.picture = picture(title, near: d.from.window)
      if let w = d.picture { showPicture(w) }
      listenForEscape()
    }
    d.picture?.setFrameTopLeftPoint(CGPoint(x: p.x - d.grab.x, y: p.y + d.grab.y))
    let over = set.row(at: p, slack: Self.threshold, in: d.rows, kind).flatMap { $0.entry === d.from ? nil : $0 }
    if let was = d.over, was !== over?.entry { set.setDrop(nil, in: was, kind) }
    d.over = over?.entry
    if let over { set.setDrop(over.index, in: over.entry, kind) }
    drag = d
    return true
  }

  func dropped(_ tab: UUID, at p: CGPoint) {
    guard let d = drag, d.tab == tab else { return }
    end()
    guard d.out, !d.cancelled, let set else { return }
    if let to = set.row(at: p, slack: Self.threshold, in: d.rows, kind) {
      // its own row: back where it was
      guard to.entry !== d.from else { return }
      switch kind {
      case .board: Task { await set.move(tab, from: d.from, to: to.entry, at: to.index) }
      case .reading: set.moveReading(tab, from: d.from, to: to.entry, at: to.index)
      }
      return
    }
    // its first tab under the pointer where the tab was held, the bar as high as in the window it left
    let w = d.from.window.frame
    let row = d.row ?? CGRect(x: w.minX, y: w.maxY - 40, width: w.width, height: 40)
    let y = p.y - (d.start.y - w.minY)
    switch kind {
    case .board:
      // as large as the window it left
      let origin = CGPoint(x: p.x - (row.minX - w.minX) - ShellTheme.stripPadding - d.grab.x, y: y)
      Task { await set.moveToNewWindow(tab, from: d.from, frame: CGRect(origin: origin, size: w.size)) }
    case .reading:
      // as wide as the reading panel it left, as tall as its window
      var frame = set.readingFrame(of: d.from)
      frame.origin = CGPoint(x: p.x - d.grab.x, y: y)
      set.moveReadingToNewWindow(tab, from: d.from, frame: frame, tabX: p.x - d.grab.x)
    }
  }

  /// Esc while a tab is out of its row: back where it was, its picture gone
  func cancel() {
    guard var d = drag, d.out, !d.cancelled else { return }
    d.cancelled = true
    d.picture?.orderOut(nil)
    d.picture = nil
    if let was = d.over { set?.setDrop(nil, in: was, kind) }
    d.over = nil
    drag = d
    stopListening()
  }

  private func end() {
    drag?.picture?.orderOut(nil)
    if let was = drag?.over { set?.setDrop(nil, in: was, kind) }
    drag = nil
    stopListening()
  }

  /// The tab as its row draws it, selected, drawn once
  private func picture(_ title: String, near window: NSWindow) -> NSWindow {
    let size = CGSize(width: TabItem.width(of: title), height: ShellTheme.tabHeight)
    let w = NSPanel(
      contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
      defer: false)
    w.isOpaque = false
    w.backgroundColor = .clear
    w.hasShadow = true
    w.ignoresMouseEvents = true
    w.level = .popUpMenu
    w.isReleasedWhenClosed = false
    w.appearance = window.effectiveAppearance
    let view = NSHostingView(rootView: TabItem(title: title, italic: false, selected: true, close: {}))
    view.frame = CGRect(origin: .zero, size: size)
    w.contentView = view
    return w
  }

  private func listenForEscape() {
    guard escape == nil else { return }
    escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
      guard e.keyCode == 53, let self, isOut else { return e }
      cancel()
      return nil
    }
  }

  private func stopListening() {
    if let escape { NSEvent.removeMonitor(escape) }
    escape = nil
  }
}
