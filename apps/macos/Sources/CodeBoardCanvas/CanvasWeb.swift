import AppKit
import CodeBoardModel

// Web cards and Link Lists on the canvas (the web board's actions/web.ts, menus.ts webMenu / linksMenu / rowMenu): a
// link pasted makes a Web card (several lines of links, a Link List) whose page is read once, off the main thread, its
// pictures kept in the board's images so it shows offline; Refresh Preview reads it again. A double-click opens the
// page in the browser. Two or more of them merge into a Link List, whose rows are dragged to reorder (out of the card:
// taken out as a Web card), renamed, shown Rich or Compact, taken out and removed from their menu.

/// Which text of a Web card or Link List is written in place
enum WebText: Equatable {
  case title, description, listTitle
  case row(String)
}

/// A Link List's row dragged: to another place in the list, or out of the card
struct RowDrag {
  var card: CardID
  var item: String
  var label: String
  var start: CGPoint
  var moved = false
  /// Where it would go: before the row now at this index; nil: out of the card, as a Web card
  var to: Int?
  var at = CGPoint.zero
}

extension CanvasView {
  // MARK: Pasting

  /// A link alone (or several, one per line) pasted: a Web card (a Link List) in the middle of the view, selected, one
  /// step; its page is read now. False when the pasteboard holds no link
  func pasteLinks() -> Bool {
    guard let doc = document, let s = pasteboard.string(forType: .string) else { return false }
    let lines = s.split(whereSeparator: \.isNewline).map(String.init).filter {
      !$0.trimmingCharacters(in: .whitespaces).isEmpty
    }
    let urls = lines.compactMap(webAddress)
    guard !urls.isEmpty, urls.count == lines.count else { return false }
    var seen = Set<String>()
    let unique = urls.filter { seen.insert($0).inserted }
    let id = CardID(rawValue: Board.newID("card-"))
    let view = camera.visible(bounds.size)
    if unique.count == 1 {
      let x = (view.midX - Board.webWidth / 2).rounded()
      let y = (view.midY - 56).rounded()
      doc.edit("Paste", selection: [.card(id)]) { $0.addWeb(id, url: unique[0], x: x, y: y) }
      fetchWeb(id, url: unique[0])
    } else {
      let items = unique.map { LinkList.Item(id: Board.newID("li"), url: $0) }
      let x = (view.midX - Board.linksWidth / 2).rounded()
      let y = (view.midY - 26 - Double(items.count) * 15).rounded()
      doc.edit("Paste", selection: [.card(id)]) {
        $0.cards.append(
          Card(
            id: id, x: x, y: y, width: Board.linksWidth,
            content: .own(CardContent(body: .links(LinkList(items: items))))))
      }
      for it in items { fetchWeb(id, item: it.id, url: it.url) }
    }
    return true
  }

  // MARK: Reading a page

  /// The images folder of the board shown
  var imagesFolder: URL? { shown.map { $0.1.url(of: $0.0.path).appending(path: Vault.imagesFolder) } }

  /// Reads a card's page (a row's, by `item`), off the main thread, and puts what was read on the card, no step; its
  /// pictures go into the board's images. Shown "Fetching preview…" meanwhile
  package func fetchWeb(_ id: CardID, item: String? = nil, url: String) {
    guard let u = URL(string: url), let folder = imagesFolder else { return }
    let key = item.map { "\(id.rawValue)/\($0)" } ?? id.rawValue
    guard !webFetching.contains(key) else { return }
    webFetching.insert(key)
    if item == nil { refresh() }
    let fetch = fetchPage
    let task = Task { [weak self] in
      let page = await fetch(u)
      let meta = await Task.detached { CanvasView.store(page, in: folder) }.value
      guard let self else { return }
      webFetching.remove(key)
      document?.preview { $0.setWebMeta(id, item: item, url: url, meta) }
      if item == nil { refresh() }
    }
    webTasks[key] = task
  }

