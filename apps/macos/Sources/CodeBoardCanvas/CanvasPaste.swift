import AppKit
import CodeBoardModel
import CodeBoardNotes

// Text pasted on the board (board actions/create.ts pasteText, addCards, newWriting, newWeb, newFreeCode, addImage;
// web.ts newLinkList; core layout.ts findFree, besideFree, estSize; state/sections.ts settleHome): web addresses are
// known at once; any other text is read by the Markdown package and core's paste rules in the Note page, and becomes a
// Note, an image (an SVG) or Free code. Every pasted card is selected, one step, in the Section it lands in.

extension CanvasView {
  // MARK: Pasting

  /// A link alone (or several, one per line) pasted: a Web card (a Link List), its page read now. False when the
  /// pasteboard holds no link
  func pasteLinks(at p: CGPoint?) -> Bool {
    guard let s = pasteboard.string(forType: .string) else { return false }
    let lines = s.split(whereSeparator: \.isNewline).map(String.init).filter {
      !$0.trimmingCharacters(in: .whitespaces).isEmpty
    }
    let urls = lines.compactMap(webAddress)
    guard !urls.isEmpty, urls.count == lines.count else { return false }
    var seen = Set<String>()
    addLinks(urls.filter { seen.insert($0).inserted }, at: p)
    return true
  }

  /// One address: a Web card (newWeb, by addCards); more: a Link List (newLinkList), from the middle of the view when
  /// nowhere was given
  private func addLinks(_ urls: [String], at p: CGPoint?) {
    guard let first = urls.first else { return }
    let id = CardID(rawValue: Board.newID("card-"))
    if urls.count == 1 {
      let size = CGSize(width: Board.webWidth, height: 112)
      let at = pastePlace(size, at: p, besideSelection: true)
      settle(id, size, "Paste") { $0.addWeb(id, url: first, x: at.x, y: at.y) }
      fetchWeb(id, url: first)
    } else {
      let items = urls.map { LinkList.Item(id: Board.newID("li"), url: $0) }
      let size = CGSize(width: Board.linksWidth, height: 52 + Double(items.count) * 30)
      let at = pastePlace(size, at: p, besideSelection: false)
      settle(id, size, "Paste") {
        $0.cards.append(
          Card(
            id: id, x: at.x, y: at.y, width: Board.linksWidth,
            content: .own(CardContent(body: .links(LinkList(items: items))))))
      }
      for it in items { fetchWeb(id, item: it.id, url: it.url) }
    }
  }

