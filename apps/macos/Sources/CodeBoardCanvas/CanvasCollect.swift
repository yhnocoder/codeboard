import AppKit
import CodeBoardModel
import CodeBoardNotes
import TreeSitterHighlight

// What a reading pane collects onto the board (Collected): selected text as an ordinary Note with its source, a figure
// or a table as an image card showing that block of the entry, a web page's picture as an image card of its own. Its
// Add to Board and ⌥↵ (`collect`) put it in a free place of the view; dragged over the board, the card as it will be is
// in hand, centred on the pointer as a sticker being placed is, and let go it lands there. Either way it is selected,
// one step, in the Section it lands in.

/// A collected card in hand while its drag is over the board: laid out and drawn once, then only moved
struct InHand {
  var drag: Int
  var collected: Collected
  /// The pointer's board point: the card's middle
  var at: CGPoint
  /// Its size and layers once laid out
  var size: CGSize?
  var layers: CanvasView.ItemLayers?
}

extension CanvasView {
  static let collectedType = NSPasteboard.PasteboardType(Collected.pasteboardType)

  /// Collected from a reading pane: its card in a free place of the view, selected. False when it cannot be a card (an
  /// image with no source to draw it from, a data: picture that is no picture kept)
  @discardableResult public func collect(_ c: Collected) -> Bool {
    guard document != nil, let size = collectedSize(c) else { return false }
    return add(c, at: pastePlace(size, at: nil, besideSelection: false), size: size, reveal: true)
  }

  /// The card collected, its top left at `p`: a Note as wide as a new one, or an image card at the block's width
  func collectedCard(_ c: Collected, id: CardID, at p: CGPoint) -> Card? {
    switch c.body {
    case .note(let md):
      return Card(
        id: id, x: p.x, y: p.y, width: Board.newNoteWidth,
        content: .own(CardContent(source: c.source, body: .note(Note(text: md)))))
    case .image(let alt, let w, _):
      // its source is the block it shows (FORMAT.md: never both)
      guard let a = c.source else { return nil }
      return Card(
        id: id, x: p.x, y: p.y, width: w.rounded(),
        content: .own(CardContent(body: .image(ImageCard(source: .resource(a), alt: alt)))))
    case .picture(let url, let alt, let w, _):
      // a web page's picture: read from its address as a pasted address is, or a data: one kept in the board's images
      // as a pasted picture is (an SVG is refused: a paste has it cleaned first); its source the entry the page is
      guard let picture = collectedPicture(url) else { return nil }
      return Card(
        id: id, x: p.x, y: p.y, width: Self.pictureWidth(w),
        content: .own(CardContent(source: c.source, body: .image(ImageCard(source: picture, alt: alt)))))
    }
  }

  /// A web picture's card as wide as a pasted picture's (addImage, the Note page's `added`): its width, 24 to a Note's
  private static func pictureWidth(_ w: Double) -> Double { max(24, min(Board.newNoteWidth, w.rounded())) }

  /// An http(s) address as it is, a data: picture's bytes in the board's images by their content (already when its card
  /// is first in hand); nil for anything else
  private func collectedPicture(_ url: String) -> ImageSource? {
    if webAddress(url) == url { return .url(url) }
    guard url.hasPrefix("data:"), let comma = url.firstIndex(of: ","), url[..<comma].hasSuffix(";base64"),
      let data = Data(base64Encoded: String(url[url.index(after: comma)...])),
      NoteImages.kind(of: data)?.0 != "svg", let (board, vault) = shown,
      let address = try? NoteImages.store(data, in: vault.url(of: board.path))
    else { return nil }
    return .file(String(address.dropFirst(Vault.imagesFolder.count + 1)))
  }

  /// How big its card is before it is laid out: an image's natural size, a Note as tall as a pasted one is taken to be
  func collectedSize(_ c: Collected) -> CGSize? {
    switch c.body {
    case .note: CGSize(width: Board.newNoteWidth, height: 160)
    case .image(_, let w, let h): c.source == nil ? nil : CGSize(width: w.rounded(), height: h)
    case .picture(_, _, let w, let h):
      w > 0 && h > 0 ? CGSize(width: Self.pictureWidth(w), height: Self.pictureWidth(w) * h / w) : nil
    }
  }

  /// `reveal`: brought into view when it is not (a card let go where the pointer is: the camera stays)
  @discardableResult private func add(_ c: Collected, at p: CGPoint, size: CGSize, reveal: Bool = false) -> Bool {
    let id = CardID(rawValue: Board.newID("card-"))
    guard let card = collectedCard(c, id: id, at: p) else {
      // only a picture whose data: address is refused: as a refused paste is
      toast("Could not add the image")
      return false
    }
    settle(id, size, "Add to Board", reveal: reveal) { $0.cards.append(card) }
    return true
  }

  // MARK: Dragging

