import AppKit
import CodeBoardModel

// The cards and Sections as accessibility elements, for VoiceOver and the acceptance driver: the identifier is the id,
// the frame where it is drawn now (its layer as on screen, so mid-drag and mid-animation too), read only when asked:
// nothing is kept up to date while a gesture runs.

/// A card or a Section on the board
@MainActor final class BoardElement: NSAccessibilityElement {
  weak var canvas: CanvasView?
  let item: Item

  init(_ item: Item, in canvas: CanvasView) {
    self.item = item
    self.canvas = canvas
    super.init()
    setAccessibilityParent(canvas)
    setAccessibilityRole(.group)
    switch item {
    case .card(let id): setAccessibilityIdentifier(id.rawValue)
    case .section(let id): setAccessibilityIdentifier(id.rawValue)
    default: break
    }
  }

  override func accessibilityFrame() -> NSRect { canvas?.screenFrame(of: item) ?? .zero }
  override func accessibilityLabel() -> String? { canvas?.spokenName(of: item) }
  override func accessibilityRoleDescription() -> String? {
    if case .section = item { "Section" } else { "card" }
  }
}

extension CanvasView {
  public override func isAccessibilityElement() -> Bool { true }
  public override func accessibilityRole() -> NSAccessibility.Role? { .group }
  public override func accessibilityLabel() -> String? { shown?.board.title ?? "Board" }

  public override func accessibilityChildren() -> [Any]? {
    guard let s = scene else { return chromeElements() }
    var want: [Item] = s.frames.map { .section($0.id) }
    for it in s.items { if case .card(let id)? = it.owner { want.append(.card(id)) } }
    var kept: [Item: BoardElement] = [:]
    let out: [Any] = want.map { i in
      let e = axElements[i] ?? BoardElement(i, in: self)
      kept[i] = e
      return e
    }
    axElements = kept
    return out + chromeElements()
  }

  /// The toolbar's and the dock's parts
  func chromeElements() -> [Any] { [] }

  /// Where an item is drawn now, on the screen
  func screenFrame(of item: Item) -> NSRect {
    guard let window, let root = layer, let l = drawnLayer(item) else { return .zero }
    // an animation under way (a frame easing, a card springing back): where it is in it; else where it was just put,
    // which the presentation shows only once the transaction is in
    let r: CGRect
    if l.animationKeys()?.isEmpty == false, let p = l.presentation(), let q = root.presentation() {
      r = p.convert(p.bounds, to: q)
    } else {
      r = l.convert(l.bounds, to: root)
    }
    return window.convertToScreen(convert(r, to: nil))
  }

  private func drawnLayer(_ item: Item) -> CALayer? {
    switch item {
    case .card(let id): return index(of: .card(id)).map { items[$0].box }
    case .section(let id):
      guard let i = scene?.frames.firstIndex(where: { $0.id == id }), let ls = sections.sublayers, i < ls.count
      else { return nil }
      return ls[i]
    default: return nil
    }
  }

  func spokenName(of item: Item) -> String? {
    guard let b = document?.board else { return nil }
    switch item {
    case .section(let id): return b.section(id)?.title
    case .card(let id):
      guard let c = b.card(id) else { return nil }
      if case .own(let k) = c.content, let t = k.title { return t }
      return c.writing?.split(separator: "\n").first.map(String.init)
    default: return nil
    }
  }
}
