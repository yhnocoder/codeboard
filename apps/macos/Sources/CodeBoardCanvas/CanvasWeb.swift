import AppKit
import CodeBoardModel
import CryptoKit

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

/// The Link List row under the pointer; `grip`: on its ⋮⋮
struct RowHover: Equatable {
  var card: CardID
  var item: String
  var grip = false
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
  // MARK: Reading a page

  /// The images folder of the board shown
  var imagesFolder: URL? { shown.map { $0.1.url(of: $0.0.path).appending(path: Vault.imagesFolder) } }

  /// Reads a card's page (a row's, by `item`), off the main thread, and puts what was read on the card, no step; its
  /// pictures go into the board's images. Shown "Fetching preview…" meanwhile
  /// `retry`: asked for again (actions/web.ts retryMeta), so nothing read again is said
  package func fetchWeb(_ id: CardID, item: String? = nil, url: String, retry: Bool = false) {
    guard let u = URL(string: url), let folder = imagesFolder else { return }
    let key = item.map { "\(id.rawValue)/\($0)" } ?? id.rawValue
    guard !webFetching.contains(key) else { return }
    webFetching.insert(key)
    if item == nil { refresh() }
    let fetch = fetchPage
    // the board it was read for, though another be shown by the time it arrives
    weak let doc = document
    let task = Task { [weak self] in
      let page = await fetch(u)
      let meta = await Task.detached { CanvasView.store(page, in: folder) }.value
      // learned, not done: no step, and an undo or redo that brings the card back brings it back with its page
      doc?.derive { $0.setWebMeta(id, item: item, url: url, meta) }
      guard let self else { return }
      webFetching.remove(key)
      if item == nil { refresh() }
      // main's toast also offers Open in Browser; toasts here have no buttons yet
      if retry, meta.failed == true { toast("Still nothing. The page may need a login: open it in your browser.") }
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

  /// The pictures of image cards at web addresses not read yet, each read once (ImageBody.tsx: the browser reads an
  /// <img> once and keeps it) and kept in the picture cache by its address's hash, so a later launch reads it there.
  /// Asked from a redraw, which waits for a gesture's end, as does the redraw that puts the picture in
  func fetchPictures(_ board: Board) {
    for c in board.cards {
      guard case .own(let k) = c.content, case .image(let img) = k.body, case .url(let s) = img.source,
        remotePictures[s] == nil, remoteAsked.insert(s).inserted, let u = URL(string: s)
      else { continue }
      let hash = SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
      let file = pictureCache.appending(path: hash)
      if FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) {
        remotePictures[s] = file
        continue
      }
      let (fetch, folder) = (fetchPicture, pictureCache)
      Task { [weak self] in
        guard let data = await fetch(u),
          (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)) != nil,
          (try? data.write(to: file, options: .atomic)) != nil, let self
        else { return }
        remotePictures[s] = file
        refresh()
      }
    }
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

  /// A link on the board opened (a Web card, a row, a link in a Note): only a web page or a mail address (main's host
  /// handlers.ts openLink, which every open goes through: file:// and the like would open a program here)
  func openLink(_ s: String) {
    guard let u = URL(string: s), ["http", "https", "mailto"].contains(u.scheme?.lowercased() ?? "") else { return }
    openURL(u)
  }

  /// A double-click on a Web card or a row: its page in the browser. False when it is on neither
  func openPage(at p: CGPoint) -> Bool {
    guard let u = pageURL(at: p) else { return false }
    openLink(u.absoluteString)
    return true
  }

  /// What nothing read shows under a board point: its card's Retry (true) or Edit Title (false)
  func webLink(at p: CGPoint) -> (card: CardID, retry: Bool)? {
    guard let id = hitCard(p), let (_, r, b) = webAt(id), b.shape == .none else { return nil }
    let local = CGPoint(x: p.x - r.minX, y: p.y - r.minY)
    if let rr = b.retry, rr.contains(local) { return (id, true) }
    if let e = b.edit, e.contains(local) { return (id, false) }
    return nil
  }

  /// Retry, or Edit Title, clicked
  func pressWebLink(_ l: (card: CardID, retry: Bool)) {
    if l.retry { refreshWeb(l.card) } else { editWebText(l.card, .title) }
  }

  // MARK: Commands

  /// Refresh Preview, Retry: the page read again (what was read is overwritten)
  func refreshWeb(_ id: CardID) {
    guard case .own(let c)? = document?.board.card(id)?.content, case .web(let w) = c.body else { return }
    fetchWeb(id, url: w.url, retry: true)
  }

  func setWebStyle(_ id: CardID, _ s: WebCard.Style) {
    document?.edit("View") { $0.setWebStyle(id, s) }
  }

  /// Merge into Link List: the selected Web cards and Link Lists, one step; the list selected
  func mergeSelected() {
    guard let doc = document else { return }
    merge(doc.selection.compactMap(\.card))
  }

  /// Web cards and Link Lists merged into `target` (a drop's) or the top one, one step; the list selected, how many
  /// links it has said (actions/web.ts mergeIntoLinkList)
  func merge(_ ids: [CardID], into target: CardID? = nil) {
    guard let doc = document else { return }
    let order = ids.sorted { a, b in (index(of: .card(a)) ?? 0) < (index(of: .card(b)) ?? 0) }
    var kept: CardID?
    doc.edit("Merge into Link List") { kept = $0.mergeLinks(target.map { [$0] + order } ?? order, into: target) }
    guard let kept else { return }
    doc.select([.card(kept)])
    if case .own(let c)? = doc.board.card(kept)?.content, case .links(let l) = c.body {
      toast("Merged into a Link List · \(l.items.count) links")
    }
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

  /// Whether a board point is on a Link List's title in its header (interact.ts: a double-click on .ctitle renames it)
  func onListTitle(_ id: CardID, _ p: CGPoint) -> Bool {
    guard let (l, r, _) = linksAt(id) else { return false }
    let x = r.minX + LinksLayout.titleX(theme)
    let w = max(Drawing.width(l.title, WebFonts(theme).header), 40)
    return p.y < r.minY + theme.headerHeight && p.x >= x && p.x <= x + w
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
      let x = LinksLayout.titleX(theme)
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
    // WebBody.tsx onTitle, the list's Editable: renameCard, the references to its old name following
    case .title: doc.edit("Edit Title") { $0.renameCard(id, text) }
    case .description: doc.edit("Edit Description") { $0.setWebText(id, description: text) }
    case .listTitle: doc.edit("Rename") { $0.renameCard(id, text) }
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
        self?.openLink(w.url)
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
        for it in l.items { self?.openLink(it.url) }
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
        self?.openLink(it.url)
      })
    m.addItem(
      menuItem(rich ? "Show as Compact" : "Show as Rich") { [weak self] in
        self?.document?.edit("View") { $0.setLinkItemRich(id, item, !rich) }
      })
    m.addItem(menuItem("Edit Title") { [weak self] in self?.editWebText(id, .row(item)) })
    if it.meta?.failed == true {
      m.addItem(menuItem("Retry Preview") { [weak self] in self?.fetchWeb(id, item: item, url: it.url, retry: true) })
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
    // from the menu: right of the list, the first free place from there (core layout.ts findFree; a Web card's
    // estimate is 112 tall)
    let free = Self.findFree(
      CGRect(x: (r?.maxX ?? list.x + list.width) + 40, y: list.y, width: Board.webWidth, height: 112),
      others: scene?.placed.values.map(\.rect) ?? [])
    let x = p.map { ($0.x - 20).rounded() } ?? free.x.rounded()
    let y = p.map { ($0.y - 16).rounded() } ?? free.y.rounded()
    doc.edit("Move Out as Card", selection: [.card(new)]) { $0.takeOutLinkItem(id, item, as: new, x: x, y: y) }
  }

  // MARK: Dragging a row

  /// A press on a row's ⋮⋮ (WebBody.tsx .lgrip): the row is dragged, in a locked list too (the web board hides only a
  /// locked card's own grips, not its rows'); a press elsewhere on the row is the card's
  func pressRow(_ e: NSEvent, view v: CGPoint, board p: CGPoint) -> Bool {
    guard e.clickCount == 1, let doc = document, let row = linkRow(at: p),
      let (l, _, _) = linksAt(row.card), rowGrip(row.card, row.index)?.contains(p) == true
    else { return false }
    hoveredRow = nil
    closeRowPeek()
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

  // MARK: Merging by a drag

  /// How long dragged Web cards stay over another's title before letting go merges them (timing.ts MERGE_HOLD)
  static let mergeHoldTime: Duration = .milliseconds(400)

  /// Whether a card is a Web card or a Link List
  func isWebKind(_ id: CardID) -> Bool {
    guard case .own(let c)? = document?.board.card(id)?.content else { return false }
    switch c.body {
    case .web, .links: return true
    default: return false
    }
  }

  /// The Web card or Link List whose title is under the pointer while only Web cards and Link Lists are dragged
  /// (interact.ts webHead: a list's .chead, a Web card's .wtitle)
  func mergeTarget(_ m: Move, at p: CGPoint) -> CardID? {
    guard m.sections.isEmpty, !m.cards.isEmpty, m.cards.allSatisfy(isWebKind),
      let id = hitCard(p, skip: m.cards), isWebKind(id)
    else { return nil }
    if let (_, r, _) = linksAt(id) { return p.y < r.minY + theme.headerHeight ? id : nil }
    guard let (_, r, b) = webAt(id) else { return nil }
    let lh = WebLayout.titleLine
    let title = CGRect(
      x: r.minX, y: r.minY + b.title.at.y, width: r.width, height: CGFloat(max(1, b.title.lines.count)) * lh)
    return title.contains(p) ? id : nil
  }

  /// Where the drag aims: over a title, armed by ⌥ at once or after MERGE_HOLD there (it stays armed while the
  /// pointer stays on that card); off any, no merge
  func aimMerge(_ m: inout Move, at p: CGPoint, alt: Bool) {
    guard let target = mergeTarget(m, at: p) else {
      mergeHold?.cancel()
      m.merge = nil
      return
    }
    if alt {
      mergeHold?.cancel()
      m.merge = MergeDrop(card: target, armed: true)
      return
    }
    if m.merge?.card == target { return }
    m.merge = MergeDrop(card: target, armed: false)
    mergeHold?.cancel()
    mergeHold = Task { [weak self] in
      try? await Task.sleep(for: Self.mergeHoldTime)
      guard let self, !Task.isCancelled, var g = gesture, case .move(var m) = g.kind, m.merge?.card == target
      else { return }
      m.merge?.armed = true
      g.kind = .move(m)
      gesture = g
      drawChrome()
    }
  }

  /// Let go armed: the cards back where the drag started, then merged into the card under them, one step
  func dropMerge(_ m: Move, into target: CardID) {
    gesture = nil
    snapSettle?.cancel()
    showGuides([])
    land()
    clearDrop()
    showScene(arrows: m.arrows, items: m.items, frames: m.frames)
    merge(Array(m.cards), into: target)
    drawChrome()
  }

  /// The card a merge would go into, lit (styles.css .card.merge-arm: a 1.5 ring of --k-fn at 60 %; armed,
  /// .merge-hot: 2.5 of it over 6 of --hi) and, armed, "Release to merge" 8 above it at the size it has on screen
  /// (Canvas.tsx DropHint)
  func drawMergeDrop() {
    var drop: MergeDrop?
    if case .move(let m)? = gesture?.kind { drop = m.merge }
    withoutAnimation {
      mergeHint.removeFromSuperlayer()
      guard let drop, let i = index(of: .card(drop.card)), let s = scene else { return }
      let r = s.items[i].rect
      let fn = theme.syntax[.function] ?? theme.accent
      let k = theme.cardRadius
      @MainActor func ring(_ out: CGFloat, _ w: CGFloat, _ c: CGColor) {
        let l = CAShapeLayer()
        let d = out - w / 2
        l.path = Drawing.squircle(r.insetBy(dx: -d, dy: -d), k + d)
        l.fillColor = nil
        l.strokeColor = c
        l.lineWidth = w
        chrome.addSublayer(l)
      }
      guard drop.armed else { return ring(1.5, 1.5, fn.copy(alpha: 0.6) ?? fn) }
      ring(6, 6, fn.copy(alpha: theme.dark ? 0.2 : 0.16) ?? fn)
      ring(2.5, 2.5, fn)
      let text = "Release to merge"
      let font = Font(NSFont.systemFont(ofSize: 11.5, weight: .semibold))
      let size = CGSize(width: (Drawing.width(text, font) + 20).rounded(.up), height: 23.5)
      let bottom = camera.view(CGPoint(x: r.midX, y: r.minY - 8))
      mergeHint.frame = CGRect(
        x: (bottom.x - size.width / 2).rounded(), y: (bottom.y - size.height).rounded(), width: size.width,
        height: size.height)
      mergeHint.cornerRadius = 8.5
      mergeHint.backgroundColor = fn
      mergeHint.shadowColor = CGColor(gray: 0, alpha: 1)
      mergeHint.shadowOpacity = 0.14
      mergeHint.shadowRadius = 8
      mergeHint.shadowOffset = CGSize(width: 0, height: 4)
      mergeHint.contentsScale = backing
      mergeHint.contents = CanvasView.picture(size: size, scale: backing) { ctx in
        Drawing.text(ctx, text, font, CGColor(gray: 1, alpha: 1), x: 10, midY: size.height / 2, width: .infinity)
      }
      layer?.addSublayer(mergeHint)
    }
  }

  // MARK: A row hovered

  /// A row's ⋮⋮ on the board (web.css .lgrip): 12 by 22 at the row's left edge, level with its middle, a Rich row's
  /// 22 from its top
  func rowGrip(_ id: CardID, _ i: Int) -> CGRect? {
    guard let (l, r, lay) = linksAt(id), i < lay.rows.count, i < l.rows.count else { return nil }
    let rr = lay.rows[i].rect
    let mid = l.rows[i].rich ? rr.minY + 22 : rr.midY
    return CGRect(x: r.minX, y: r.minY + mid - 11, width: 12, height: 22)
  }

  /// The tools of a row (.ltools), card points: right 8, 5 down a Compact row, 12 over a Rich one's top (4 down the
  /// first); 2 round three buttons 22 by 20, 2 apart
  static func rowToolsPill(_ rr: CGRect, rich: Bool, first: Bool, width w: CGFloat) -> CGRect {
    let top: CGFloat = rich ? (first ? 4 : -12) : 5
    return CGRect(x: w - 8 - 74, y: rr.minY + top, width: 74, height: 24)
  }

  /// The hovered row's tools as header buttons of its list, in card points
  func rowTools(_ id: CardID) -> [(HeadAct, CGRect)] {
    guard let h = hoveredRow, h.card == id, let (l, r, lay) = linksAt(id),
      let i = l.rows.firstIndex(where: { $0.id == h.item }), i < lay.rows.count
    else { return [] }
    let pill = Self.rowToolsPill(lay.rows[i].rect, rich: l.rows[i].rich, first: i == 0, width: r.width)
    return RowTool.allCases.enumerated().map { k, t in
      (.row(h.item, t), CGRect(x: pill.minX + 2 + CGFloat(k) * 24, y: pill.minY + 2, width: 22, height: 20))
    }
  }

  func isRichRow(_ d: Drawing, _ item: String) -> Bool {
    if case .links(let l) = d { l.rows.first { $0.id == item }?.rich == true } else { false }
  }

  /// A row's tool pressed (WebBody.tsx LinkRow .ltools)
  func pressRowTool(_ id: CardID, _ item: String, _ t: RowTool) {
    guard let doc = document, case .own(let c)? = doc.board.card(id)?.content, case .links(let l) = c.body,
      let it = l.items.first(where: { $0.id == item })
    else { return }
    switch t {
    case .rich:
      let rich = linksAt(id)?.0.rows.first { $0.id == item }?.rich ?? false
      doc.edit("View") { $0.setLinkItemRich(id, item, !rich) }
    case .open: openLink(it.url)
    case .remove:
      hoveredRow = nil
      closeRowPeek()
      doc.edit("Remove from List") { $0.removeLinkItem(id, item) }
    }
  }

  /// The row under the pointer hovered (.lrow:hover): on its tools it stays the row they are of, though a Rich row's
  /// stand over the row above; a Compact row shows its whole bookmark beside the card after WEB_PEEK_DELAY
  func hoverRow(at p: CGPoint) {
    if let (_, a) = headAct(at: p), case .row = a { return }
    let row = linkRow(at: p).flatMap { r -> RowHover? in
      guard levels.level == .cards else { return nil }
      return RowHover(card: r.card, item: r.item, grip: rowGrip(r.card, r.index)?.contains(p) == true)
    }
    guard row != hoveredRow else { return }
    let was = hoveredRow
    hoveredRow = row
    if row?.card != was?.card || row?.item != was?.item {
      closeRowPeek()
      if let row, linksAt(row.card)?.0.rows.first(where: { $0.id == row.item })?.rich == false {
        rowPeekWait = Task { [weak self] in
          try? await Task.sleep(for: Self.webPeekDelay)
          guard let self, !Task.isCancelled, hoveredRow?.card == row.card, hoveredRow?.item == row.item,
            gesture == nil, editing == nil, inPlace == nil
          else { return }
          showRowPeek(row)
        }
      }
    }
    drawChrome()
  }

  /// How long a Compact row is hovered before its bookmark shows (timing.ts WEB_PEEK_DELAY)
  static let webPeekDelay: Duration = .milliseconds(550)

  /// The hovered row's tint, ⋮⋮ and tools, in its card's layer, under the header's (placeHeadActs calls this)
  func placeRowHover() {
    let shown: (RowHover, Int, CALayer, Drawing.Links, LinksLayout)? = hoveredRow.flatMap { h in
      guard levels.level == .cards, let ci = index(of: .card(h.card)), let (l, _, lay) = linksAt(h.card),
        let i = l.rows.firstIndex(where: { $0.id == h.item }), i < lay.rows.count
      else { return nil }
      return (h, i, items[ci].box, l, lay)
    }
    guard let (h, i, box, l, lay) = shown else {
      rowHoverShown?.layer.removeFromSuperlayer()
      rowHoverShown = nil
      return
    }
    let size = box.bounds.size
    let lit = hoveredHead.flatMap { $0.0 == h.card ? $0.1 : nil }
    let scale = (restZoom ?? camera.zoom) * backing
    let rr = lay.rows[i].rect
    let key = "\(h) \(String(describing: lit)) \(size) \(rr) \(l.rows[i].rich) \(theme.id) \(theme.dark) \(scale)"
    if let s = rowHoverShown, s.key == key, s.layer.superlayer === box { return }
    // room round the card for the tools' shadow
    let pad: CGFloat = 24
    let t = theme
    let rich = l.rows[i].rich
    let pill = Self.rowToolsPill(rr, rich: rich, first: i == 0, width: size.width)
    let tools = rowTools(h.card)
    withoutAnimation {
      rowHoverShown?.layer.removeFromSuperlayer()
      let layer = CALayer()
      layer.zPosition = 3.4
      layer.frame = CGRect(origin: .zero, size: size).insetBy(dx: -pad, dy: -pad)
      layer.contentsGravity = .resize
      layer.contents = CanvasView.picture(size: layer.bounds.size, scale: scale) { ctx in
        ctx.translateBy(x: pad, y: pad)
        Self.drawRowHover(
          ctx, row: rr, card: size, rich: rich, grip: h.grip, pill: pill, tools: tools, lit: lit, t, scale: scale)
      }
      box.addSublayer(layer)
      rowHoverShown = (layer, key)
    }
  }

  /// web.css .lrow:hover (--hlrow, within the card's corners), .lgrip (⋮⋮ 10 points, -2 apart, ink-3; ink on it) and
  /// .ltools (surface, 10 round, --sh-float; its buttons 7 round, --hlrow and ink when hovered, ink-2 icons 12 square)
  static func drawRowHover(
    _ ctx: CGContext, row rr: CGRect, card: CGSize, rich: Bool, grip: Bool, pill: CGRect, tools: [(HeadAct, CGRect)],
    lit: HeadAct?, _ t: Theme, scale: CGFloat
  ) {
    ctx.saveGState()
    ctx.addPath(Drawing.squircle(CGRect(origin: .zero, size: card), t.cardRadius))
    ctx.clip()
    ctx.setFillColor(t.hlrow)
    ctx.fill(rr)
    ctx.restoreGState()
    let gf = Font(NSFont.systemFont(ofSize: 10)).tracked(-2)
    let mid = rich ? rr.minY + 22 : rr.midY
    Drawing.text(
      ctx, "⋮⋮", gf, grip ? t.ink : t.ink3, x: (12 - Drawing.width("⋮⋮", gf)) / 2, midY: mid, width: .infinity)
    var look = BarLook.of(t)
    look.ring = t.hair
    look.shadows =
      t.dark
      ? [(2, 6, -1, CGColor(gray: 0, alpha: 0.35)), (10, 28, -8, CGColor(gray: 0, alpha: 0.55))]
      : [
        (2, 6, -1, CGColor(srgbRed: 50 / 255, green: 35 / 255, blue: 10 / 255, alpha: 0.08)),
        (10, 28, -8, CGColor(srgbRed: 50 / 255, green: 35 / 255, blue: 10 / 255, alpha: 0.18)),
      ]
    WritingBar.float(pill, radius: 10, look: look, glass: t.surface, scale: scale, in: ctx)
    for (a, r) in tools {
      guard case .row(_, let tool) = a else { continue }
      let on = lit == a
      if on {
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: 7, cornerHeight: 7, transform: nil))
        ctx.setFillColor(t.hlrow)
        ctx.fillPath()
      }
      let path =
        switch tool {
        case .rich: SVGPath.parse(rich ? WebIcons.compact : WebIcons.rich)
        case .open: HeadActs.external
        case .remove: SVGPath.parse(WebIcons.close)
        }
      ctx.saveGState()
      ctx.translateBy(x: r.midX - 6, y: r.midY - 6)
      ctx.scaleBy(x: 0.75, y: 0.75)
      Icons.stroke(path, at: .zero, color: on ? t.ink : t.ink2, in: ctx)
      ctx.restoreGState()
    }
  }