  /// Any other text: what it is read as, then its card; `p` the board menu's point, else the pointer's (⌘V), else none
  func pasteText(at p: CGPoint?) -> Bool {
    guard let s = pasteboard.string(forType: .string), !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return false }
    let at = p
    let doc = document
    Task { [weak self, weak doc] in
      let kind = (try? await self?.notes.paste(s)) ?? .note(s)
      guard let self, document === doc else { return }
      pasted(kind, at: at)
    }
    return true
  }

  private func pasted(_ kind: PastedText, at p: CGPoint?) {
    switch kind {
    case .note(let md):
      // newWriting: its top left where asked, else 40 above the middle of the view
      let v = camera.visible(bounds.size)
      let at = p ?? CGPoint(x: v.midX - Board.newNoteWidth / 2, y: v.midY - 40)
      let id = CardID(rawValue: Board.newID("card-"))
      var card = Board.newCard(.note, id: id, x: at.x.rounded(), y: at.y.rounded())
      card.content = .own(CardContent(body: .note(Note(text: md))))
      settle(id, CGSize(width: Board.newNoteWidth, height: 160), "Paste") { $0.cards.append(card) }
    case .web(let u): addLinks([u], at: p)
    case .links(let us): addLinks(us, at: p)
    case .code(let text, let language):
      // newFreeCode: a Note's width, as tall as its lines up to 520
      let lines = text.components(separatedBy: "\n")
      let size = CGSize(width: Board.newNoteWidth, height: min(520, 52 + Double(lines.count) * 19))
      let at = pastePlace(size, at: p, besideSelection: true)
      let id = CardID(rawValue: Board.newID("card-"))
      let seg = Segment(
        id: SegmentID(rawValue: Board.newID("s")), source: nil, language: language, firstLine: 1, lines: lines)
      settle(id, size, "Paste") {
        $0.cards.append(
          Card(
            id: id, x: at.x, y: at.y, width: Board.newNoteWidth,
            content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))))
      }
    case .svg(let url, let natural):
      // addImage: the cleaned file in the board's images, as wide as it is (24 to a Note's width)
      guard let (board, vault) = shown,
        let address = try? NoteEditor.store(dataURL: url, in: vault.url(of: board.path))
      else { return toast("Could not add the image") }
      let name = String(address.dropFirst(Vault.imagesFolder.count + 1))
      let w = max(24, min(Board.newNoteWidth, (natural > 0 ? natural : 320).rounded()))
      let size = CGSize(width: w, height: 160)
      let at = pastePlace(size, at: p, besideSelection: true)
      let id = CardID(rawValue: Board.newID("card-"))
      settle(id, size, "Paste") {
        $0.cards.append(
          Card(
            id: id, x: at.x, y: at.y, width: w, content: .own(CardContent(body: .image(ImageCard(source: .file(name)))))
          ))
      }
    case .none(let why):
      if let why { toast(why) }
    }
  }

  /// A new card added in one step and selected, in the Section its rect (`size` at where it is put) covers by more than
  /// a third (settleHome)
  func settle(_ id: CardID, _ size: CGSize, _ name: String, _ add: (inout Board) -> Void) {
    guard let doc = document else { return }
    let frames = Dictionary((scene?.frames ?? []).map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a })
    doc.edit(name, selection: [.card(id)]) { b in
      add(&b)
      guard let i = b.cards.firstIndex(where: { $0.id == id }) else { return }
      let r = CGRect(x: b.cards[i].x, y: b.cards[i].y, width: size.width, height: size.height)
      b.cards[i].section = home(of: r, frames: frames)
    }
  }

  /// Where a pasted card of `size` goes (addCards): from `p`, else beside the last card selected (right, then below),
  /// else from the middle of the view; the nearest place there free of the other cards
  func pastePlace(_ size: CGSize, at p: CGPoint?, besideSelection: Bool) -> CGPoint {
    let others = (scene?.items ?? []).compactMap { it -> CGRect? in
      if case .card? = it.owner { it.rect } else { nil }
    }
    let gap = Self.pasteGap
    func free(_ r: CGRect) -> Bool { !others.contains { $0.insetBy(dx: -gap, dy: -gap).intersects(r) } }
    func near(_ o: CGPoint) -> CGPoint {
      // findFree: down, then right, then both, then up and left, 40 further each round
      for k in 0..<60 {
        let d = CGFloat(k) * 40
        let tries =
          k == 0
          ? [o]
          : [
            CGPoint(x: o.x, y: o.y + d), CGPoint(x: o.x + d, y: o.y), CGPoint(x: o.x + d, y: o.y + d),
            CGPoint(x: o.x, y: o.y - d), CGPoint(x: o.x - d, y: o.y),
          ]
        if let t = tries.first(where: { free(CGRect(origin: $0, size: size)) }) { return t }
      }
      return CGPoint(x: o.x, y: o.y + 60 * 40)
    }
    let at: CGPoint
    if let p {
      at = near(p)
    } else if besideSelection, let last = document?.selection.compactMap(\.card).last,
      let i = index(of: .card(last)), let sel = scene?.items[i].rect
    {
      // besideFree: right of it, else below it, 56 apart, else from its right
      let right = CGPoint(x: sel.maxX + gap * 2, y: sel.minY)
      let below = CGPoint(x: sel.minX, y: sel.maxY + gap * 2)
      at =
        free(CGRect(origin: right, size: size))
        ? right : free(CGRect(origin: below, size: size)) ? below : near(right)
    } else {
      let v = camera.visible(bounds.size)
      at = near(CGPoint(x: v.midX - size.width / 2, y: v.midY - min(size.height, 300) / 2))
    }
    return CGPoint(x: at.x.rounded(), y: at.y.rounded())
  }

  /// Room kept between a pasted card and the others (layout.ts GAP)
  static let pasteGap: CGFloat = 28
}
