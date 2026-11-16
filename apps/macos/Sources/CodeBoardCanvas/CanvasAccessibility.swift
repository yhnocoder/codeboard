import AppKit
import CodeBoardModel

// The cards, Sections, arrow labels, sidenote markers and stickers as accessibility elements, for VoiceOver and the
// acceptance driver: the identifier is the id (a sidenote's: the marker that shows it), the frame where it is drawn now
// (its layer as on screen, so mid-drag and mid-animation too), read only when asked: nothing is kept up to date while
// a gesture runs. One that is not drawn (folded away, on hidden lines, off its card's shown part) has no element.

/// What an element stands for: an item of the board, or a sidenote (where its marker is)
enum BoardThing: Hashable {
  case item(Item)
  case sidenote(SidenoteID)
}

/// A card, a Section, an arrow's label, a sidenote's marker or a sticker on the board
@MainActor final class BoardElement: NSAccessibilityElement {
  weak let canvas: CanvasView?
  let item: BoardThing

  init(_ item: BoardThing, in canvas: CanvasView) {
    self.item = item
    self.canvas = canvas
    super.init()
    setAccessibilityParent(canvas)
    setAccessibilityRole(.group)
    switch item {
    case .item(.card(let id)): setAccessibilityIdentifier(id.rawValue)
    case .item(.section(let id)): setAccessibilityIdentifier(id.rawValue)
    case .item(.arrow(let id)): setAccessibilityIdentifier(id.rawValue)
    case .item(.sticker(let id)): setAccessibilityIdentifier(id.rawValue)
    case .sidenote(let id): setAccessibilityIdentifier(id.rawValue)
    }
  }

  // AppKit asks these on the main thread; the SDK leaves the overrides nonisolated
  override func accessibilityFrame() -> NSRect {
    MainActor.assumeIsolated { [canvas, item] in canvas?.screenFrame(of: item) ?? .zero }
  }
  override func accessibilityLabel() -> String? {
    MainActor.assumeIsolated { [canvas, item] in canvas?.spokenName(of: item) }
  }
  override func accessibilityRoleDescription() -> String? {
    switch item {
    case .item(.section): "Section"
    case .item(.arrow): "label"
    case .item(.sticker): "sticker"
    case .item(.card): "card"
    case .sidenote: "sidenote"
    }
  }
}

extension CanvasView {
  public override func isAccessibilityElement() -> Bool { true }
  public override func accessibilityRole() -> NSAccessibility.Role? { .group }
  public override func accessibilityLabel() -> String? { shown?.board.title ?? "Board" }

  public override func accessibilityChildren() -> [Any]? {
    guard let s = scene else { return chromeElements() }
    var want: [BoardThing] = s.frames.map { .item(.section($0.id)) }
    for it in s.items { if case .card(let id)? = it.owner { want.append(.item(.card(id))) } }
    // an arrow's label, when it has one: under the arrow's id
    for it in s.items {
      if case .arrowLabel(let id)? = it.owner, document?.board.arrow(id)?.label?.isEmpty == false {
        want.append(.item(.arrow(id)))
      }
    }
    for (i, m) in marks.enumerated() where i < markLayers.count && drawn(markLayers[i]) {
      want += m.notes.map(BoardThing.sidenote)
    }
    for (i, k) in stickerSpots.enumerated() where i < stickerLayers.count && drawn(stickerLayers[i]) {
      want.append(.item(.sticker(k.id)))
    }
    var kept: [BoardThing: BoardElement] = [:]
    let out: [Any] = want.map { i in
      let e = axElements[i] ?? BoardElement(i, in: self)
      kept[i] = e
      return e
    }
    axElements = kept
    return out + footElements() + chromeElements()
  }