  // MARK: A Compact row's bookmark beside the card

  /// web.css .lpeek: the row's bookmark 340 wide on the surface, 14 round, in a float's shadow, 10 right of the card
  /// and 8 above the row's top (left of the card when the right has no room), at the size it has on screen; in over
  /// 140 ms from 4 to the left
  func showRowPeek(_ h: RowHover) {
    guard let (l, r, lay) = linksAt(h.card), let i = l.rows.firstIndex(where: { $0.id == h.item }),
      i < lay.rows.count
    else { return }
    closeRowPeek()
    let page = l.rows[i].page
    let t = theme
    let b = WebLayout.of(page, style: .automatic, width: 340, small: false, loading: false, t)
    let size = CGSize(width: 340, height: b.height)
    let cardView = CGRect(origin: camera.view(r.origin), size: CGSize(width: r.width * camera.zoom, height: 0))
    let top = camera.view(CGPoint(x: r.minX, y: r.minY + lay.rows[i].rect.minY)).y - 8
    // place.ts: flip (8 in from the edges; neither side fitting, the one that overflows less, the right on a tie),
    // then shifted 8 inside on both axes
    let right = cardView.maxX + 10
    let left = cardView.minX - 10 - size.width
    let over = (right + size.width - (bounds.maxX - 8), bounds.minX + 8 - left)
    var x = over.0 <= 0 || over.0 <= over.1 ? right : left
    x = min(max(x, bounds.minX + 8), bounds.maxX - 8 - size.width)
    let y = min(max(top, bounds.minY + 8), bounds.maxY - 8 - size.height)
    let images = images
    let scale = backing
    let peek = CALayer()
    withoutAnimation {
      peek.frame = CGRect(origin: CGPoint(x: x.rounded(), y: y.rounded()), size: size)
      peek.cornerRadius = 14
      peek.backgroundColor = t.surface
      peek.borderColor = t.hair
      peek.borderWidth = 0.5
      peek.shadowColor = CGColor(gray: 0, alpha: 1)
      peek.shadowOpacity = t.dark ? 0.5 : 0.22
      peek.shadowRadius = 16
      peek.shadowOffset = CGSize(width: 0, height: 12)
      peek.shadowPath = CGPath(
        roundedRect: CGRect(origin: .zero, size: size), cornerWidth: 14, cornerHeight: 14, transform: nil)
      peek.contentsScale = scale
      peek.contents = CanvasView.picture(size: size, scale: scale) { ctx in
        ctx.addPath(
          CGPath(roundedRect: CGRect(origin: .zero, size: size), cornerWidth: 14, cornerHeight: 14, transform: nil))
        ctx.clip()
        _ = Drawing.bookmark(
          ctx, page, b, in: CGRect(origin: .zero, size: size), loading: false, small: false, t, images: images,
          scale: scale)
      }
      layer?.addSublayer(peek)
    }
    let o = CABasicAnimation(keyPath: "opacity")
    o.fromValue = 0
    let m = CABasicAnimation(keyPath: "transform.translation.x")
    m.fromValue = -4
    let g = CAAnimationGroup()
    g.animations = [o, m]
    g.duration = 0.14
    g.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
    peek.add(g, forKey: "in")
    rowPeek = (peek, h)
  }

  func closeRowPeek() {
    rowPeekWait?.cancel()
    rowPeekWait = nil
    rowPeek?.layer.removeFromSuperlayer()
    rowPeek = nil
  }
}