  /// A collected card dragged over the board: in hand at the pointer, laid out the first time it comes over; nil for any
  /// other drag, none for one that cannot be a card
  func holdCollected(_ info: NSDraggingInfo) -> NSDragOperation? {
    let at = camera.board(convert(info.draggingLocation, from: nil))
    if var h = inHand, h.drag == info.draggingSequenceNumber {
      h.at = at
      inHand = h
      placeHand()
      return .copy
    }
    guard let data = info.draggingPasteboard.data(forType: Self.collectedType) else { return nil }
    guard document != nil, let c = try? Collected(data: data), collectedSize(c) != nil else { return [] }
    dropHand()
    inHand = InHand(drag: info.draggingSequenceNumber, collected: c, at: at)
    // the card in hand is the picture: the drag's own is not drawn over the board (AppKit gives it back off the board)
    info.enumerateDraggingItems(
      options: [], for: self, classes: [NSPasteboardItem.self], searchOptions: [:]
    ) { item, _, _ in item.imageComponentsProvider = { [] } }
    layOutHand(c, drag: info.draggingSequenceNumber)
    return .copy
  }

  /// Let go over the board: its card where the one in hand was, selected, the board taking the keys. Nil for any other
  /// drag
  func dropCollected(_ info: NSDraggingInfo) -> Bool? {
    guard info.draggingPasteboard.types?.contains(Self.collectedType) == true else { return nil }
    let h = inHand?.drag == info.draggingSequenceNumber ? inHand : nil
    dropHand()
    let data = info.draggingPasteboard.data(forType: Self.collectedType)
    guard document != nil, let c = h?.collected ?? data.flatMap({ try? Collected(data: $0) }),
      let size = h?.size ?? collectedSize(c)
    else { return false }
    let p = camera.board(convert(info.draggingLocation, from: nil))
    guard add(c, at: CGPoint(x: (p.x - size.width / 2).rounded(), y: (p.y - size.height / 2).rounded()), size: size)
    else { return false }
    window?.makeFirstResponder(self)
    return true
  }

  /// Off the board, the drag over or cancelled: nothing in hand
  func dropHand() {
    guard let h = inHand else { return }
    inHand = nil
    withoutAnimation { h.layers?.box.removeFromSuperlayer() }
  }

  private func placeHand() {
    guard let h = inHand, let l = h.layers else { return }
    withoutAnimation { l.box.position = h.at }
  }

  /// The card in hand laid out alone and drawn as the board draws it, at the zoom now, once (an image's block asked of
  /// the provider first, and kept for the card it becomes)
  private func layOutHand(_ c: Collected, drag: Int) {
    guard let (vb, vault) = shown, let doc = document,
      let card = collectedCard(c, id: CardID(rawValue: "in-hand"), at: .zero)
    else { return }
    let mini = Board(id: doc.board.id, cards: [card])
    let (t, display, images, zoom, backing) = (theme, display, images, camera.zoom, backing)
    let highlighter = CanvasView.highlighter ?? Highlighter()
    let package = vault.url(of: vb.path)
    Task { [weak self] in
      if case .image(_, let w, let h) = c.body, let a = c.source, let p = self?.sources {
        let k = Levels.scale(zoom, backing: backing, size: CGSize(width: w, height: h))
        let key = SourcePictures.Key(anchor: Scene.key(a), width: SourcePictures.level(Int((w * k).rounded(.up))))
        if self?.sourcePictures.holds(key) == false, let img = await p.blockImage(a, pixelWidth: key.width) {
          self?.sourcePictures.put(key, img)
        }
      }
      guard let self, inHand?.drag == drag else { return }
      let sources = sourceInfo(mini)
      let made = await Task.detached(priority: .userInitiated) { () -> (Scene.Item, IOSurface?, CGFloat)? in
        let sizes = await CanvasView.measure(
          Scene.measures(mini, package: package, vault: vault, sources: sources), theme: t, display: display)
        let s = Scene(
          mini, package: package, vault: vault, theme: t, highlighter: highlighter, sizes: sizes, sources: sources)
        guard let it = s.items.first(where: { $0.owner == .card(card.id) }) else { return nil }
        let k = Levels.scale(zoom, backing: backing, size: it.bitmapSize)
        let surface =
          it.drawing.byRenderer
          ? await CanvasView.drawNote(it, scale: k, theme: t, images: images, display: display, priority: 1).surface
          : CanvasView.render(it, scale: k, theme: t, images: images).surface
        return (it, surface, k)
      }.value
      guard let made, var h = inHand, h.drag == drag else { return }
      let l = ItemLayers(made.0, overview: (made.1, made.2, .drawn), shadow: made.0.drawing.framed ? cardShadow : nil)
      h.size = made.0.rect.size
      h.layers = l
      inHand = h
      // where a Shelf entry dragged out is outlined: over everything on the board, in its units under the camera
      withoutAnimation { shelfDrag.addSublayer(l.box) }
      placeHand()
    }
  }

  public override func draggingExited(_ info: NSDraggingInfo?) { dropHand() }

  public override func draggingEnded(_ info: NSDraggingInfo) { dropHand() }
}
