import AppKit
import CodeBoardModel
import CodeBoardNotes
import UniformTypeIdentifiers

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
    addLinks(urls.filter { seen.insert($0).inserted }, at: p, "Paste")
    return true
  }

  /// One address: a Web card (newWeb, by addCards); more: a Link List (newLinkList), from the middle of the view when
  /// nowhere was given
  private func addLinks(_ urls: [String], at p: CGPoint?, _ step: String) {
    guard let first = urls.first else { return }
    let id = CardID(rawValue: Board.newID("card-"))
    if urls.count == 1 {
      let size = CGSize(width: Board.webWidth, height: 112)
      let at = pastePlace(size, at: p, besideSelection: true)
      settle(id, size, step, reveal: true) { $0.addWeb(id, url: first, x: at.x, y: at.y) }
      fetchWeb(id, url: first)
    } else {
      let items = urls.map { LinkList.Item(id: Board.newID("li"), url: $0) }
      let size = CGSize(width: Board.linksWidth, height: 52 + Double(items.count) * 30)
      let at = pastePlace(size, at: p, besideSelection: false)
      settle(id, size, step) {
        $0.cards.append(
          Card(
            id: id, x: at.x, y: at.y, width: Board.linksWidth,
            content: .own(CardContent(body: .links(LinkList(items: items))))))
      }
      for it in items { fetchWeb(id, item: it.id, url: it.url) }
    }
  }

  /// Where text just copied from a card goes when pasted again (clipboard.ts pasteNear): down and right of that card,
  /// 36 further with each paste, over whatever is there; nil for any other text, or once the card is not on this board
  func pasteNear(_ text: String) -> CGPoint? {
    let trim = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard let c = lastCopy, trim(c.text) == trim(text), let r = liveRect(.card(c.card)) else { return nil }
    lastCopy?.n += 1
    let k = 36 * CGFloat(c.n + 1)
    return CGPoint(x: r.minX + k, y: r.minY + k)
  }

  /// Any other text: what it is read as, then its card; `p` the board menu's point, else the pointer's (⌘V), else none;
  /// `exact`: code goes at `p` itself, not the nearest free place from it (addCards exact)
  func pasteText(at p: CGPoint?, exact: Bool = false) -> Bool {
    guard let s = pasteboard.string(forType: .string), !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return false }
    let at = p
    // the board it was pasted on, though another be shown by the time it is read: the document, as the canvas gives its
    // seat up then
    weak let doc = document?.document
    Task { [weak self] in
      let kind = (try? await self?.notes.paste(s)) ?? .note(s)
      guard let self, document?.document === doc else { return }
      pasted(kind, at: at, exact: exact)
    }
    return true
  }

  private func pasted(_ kind: PastedText, at p: CGPoint?, exact: Bool) {
    switch kind {
    case .note(let md):
      // newWriting: its top left where asked, else 40 above the middle of the view
      let v = camera.visible(bounds.size)
      let at = p ?? CGPoint(x: v.midX - Board.newNoteWidth / 2, y: v.midY - 40)
      let id = CardID(rawValue: Board.newID("card-"))
      var card = Board.newCard(.note, id: id, x: at.x.rounded(), y: at.y.rounded())
      card.content = .own(CardContent(body: .note(Note(text: md))))
      settle(id, CGSize(width: Board.newNoteWidth, height: 160), "Paste") { $0.cards.append(card) }
    case .web(let u): addLinks([u], at: p, "Paste")
    case .links(let us): addLinks(us, at: p, "Paste")
    case .code(let text, let language):
      // newFreeCode: a Note's width, as tall as its lines up to 520
      let lines = text.components(separatedBy: "\n")
      let size = CGSize(width: Board.newNoteWidth, height: min(520, 52 + Double(lines.count) * 19))
      var at = pastePlace(size, at: p, besideSelection: true)
      if exact, let p { at = CGPoint(x: p.x.rounded(), y: p.y.rounded()) }
      let id = CardID(rawValue: Board.newID("card-"))
      let seg = Segment(
        id: SegmentID(rawValue: Board.newID("s")), source: nil, language: language, firstLine: 1, lines: lines)
      settle(id, size, "Paste", reveal: true) {
        $0.cards.append(
          Card(
            id: id, x: at.x, y: at.y, width: Board.newNoteWidth,
            content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))))
      }
    case .svg(let url, let natural):
      // addImage: as wide as it is, 24 to a Note's width
      addImage(url, width: max(24, min(Board.newNoteWidth, (natural > 0 ? natural : 320).rounded())), at: p, "Paste")
    case .none(let why):
      if let why { toast(why) }
    }
  }

  /// addImage: the cleaned picture in the board's images, an image card `width` wide where a pasted card goes; where
  /// it went
  @discardableResult
  private func addImage(_ dataURL: String, width w: CGFloat, at p: CGPoint?, _ step: String) -> CGRect? {
    guard let (board, vault) = shown,
      let address = try? NoteImages.store(dataURL: dataURL, in: vault.url(of: board.path))
    else {
      toast("Could not add the image")
      return nil
    }
    let name = String(address.dropFirst(Vault.imagesFolder.count + 1))
    let size = CGSize(width: w, height: 160)
    let at = pastePlace(size, at: p, besideSelection: true)
    let id = CardID(rawValue: Board.newID("card-"))
    settle(id, size, step, reveal: true) {
      $0.cards.append(
        Card(
          id: id, x: at.x, y: at.y, width: w, content: .own(CardContent(body: .image(ImageCard(source: .file(name)))))))
    }
    return CGRect(origin: at, size: size)
  }

  /// A picture file's bytes added as main's addImage adds them (an SVG cleaned, as wide as it shows: a PNG's
  /// resolution, else `scale`), at `p`; where it went, nil when it was not added (said in a toast)
  @discardableResult
  func addPicture(_ data: Data, named name: String, scale: Double = 1, at p: CGPoint?, _ step: String) async -> CGRect?
  {
    let doc = document
    guard let (ext, _) = NoteImages.kind(of: data), let mime = UTType(filenameExtension: ext)?.preferredMIMEType else {
      toast("\(name) is not a PNG, JPEG, WebP, GIF or SVG image.")
      return nil
    }
    let made: (dataURL: String, width: Double)?
    do {
      made = try await notes.image("data:\(mime);base64,\(data.base64EncodedString())", scale: scale)
    } catch {
      toast("Could not add the image")
      return nil
    }
    guard document === doc else { return nil }
    guard let made else {
      toast("This SVG image could not be read")
      return nil
    }
    return addImage(made.dataURL, width: made.width, at: p, step)
  }

  /// A picture on the pasteboard (interact.ts paste: a picture before text that is no copied card; addImage): picture
  /// files copied in Finder as when dropped, else the picture as an image card at `p`, as wide as it shows: a PNG's
  /// resolution, else 1 for one copied from a page (it comes with HTML), the window's scale for a screenshot. False
  /// when there is none
  func pastePicture(at p: CGPoint?) -> Bool {
    let files = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
    if let files, !files.isEmpty {
      let v = camera.visible(bounds.size)
      addPictureFiles(files, at: p ?? CGPoint(x: v.midX, y: v.midY))
      return true
    }
    guard
      let data = pasteboard.data(forType: .png)
        ?? pasteboard.data(forType: .tiff).flatMap({
          NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:])
        })
    else { return false }
    let scale = pasteboard.types?.contains(.html) == true ? 1 : Double(window?.backingScaleFactor ?? 1)
    Task { await addPicture(data, named: "pasted.png", scale: scale, at: p, "Paste") }
    return true
  }

  /// Files dropped or pasted on the board (create.ts dropFiles): each picture an image card, in a row from `p` in their
  /// order; any other file said in a toast and left out
  func addPictureFiles(_ urls: [URL], at p: CGPoint) {
    let pictures = Set(["png", "jpg", "jpeg", "gif", "webp", "svg"])
    let others = urls.filter { !pictures.contains($0.pathExtension.lowercased()) }.map(\.lastPathComponent)
    if let first = others.first {
      toast(
        "\(others.count > 1 ? "\(first) and \(others.count - 1) more aren't images" : "\(first) isn't an image"): only PNG, JPEG, GIF, WebP and SVG files can be dropped on the board"
      )
    }
    let files = urls.filter { pictures.contains($0.pathExtension.lowercased()) }
    Task {
      var x = p.x
      for f in files {
        guard let data = try? Data(contentsOf: f) else {
          toast("Could not add \(f.lastPathComponent)")
          continue
        }
        if let r = await addPicture(data, named: f.lastPathComponent, at: CGPoint(x: x, y: p.y), "Add Image") {
          x = r.maxX + Self.pasteGap
        }
      }
    }
  }

  /// The toolbar's Image (create.ts newImage, host handlers.ts pickImage): a picture file chosen in the open panel
  /// added as an image card, as wide as the picture shows, where a pasted card goes
  public func newImage() {
    guard let window else { return }
    let doc = document
    Task { [weak self] in
      guard let url = await self?.pickImage(window), let self, document === doc else { return }
      guard let data = try? Data(contentsOf: url) else {
        return toast("\(url.lastPathComponent) is not a PNG, JPEG, WebP, GIF or SVG image.")
      }
      await addPicture(data, named: url.lastPathComponent, at: nil, "New Image")
    }
  }

  /// The toolbar's Web (create.ts newWeb): its address asked in a sheet as main's promptText asks it, https:// put
  /// before one without; a Web card where a pasted one goes, its page read
  public func newWeb() {
    guard let window else { return }
    let alert = NSAlert()
    alert.messageText = "Add Web Link"
    let field = NSTextField(frame: CGRect(x: 0, y: 0, width: 280, height: 22))
    field.placeholderString = "https://…"
    alert.accessoryView = field
    alert.addButton(withTitle: "Add")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = field
    let doc = document
    alert.beginSheetModal(for: window) { [weak self] r in
      MainActor.assumeIsolated {
        var url = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let self, r == .alertFirstButtonReturn, !url.isEmpty, self.document === doc else { return }
        if !url.hasPrefix("http://") && !url.hasPrefix("https://") { url = "https://" + url }
        self.addLinks([url], at: nil, "New Web Card")
      }
    }
  }

  static func askImageFile(_ window: NSWindow) async -> URL? {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.png, .jpeg, .webP, .gif, .svg]
    panel.prompt = "Add Image"
    return await panel.beginSheetModal(for: window) == .OK ? panel.url : nil
  }

  /// A new card added in one step and selected, in the Section its rect (`size` at where it is put) covers by more than
  /// a third (settleHome); `reveal`: brought into view when it is not, as main's addCards does (a new Note, Text, Box or
  /// Link List is not: newWriting, newLinkList)
  func settle(
    _ id: CardID, _ size: CGSize, _ name: String, reveal: Bool = false, keepSection: Bool = false,
    _ add: (inout Board) -> Void
  ) {
    settle([(id, size)], name, reveal: reveal, keepSection: keepSection, add)
  }

  /// Several new cards so, in the one step, all of them selected (several rows of a list dropped at once).
  /// `keepSection`: a card `add` put in a Section stays in it (a call's card goes in its caller's)
  func settle(
    _ cards: [(id: CardID, size: CGSize)], _ name: String, reveal: Bool = false, keepSection: Bool = false,
    _ add: (inout Board) -> Void
  ) {
    guard let doc = document else { return }
    let frames = Dictionary((scene?.frames ?? []).map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a })
    doc.edit(name, selection: Set(cards.map { Item.card($0.id) })) { b in
      add(&b)
      for (id, size) in cards {
        guard let i = b.cards.firstIndex(where: { $0.id == id }), !keepSection || b.cards[i].section == nil
        else { continue }
        let r = CGRect(x: b.cards[i].x, y: b.cards[i].y, width: size.width, height: size.height)
        b.cards[i].section = home(of: r, frames: frames)
      }
    }
    let rects = cards.compactMap { id, size in
      doc.board.card(id).map { CGRect(x: $0.x, y: $0.y, width: size.width, height: size.height) }
    }
    if reveal, let first = rects.first { self.reveal(rects.dropFirst().reduce(first) { $0.union($1) }) }
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
