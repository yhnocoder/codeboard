import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardModel

// A code, Free code or image card's description written in place (Card.tsx Desc: Editable md, menus.ts Add / Edit
// Description): the Markdown component's editor over the description's place, on the card's paper, its text in the
// description's look (.cdesc). Esc, ⌘↵ or a press anywhere else writes it as one step ("Edit Description"; blank: none)
// and the card lays out again with it. While it is written it grows down over what is under it.

/// The description being written: its card and the editor on its paper
@MainActor final class DescWriting: MarkdownEditorDelegate {
  let id: CardID
  let was: String
  /// the paper the editor stands on, as wide as the card, in the canvas's host
  let paper = Paper()

  final class Paper: NSView {
    override var isFlipped: Bool { true }
  }
  let editor: MarkdownEditorView
  let padding: [CGFloat]
  weak var canvas: CanvasView?

  init(id: CardID, was: String, editor: MarkdownEditorView, padding: [CGFloat], canvas: CanvasView) {
    self.id = id
    self.was = was
    self.editor = editor
    self.padding = padding
    self.canvas = canvas
  }

  func editor(_ e: MarkdownEditorView, didChange source: String) { canvas?.placeDesc() }
  func editor(_ e: MarkdownEditorView, didResize size: CGSize) { canvas?.placeDesc() }
  func editorWantsToEnd(_ e: MarkdownEditorView) { canvas?.endDesc() }
  func editorDidBegin(_ e: MarkdownEditorView) {}
}

extension CanvasView {
  /// Where a card's description goes, from its top: under a code card's header, under an image's picture
  private func descTop(_ id: CardID) -> CGFloat? {
    guard let i = index(of: .card(id)), let s = scene else { return nil }
    switch s.items[i].drawing {
    case .code(let c) where c.framed: return theme.headerHeight
    case .image(let p): return s.items[i].rect.height - (p.desc?.height ?? 0)
    default: return nil
    }
  }

  /// Whether a card has a description to write: a framed code card's (Free code's too) or an image's, of its own
  func writesDescription(_ id: CardID) -> Bool {
    guard let doc = document, case .own? = doc.board.card(id)?.content, !doc.board.isLocked(.card(id)) else {
      return false
    }
    return descTop(id) != nil
  }

  /// Add / Edit Description: the card's description in the editor, the caret at its end
  func editDescription(_ id: CardID) {
    guard descWriting == nil, writesDescription(id), let doc = document, let host = superview,
      case .own(let k)? = doc.board.card(id)?.content, let card = doc.board.card(id)
    else { return }
    let text = k.description ?? ""
    let look = MarkdownLooks.card(.desc, look: theme.id.rawValue, dark: theme.dark)
    let folder = shown.map { $0.1.url(of: $0.0.path) } ?? URL(filePath: NSTemporaryDirectory())
    let resources = NativeNotes.Resources(
      folder: folder, pictures: folder, refs: [], math: try? MarkdownAssets.engines(), dark: theme.dark)
    let l = BlockLayout(
      MarkdownDocument(text), width: max(1, card.width - look.padding[1] - look.padding[3]), theme: look.theme,
      layout: nil, resources: resources)
    let v = MarkdownEditorView(layout: l, caret: (text as NSString).length)
    let d = DescWriting(id: id, was: text, editor: v, padding: look.padding, canvas: self)
    v.delegate = d
    d.paper.wantsLayer = true
    d.paper.layer?.backgroundColor = theme.surface
    d.paper.addSubview(v)
    host.addSubview(d.paper, positioned: .above, relativeTo: self)
    descWriting = d
    if doc.selection != [.card(id)] { doc.select([.card(id)]) }
    placeDesc()
    window?.makeFirstResponder(v)
  }

  /// The editor's paper over the description's place, at the camera's zoom, as tall as what it holds (never less than
  /// the description it covers)
  func placeDesc() {
    guard let d = descWriting, let i = index(of: .card(d.id)), let top = descTop(d.id), let host = d.paper.superview
    else { return }
    let r = scene!.items[i].rect
    let z = camera.zoom
    if d.editor.zoom != z { d.editor.zoom = z }
    let shownH: CGFloat =
      switch scene!.items[i].drawing {
      case .code(let c): c.desc?.height ?? 0
      case .image(let p): p.desc?.height ?? 0
      default: 0
      }
    let h = max(shownH, d.padding[0] + d.editor.frame.height / z + d.padding[2] + 1)
    let o = camera.view(CGPoint(x: r.minX, y: r.minY + top))
    withoutAnimation {
      d.paper.frame = convert(CGRect(x: o.x, y: o.y, width: r.width * z, height: h * z), to: host)
      d.editor.setFrameOrigin(CGPoint(x: d.padding[3] * z, y: d.padding[0] * z))
    }
  }

  /// Writes what the editor holds as one step and lets it go
  func endDesc() {
    guard let d = descWriting else { return }
    descWriting = nil
    let text = d.editor.source
    let keys = window?.firstResponder === d.editor
    d.paper.removeFromSuperview()
    if keys { window?.makeFirstResponder(self) }
    guard text.trimmingCharacters(in: .whitespacesAndNewlines) != d.was else { return }
    document?.edit("Edit Description") { $0.setDescription(d.id, text) }
  }
}