  /// The toolbar's and the dock's parts
  func chromeElements() -> [Any] {
    var out: [Any] = dock.isHidden ? [] : [dock]
    guard !alignBar.isHidden, let bar = alignBarFrame() else { return out }
    out.append(uiElement("alignbar", bar, in: self))
    let names: [AlignBarButton: String] = [
      .section: "newsection", .subBoard: "subboard", .tidy: "tidyup", .more: "alignmore",
    ]
    for (b, r) in AlignBarLayout.bar(AlignBarLayout.font(theme)).buttons {
      out.append(uiElement(names[b]!, r.offsetBy(dx: bar.minX, dy: bar.minY), label: names[b], in: self))
    }
    guard alignMore else { return out }
    let m = alignMoreFrame(bar)
    for (b, r) in AlignBarLayout.more(AlignBarLayout.titleFont(theme)).buttons {
      guard case .align(let op) = b else { continue }
      out.append(uiElement("align\(op)", r.offsetBy(dx: m.minX, dy: m.minY), label: "\(op)", in: self))
    }
    return out
  }

  /// Whether a marker's or sticker's layer shows: none of its layers hidden, and one on a card (or a Section's title)
  /// level with its shown part (not on lines scrolled or cut off below it)
  private func drawn(_ l: CALayer) -> Bool {
    var at: CALayer? = l
    while let x = at {
      if x.isHidden { return false }
      at = x.superlayer
    }
    guard let box = l.superlayer, box !== freeMarks, box !== freeStickers else { return true }
    return l.frame.maxY > 0 && l.frame.minY < box.bounds.height
  }

  /// Where an item is drawn now, on the screen
  func screenFrame(of item: BoardThing) -> NSRect {
    guard let window, let root = layer, let l = drawnLayer(item) else { return .zero }
    // an animation under way (a frame easing, a card springing back): where it is in it; else where it was just put,
    // which the presentation shows only once the transaction is in
    let r: CGRect
    if l.animationKeys() == ["lift"], let p = l.presentation(), let up = l.superlayer {
      // picked up or landing: where it was just put, at the size it has grown to now
      let b = l.bounds
      let at = CGRect(x: -b.width * l.anchorPoint.x, y: -b.height * l.anchorPoint.y, width: b.width, height: b.height)
        .applying(CATransform3DGetAffineTransform(p.transform)).offsetBy(dx: l.position.x, dy: l.position.y)
      r = up.convert(at, to: root)
    } else if l.animationKeys()?.isEmpty == false, let p = l.presentation(), let q = root.presentation() {
      r = p.convert(p.bounds, to: q)
    } else {
      r = l.convert(l.bounds, to: root)
    }
    return window.convertToScreen(convert(r, to: nil))
  }

  private func drawnLayer(_ item: BoardThing) -> CALayer? {
    switch item {
    case .item(.card(let id)): return index(of: .card(id)).map { items[$0].box }
    case .item(.arrow(let id)): return index(of: .arrowLabel(id)).map { items[$0].box }
    case .item(.section(let id)):
      guard let i = scene?.frames.firstIndex(where: { $0.id == id }), let ls = sections.sublayers, i < ls.count
      else { return nil }
      return ls[i]
    case .item(.sticker(let id)):
      guard let i = stickerSpots.firstIndex(where: { $0.id == id }), i < stickerLayers.count else { return nil }
      return stickerLayers[i]
    case .sidenote(let id):
      guard let i = marks.firstIndex(where: { $0.notes.contains(id) }), i < markLayers.count else { return nil }
      return markLayers[i]
    }
  }

  func spokenName(of item: BoardThing) -> String? {
    guard let b = document?.board else { return nil }
    switch item {
    case .item(.section(let id)): return b.section(id)?.title
    case .item(.arrow(let id)): return b.arrow(id)?.label
    case .item(.card(let id)):
      guard let c = b.card(id) else { return nil }
      if case .own(let k) = c.content, let t = k.title { return t }
      return c.writing?.split(separator: "\n").first.map(String.init)
    case .item(.sticker(let id)):
      return b.stickers.first { $0.id == id }.map { Sticker.label($0.glyph) }
    case .sidenote(let id):
      guard case .text(let t)? = b.sidenotes.first(where: { $0.id == id })?.body else { return "sidenote" }
      return t.text.split(separator: "\n").first.map(String.init)
    }
  }
}