  /// What was read, its pictures written into the folder (by their bytes' hash: the same picture once)
  nonisolated static func store(_ p: WebPage, in folder: URL) -> WebMeta {
    func file(_ a: WebPage.Asset?) -> ImageSource? {
      guard let a else { return nil }
      let name = a.name
      let url = folder.appending(path: name)
      if !FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard (try? a.data.write(to: url)) != nil else { return nil }
      }
      return .file(name)
    }
    return WebMeta(
      title: p.title, description: p.description, site: p.site, image: file(p.image), icon: file(p.icon),
      fetchedAt: (Date().timeIntervalSince1970 * 1000).rounded(), failed: p.failed)
  }

  // MARK: What is where

  /// A card's Web drawing, its rect and its layout
  func webAt(_ id: CardID) -> (Drawing.Web, CGRect, WebLayout)? {
    guard let i = index(of: .card(id)), case .web(let w) = scene!.items[i].drawing else { return nil }
    let r = scene!.items[i].rect
    return (w, r, WebLayout.of(w.page, style: w.style, width: r.width, small: false, loading: w.loading, theme))
  }

  /// A Link List under a board point: its drawing, rect and layout
  func linksAt(_ id: CardID) -> (Drawing.Links, CGRect, LinksLayout)? {
    guard let i = index(of: .card(id)), case .links(let l) = scene!.items[i].drawing else { return nil }
    let r = scene!.items[i].rect
    return (l, r, LinksLayout.of(l, width: r.width, theme))
  }

  /// The row of a Link List under a board point
  func linkRow(at p: CGPoint) -> (card: CardID, index: Int, item: String)? {
    guard let c = hitCard(p), let (l, r, lay) = linksAt(c) else { return nil }
    let local = CGPoint(x: p.x - r.minX, y: p.y - r.minY)
    guard let i = lay.rows.firstIndex(where: { $0.rect.insetBy(dx: 0, dy: -0.5).contains(local) }), i < l.rows.count
    else { return nil }
    return (c, i, l.rows[i].id)
  }

  /// The page a double-click opens: a Web card's, a row's
  func pageURL(at p: CGPoint) -> URL? {
    if let row = linkRow(at: p), case .own(let c)? = document?.board.card(row.card)?.content,
      case .links(let l) = c.body, let it = l.items.first(where: { $0.id == row.item })
    {
      return URL(string: it.url)
    }
    if let id = hitCard(p), case .own(let c)? = document?.board.card(id)?.content, case .web(let w) = c.body {
      return URL(string: w.url)
    }
    return nil
  }

  /// A double-click on a Web card or a row: its page in the browser. False when it is on neither
  func openPage(at p: CGPoint) -> Bool {
    guard let u = pageURL(at: p) else { return false }
    openURL(u)
    return true
  }

  /// A click on what nothing read shows: Retry, or Edit Title. True when it was one of them
  func pressWebLink(at p: CGPoint) -> Bool {
    guard let id = hitCard(p), let (w, r, b) = webAt(id), b.shape == .none else { return false }
    let local = CGPoint(x: p.x - r.minX, y: p.y - r.minY)
    if let rr = b.retry, rr.contains(local) {
      refreshWeb(id)
      return true
    }
    if let e = b.edit, e.contains(local) {
      editWebText(id, .title)
      _ = w
      return true
    }
    return false
  }

  // MARK: Commands

  /// Refresh Preview, Retry: the page read again (what was read is overwritten)
  func refreshWeb(_ id: CardID) {
    guard case .own(let c)? = document?.board.card(id)?.content, case .web(let w) = c.body else { return }
    fetchWeb(id, url: w.url)
  }

  func setWebStyle(_ id: CardID, _ s: WebCard.Style) {
    document?.edit("View") { $0.setWebStyle(id, s) }
  }

  /// Merge into Link List: the selected Web cards and Link Lists, one step; the list selected
  func mergeSelected() {
    guard let doc = document else { return }
    let order = doc.selection.compactMap(\.card).sorted { a, b in
      (index(of: .card(a)) ?? 0) < (index(of: .card(b)) ?? 0)
    }
    var kept: CardID?
    doc.edit("Merge into Link List") { kept = $0.mergeLinks(order) }
    if let kept { doc.select([.card(kept)]) }
  }

  /// The selection is two or more Web cards and Link Lists only
  var mergeable: Bool {
    guard let doc = document else { return false }
    let ids = doc.selection.compactMap(\.card)
    return ids.count >= 2 && ids.count == doc.selection.count
      && ids.allSatisfy { id in
        guard case .own(let c)? = doc.board.card(id)?.content else { return false }
        switch c.body {
        case .web, .links: return true
        default: return false
        }
      }
  }

  /// A text of a Web card or Link List written in place, all of it selected
  func editWebText(_ id: CardID, _ what: WebText) {
    guard let doc = document, case .own(let c)? = doc.board.card(id)?.content else { return }
    let f = WebFonts(theme)
    switch (what, c.body) {
    case (.title, .web), (.description, .web):
      guard let (w, r, b) = webAt(id) else { return }
      let title = what == .title
      let lh = title ? WebLayout.titleLine : WebLayout.descLine
      let at = title ? b.title.at : (b.desc.isEmpty ? CGPoint(x: b.title.at.x, y: b.site?.y ?? b.title.at.y) : b.descAt)
      let mainW = (b.image.map { b.shape == .side ? $0.minX : r.width } ?? r.width) - at.x - 14
      let box = CGRect(x: r.minX + at.x - 2, y: r.minY + at.y - 1, width: mainW + 4, height: lh + 2)
      let text = title ? (w.page.title ?? w.page.domain) : (w.page.desc ?? "")
      writeInPlace(
        .web(id, what), text, at: box.origin, select: .card(id), box: box, font: title ? f.title : f.desc,
        placeholder: title ? w.page.domain : "Description")
    case (.listTitle, .links):
      guard let (l, r, _) = linksAt(id) else { return }
      let x: CGFloat = theme.id == .inkWash ? 14 : 30
      let box = CGRect(x: r.minX + x - 2, y: r.minY + theme.headerHeight / 2 - 10, width: 200, height: 20)
      writeInPlace(.web(id, what), l.title, at: box.origin, select: .card(id), box: box, font: f.header)
    case (.row(let item), .links):
      guard let (l, r, lay) = linksAt(id), let i = l.rows.firstIndex(where: { $0.id == item }) else { return }
      let row = lay.rows[i]
      let b = row.rich ?? row.compact
      let at = b?.title.at ?? CGPoint(x: 36, y: 8)
      let font = row.rich != nil ? f.title13 : f.rowTitle
      let box = CGRect(
        x: r.minX + at.x - 2, y: r.minY + row.rect.minY + at.y - 1, width: r.width - at.x - 60, height: 20)
      let page = l.rows[i].page
      writeInPlace(
        .web(id, what), page.title ?? page.domain, at: box.origin, select: .card(id), box: box, font: font,
        placeholder: page.domain)
    default:
      return
    }
  }

  /// What was written in place, one step: blank or the page's own is none
  func commitWebText(_ id: CardID, _ w: WebText, _ text: String) {
    guard let doc = document else { return }
    switch w {
    case .title: doc.edit("Edit Title") { $0.setWebText(id, title: text) }
    case .description: doc.edit("Edit Description") { $0.setWebText(id, description: text) }
    case .listTitle:
      doc.edit("Rename") { b in
        guard let i = b.cards.firstIndex(where: { $0.id == id }), case .own(var c) = b.cards[i].content else { return }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        c.title = t.isEmpty || t == "Link List" ? nil : t
        b.cards[i].content = .own(c)
      }
    case .row(let item): doc.edit("Rename Link") { $0.renameLinkItem(id, item, text) }
    }
  }

  // MARK: Menus

  /// A Web card's own items (menus.ts webMenu)
  func webMenuItems(_ id: CardID) -> [NSMenuItem] {
    guard case .own(let c)? = document?.board.card(id)?.content, case .web(let w) = c.body else { return [] }
    let view = NSMenu()
    let styles: [(String, WebCard.Style)] = [
      ("Auto", .automatic), ("Image on Top", .banner), ("Image on Side", .side), ("No Image", .text),
      ("Compact", .compact),
    ]
    for (title, s) in styles {
      view.addItem(menuItem(title, checked: w.style == s) { [weak self] in self?.setWebStyle(id, s) })
    }
    let v = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
    v.submenu = view
    return [
      menuItem("Open in Browser") { [weak self] in
        if let u = URL(string: w.url) { self?.openURL(u) }
      },
      menuItem("Refresh Preview") { [weak self] in self?.refreshWeb(id) }, v,
      menuItem("Edit Title") { [weak self] in self?.editWebText(id, .title) },
      menuItem("Edit Description") { [weak self] in self?.editWebText(id, .description) },
    ]
  }

  /// A Link List's own items (menus.ts linksMenu)
  func linksMenuItems(_ id: CardID) -> [NSMenuItem] {
    guard case .own(let c)? = document?.board.card(id)?.content, case .links(let l) = c.body else { return [] }
    let view = NSMenu()
    view.addItem(menuItem("Compact", checked: !l.rich) { [weak self] in self?.setListRich(id, false) })
    view.addItem(menuItem("Rich", checked: l.rich) { [weak self] in self?.setListRich(id, true) })
    let v = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
    v.submenu = view
    return [
      menuItem("Open All in Browser") { [weak self] in
        for it in l.items { if let u = URL(string: it.url) { self?.openURL(u) } }
      }, v,
      menuItem("Rename") { [weak self] in self?.editWebText(id, .listTitle) },
    ]
  }

  func setListRich(_ id: CardID, _ rich: Bool) {
    document?.edit("View") { $0.setLinksRich(id, rich) }
  }

  /// A row's menu (menus.ts rowMenu)
  func rowMenu(_ id: CardID, _ item: String) -> NSMenu? {
    guard case .own(let c)? = document?.board.card(id)?.content, case .links(let l) = c.body,
      let it = l.items.first(where: { $0.id == item })
    else { return nil }
    let rich = l.isRich(it)
    let m = NSMenu()
    m.addItem(
      menuItem("Open in Browser") { [weak self] in
        if let u = URL(string: it.url) { self?.openURL(u) }
      })
    m.addItem(
      menuItem(rich ? "Show as Compact" : "Show as Rich") { [weak self] in
        self?.document?.edit("View") { $0.setLinkItemRich(id, item, !rich) }
      })
    m.addItem(menuItem("Edit Title") { [weak self] in self?.editWebText(id, .row(item)) })
    if it.meta?.failed != false {
      m.addItem(menuItem("Retry Preview") { [weak self] in self?.fetchWeb(id, item: item, url: it.url) })
    }
    m.addItem(.separator())
    m.addItem(menuItem("Move Out as Card") { [weak self] in self?.takeOut(id, item, at: nil) })
    m.addItem(
      menuItem("Remove from List") { [weak self] in
        self?.document?.edit("Remove from List") { $0.removeLinkItem(id, item) }
      })
    return m
  }

  /// Move Out as Card: the row a Web card again, at `p` (board; from a drag: there, less 20 across and 16 down) or to
  /// the right of the list; selected
  func takeOut(_ id: CardID, _ item: String, at p: CGPoint?) {
    guard let doc = document, let list = doc.board.card(id) else { return }
    let new = CardID(rawValue: Board.newID("card-"))
    let r = index(of: .card(id)).map { scene!.items[$0].rect }
    let x = p.map { ($0.x - 20).rounded() } ?? ((r?.maxX ?? list.x + list.width) + 40).rounded()
    let y = p.map { ($0.y - 16).rounded() } ?? list.y
    doc.edit("Move Out as Card", selection: [.card(new)]) { $0.takeOutLinkItem(id, item, as: new, x: x, y: y) }
  }

  // MARK: Dragging a row

  /// A press on a row of a Link List (not its header): the row is dragged
  func pressRow(_ e: NSEvent, view v: CGPoint, board p: CGPoint) -> Bool {
    guard e.clickCount == 1, let doc = document, let row = linkRow(at: p), !doc.board.isLocked(.card(row.card)),
      let (l, _, _) = linksAt(row.card)
    else { return false }
    if doc.selection != [.card(row.card)] { doc.select([.card(row.card)]) }
    let page = l.rows[row.index].page
    gesture = Gesture(
      kind: .row(RowDrag(card: row.card, item: row.item, label: page.title ?? page.domain, start: p, to: row.index)),
      startView: v, start: p)
    return true
  }

  /// The row follows: where it would go in the list (a line of the accent), or out of the card by more than 18 points
  func dragRow(_ d: inout RowDrag, view v: CGPoint) {
    let p = camera.board(v)
    guard d.moved || hypot(p.x - d.start.x, p.y - d.start.y) * camera.zoom >= 3,
      let (l, r, lay) = linksAt(d.card)
    else { return }
    d.moved = true
    d.at = v
    let out = 18 / camera.zoom
    if !r.insetBy(dx: -out, dy: -out).contains(p) {
      d.to = nil
    } else {
      let y = p.y - r.minY
      d.to = lay.rows.firstIndex { y < $0.rect.midY } ?? l.rows.count
    }
    drawRowDrag(d)
  }

  func drawRowDrag(_ d: RowDrag?) {
    withoutAnimation {
      rowLine.removeFromSuperlayer()
      rowGhost.removeFromSuperlayer()
      guard let d, d.moved, let (_, r, lay) = linksAt(d.card) else { return }
      if let to = d.to {
        let y = to < lay.rows.count ? lay.rows[to].rect.minY : (lay.rows.last?.rect.maxY ?? theme.headerHeight)
        rowLine.frame = CGRect(x: r.minX + 8, y: r.minY + y - 1, width: r.width - 16, height: 2)
        rowLine.backgroundColor = theme.accent
        rowLine.cornerRadius = 1
        chrome.addSublayer(rowLine)
      }
      let font = WebFonts(theme).rowTitle
      let text = (d.to == nil ? "Move out as card · " : "") + d.label
      let w = min(280, Drawing.width(text, font) + 18)
      rowGhost.frame = CGRect(x: d.at.x + 12, y: d.at.y + 10, width: w, height: 24)
      rowGhost.cornerRadius = 10
      rowGhost.backgroundColor = theme.surface
      rowGhost.borderColor = theme.accent
      rowGhost.borderWidth = d.to == nil ? 1.5 : 0
      rowGhost.shadowColor = CGColor(gray: 0, alpha: 1)
      rowGhost.shadowOpacity = 0.12
      rowGhost.shadowRadius = 6
      rowGhost.shadowOffset = CGSize(width: 0, height: 3)
      let scale = backing
      rowGhost.contentsScale = scale
      rowGhost.contents = CanvasView.picture(size: rowGhost.bounds.size, scale: scale) { [theme] ctx in
        Drawing.text(ctx, text, font, theme.ink, x: 9, midY: 12, width: w - 18)
      }
      layer?.addSublayer(rowGhost)
    }
  }

  /// Let go: the row in its new place, or out as a Web card where it was let go; one step
  func commitRow(_ d: RowDrag, view v: CGPoint) {
    gesture = nil
    drawRowDrag(nil)
    guard d.moved, let doc = document else { return }
    if let to = d.to {
      doc.edit("Move Link") { $0.moveLinkItem(d.card, d.item, to: to) }
    } else {
      takeOut(d.card, d.item, at: camera.board(v))
    }
  }
}
