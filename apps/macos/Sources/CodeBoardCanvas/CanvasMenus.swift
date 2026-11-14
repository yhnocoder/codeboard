import AppKit
import CodeBoardModel

// The context menus (the web board's actions/menus.ts: cardMenu, multiItems, sectionMenu, multiSectionItems,
// canvasMenu; actions/edit.ts arrangeItem; host paths.ts for Copy Path), in its order with its separators, its keys shown
// as the items' key equivalents. Arrows, labels, stickers, Shelf entries and Link List rows have theirs in their files.

extension CanvasView {
  /// What is under the pointer, selected first when it is not
  public override func menu(for e: NSEvent) -> NSMenu? {
    guard let doc = document, gesture == nil, levels.level == .cards else { return nil }
    let p = camera.board(convert(e.locationInWindow, from: nil))
    if let i = stickerAt(p), markAt(p) == nil {
      let id = stickerSpots[i].id
      doc.select([.sticker(id)])
      return stickerMenu(id)
    }
    if let id = hitArrowLabel(p) {
      doc.select([.arrow(id)])
      return labelMenu(id)
    }
    if hitCard(p) == nil, let id = hitArrow(p) {
      doc.select([.arrow(id)])
      return arrowMenu(id)
    }
    if let row = linkRow(at: p) {
      doc.select([.card(row.card)])
      return rowMenu(row.card, row.item)
    }
    // a ref to another board: that board's seal
    if let r = refAt(p), let b = refBoard(r.box) {
      let m = NSMenu()
      m.addItem(menuItem("Edit Mark…") { [weak self] in self?.editSeal(b, at: r) })
      return m
    }
    let under = hitCard(p).map(Item.card) ?? hitSectionTitle(p).map(Item.section) ?? deepestSection(p).map(Item.section)
    if let under, !doc.selection.contains(under) { doc.select([under]) } else if under == nil { doc.select([]) }
    let sel = doc.selection
    let cards = sel.compactMap(\.card)
    let secs = sel.compactMap(\.section)
    if sel.isEmpty { return boardMenu(at: p) }
    // Sections and no cards: theirs; with cards too, the menu for several
    if cards.isEmpty, !secs.isEmpty {
      return secs.count == 1 ? sectionMenu(secs[0]) : sectionsMenu(secs.sorted { $0.rawValue < $1.rawValue })
    }
    if sel.count > 1 { return severalMenu() }
    guard let c = cards.first else { return nil }
    // a right-click on a code line selects it (kept when it is in the lines selected): Add Sidenote goes on them
    lineForMenu(at: p, of: c)
    return cardMenu(c, at: p)
  }

  // MARK: One card

  /// Add Sidenote, then the kind's own items, then Arrange ▸, Copy Path and Delete (menus.ts cardItems, kindItems)
  func cardMenu(_ c: CardID, at p: CGPoint) -> NSMenu {
    let m = NSMenu()
    let arrange = arrangeItem([c], tiltAndLock: true)
    // a folder board's automatic card (the app's own): Open and Arrange ▸ (it goes only with its board or folder)
    if document?.board.isAuto(c) == true, !isGone(c) {
      m.addItem(menuItem("Open") { [weak self] in self?.openSubBoard(c) })
      m.addItem(arrange)
      return m
    }
    m.addItem(addNoteItem(card: c, at: p))
    m.addItem(.separator())
    if case .board? = scene?.parts[c]?.content.body {
      m.addItem(key(menuItem("Open") { [weak self] in self?.openSubBoard(c) }, "\r", .command))
      m.addItem(.separator())
      m.addItem(arrange)
      m.addItem(copyPathItem([c.rawValue]))
      m.addItem(.separator())
      m.addItem(key(action("Remove from This Board", #selector(delete(_:))), "\u{8}"))
      return m
    }
    for i in webMenuItems(c) + linksMenuItems(c) + codeMenuItems(c) { m.addItem(i) }
    m.addItem(arrange)
    m.addItem(copyPathItem([c.rawValue]))
    m.addItem(.separator())
    m.addItem(key(action("Delete", #selector(delete(_:))), "\u{8}"))
    return m
  }

  /// A code card's View ▸ (kindItems view): what it hides, and its background
  func codeMenuItems(_ id: CardID) -> [NSMenuItem] {
    guard case .own(let k)? = document?.board.card(id)?.content, case .code(let c) = k.body else { return [] }
    let hidden = c.segments.contains { !$0.hidden.isEmpty }
    return [
      submenu(
        "View",
        [
          menuItem("Hide Blank Lines", checked: c.hide.blankLines) { [weak self] in
            self?.editCode(id, "Hide Blank Lines") { $0.hide.blankLines.toggle() }
          },
          menuItem("Hide Comments", checked: c.hide.comments) { [weak self] in
            self?.editCode(id, "Hide Comments") { $0.hide.comments.toggle() }
          },
          menuItem("Hide Docstrings", checked: c.hide.docstrings) { [weak self] in
            self?.editCode(id, "Hide Docstrings") { $0.hide.docstrings.toggle() }
          },
          menuItem("Show All Hidden Lines", enabled: hidden) { [weak self] in
            self?.editCode(id, "Show All Hidden Lines") { c in
              for i in c.segments.indices { c.segments[i].hidden = [] }
            }
          },
          .separator(),
          menuItem("Background", checked: c.framed) { [weak self] in
            self?.editCode(id, "Background") { $0.framed.toggle() }
          },
        ])
    ]
  }

  /// One step changing a code card of this board's own
  private func editCode(_ id: CardID, _ name: String, _ change: @escaping (inout CodeCard) -> Void) {
    document?.edit(name) { b in
      guard let i = b.cards.firstIndex(where: { $0.id == id }), case .own(var k) = b.cards[i].content,
        case .code(var c) = k.body
      else { return }
      change(&c)
      k.body = .code(c)
      b.cards[i].content = .own(k)
    }
  }

  // MARK: Several

  /// Several cards, or cards and Sections (menus.ts multiItems)
  func severalMenu() -> NSMenu {
    let m = NSMenu()
    guard let doc = document else { return m }
    let sel = doc.selection
    let cards = sel.compactMap(\.card)
    let secs = sel.compactMap(\.section)
    if mergeable { m.addItem(menuItem("Merge into Link List") { [weak self] in self?.mergeSelected() }) }
    m.addItem(menuItem("Connect with Arrow", enabled: cards.count == 2) { [weak self] in self?.connectSelected() })
    if let to = moveToSectionItem(cards) { m.addItem(to) }
    m.addItem(menuItem("Move to New Section") { [weak self] in self?.moveToNewSection() })
    m.addItem(shelfItem())
    if !secs.isEmpty {
      let color = colorItem(secs)
      color.title = "Section Color"
      m.addItem(color)
    }
    m.addItem(key(action("Turn into Board…", #selector(turnIntoBoard(_:))), "b", [.command, .shift]))
    m.addItem(lockItem())
    let tilt = key(action("Tilt", #selector(tilt(_:))), "t", [.option, .shift])
    tilt.state = !cards.isEmpty && cards.allSatisfy { doc.board.card($0)?.tilted == true } ? .on : .off
    m.addItem(tilt)
    m.addItem(arrangeItem(cards, tiltAndLock: false))
    // in the board's order: a selection has none of its own here
    let b = doc.board
    let paths =
      b.cards.filter { sel.contains(.card($0.id)) }.map(\.id.rawValue)
      + b.sections.filter { sel.contains(.section($0.id)) }.map(\.id.rawValue)
    m.addItem(copyPathItem(paths, title: "Copy Paths"))
    m.addItem(.separator())
    m.addItem(key(action("Cut", #selector(cut(_:))), "x", .command))
    m.addItem(key(action("Copy", #selector(copy(_:))), "c", .command))
    m.addItem(key(action("Duplicate", #selector(duplicate(_:))), "d", .command))
    m.addItem(key(action("Delete", #selector(delete(_:))), "\u{8}"))
    return m
  }

  /// Move to Section ▸: the open Sections the cards selected are not all in already, `Parent › Child`, by name
  /// (menus.ts sectionItems); nil when there is none
  private func moveToSectionItem(_ cards: [CardID]) -> NSMenuItem? {
    guard let doc = document, !cards.isEmpty else { return nil }
    let b = doc.board
    let homes = Set(cards.map { b.card($0)?.section })
    func name(_ s: Section) -> String { s.parent.flatMap(b.section).map { "\(name($0)) › \(s.title)" } ?? s.title }
    func shown(_ s: Section) -> Bool { !s.collapsed && (s.parent.flatMap(b.section).map(shown) ?? true) }
    let to = b.sections.filter { shown($0) && !(homes.count == 1 && homes.contains($0.id)) }.map { ($0.id, name($0)) }
      .sorted { $0.1.localizedCompare($1.1) == .orderedAscending }
    guard !to.isEmpty else { return nil }
    return submenu("Move to Section", to.map { id, t in menuItem(t) { [weak self] in self?.moveToSection(id) } })
  }

  /// The cards selected into a Section, at its first free place from its top left, row by row (actions/edit.ts
  /// moveToSection, freeIn: 24 apart, 28 clear of what is there; none: under its lowest card)
  func moveToSection(_ id: SectionID) {
    guard let doc = document, let s = scene, let sec = doc.board.section(id), !sec.collapsed,
      let f = s.frames.first(where: { $0.id == id })?.rect
    else { return }
    let ids = Set(doc.selection.compactMap(\.card)).filter { index(of: .card($0)) != nil }
    let box = ids.compactMap { index(of: .card($0)).map { s.items[$0].rect } }.reduce(CGRect.null) { $0.union($1) }
    guard !box.isNull else { return }
    let inside = s.items.filter {
      if case .card(let c)? = $0.owner { !ids.contains(c) && $0.rect.intersects(f) } else { false }
    }.map(\.rect)
    let (l, r, t, bottom): (CGFloat, CGFloat, CGFloat, CGFloat) = (22, 22, 34, 22)
    let gap: CGFloat = 28
    func free(_ x: CGFloat, _ y: CGFloat) -> Bool {
      let at = CGRect(x: x, y: y, width: box.width, height: box.height).insetBy(dx: -gap, dy: -gap)
      return !inside.contains { $0.intersects(at) && !$0.intersection(at).isEmpty }
    }
    let x0 = f.minX + l
    let y0 = f.minY + t
    var to: CGPoint?
    var y = y0
    search: while y <= f.maxY - bottom - box.height {
      var x = x0
      while x <= max(x0, f.maxX - r - box.width) {
        if free(x, y) {
          to = CGPoint(x: x, y: y)
          break search
        }
        x += 24
      }
      y += 24
    }
    let at = to ?? CGPoint(x: x0, y: max(y0, inside.map { $0.maxY + gap }.max() ?? y0))
    let dx = (at.x - box.minX).rounded()
    let dy = (at.y - box.minY).rounded()
    doc.edit("Move to Section") { b in
      b.move(Set(ids.map(Item.card)), dx: dx, dy: dy)
      b.setHomes(cards: Dictionary(uniqueKeysWithValues: ids.map { ($0, id) }))
    }
    toast("Moved to \(sec.title)")
  }

  // MARK: Sections

  /// A Section's (menus.ts sectionMenu): its row of Fit Content, Color and Lock, then Add Sidenote, Collapse or
  /// Expand, Move Out of Parent Section when it is in one, Copy Path, then Remove Section, which keeps what is in it
  func sectionMenu(_ id: SectionID) -> NSMenu? {
    guard let doc = document, let s = doc.board.section(id) else { return nil }
    let m = NSMenu()
    m.addItem(
      key(
        menuItem("Fit Content", enabled: !fittable([id]).isEmpty) { [weak self] in self?.fitContent([id]) }, "f",
        .option))
    m.addItem(colorItem([id]))
    m.addItem(lockItem())
    m.addItem(.separator())
    m.addItem(addNoteItem(.spot(.section(id))))
    m.addItem(menuItem(s.collapsed ? "Expand" : "Collapse") { [weak self] in self?.press(.fold, of: id) })
    if s.parent != nil {
      m.addItem(
        menuItem("Move Out of Parent Section") { doc.edit("Move Out of Parent Section") { $0.moveOutOfParent(id) } })
    }
    m.addItem(copyPathItem([id.rawValue]))
    m.addItem(.separator())
    m.addItem(action("Remove Section", #selector(delete(_:))))
    return m
  }

  /// Several Sections and no cards (menus.ts multiSectionItems): Fit Content, Lock, Color, Copy Paths, then Move to
  /// Shelf and Remove N Sections
  func sectionsMenu(_ ids: [SectionID]) -> NSMenu {
    let m = NSMenu()
    let fit = fittable(ids)
    m.addItem(
      key(menuItem("Fit Content", enabled: !fit.isEmpty) { [weak self] in self?.fitContent(fit) }, "f", .option))
    m.addItem(lockItem())
    m.addItem(colorItem(ids))
    m.addItem(copyPathItem(ids.map(\.rawValue), title: "Copy Paths"))
    m.addItem(.separator())
    m.addItem(shelfItem())
    m.addItem(action("Remove \(ids.count) Sections", #selector(delete(_:))))
    return m
  }

  // MARK: The board

  /// The board's own, where it was asked (menus.ts canvasMenu)
  func boardMenu(at p: CGPoint) -> NSMenu {
    let m = NSMenu()
    let at = CGPoint(x: p.x.rounded(), y: p.y.rounded())
    m.addItem(
      key(menuItem("New Text") { [weak self] in self?.editSoon { await self?.create(.text(.text), at: at) } }, "t"))
    m.addItem(key(menuItem("New Note") { [weak self] in self?.editSoon { await self?.create(.note, at: at) } }, "n"))
    m.addItem(addNoteItem(.spot(.point(x: at.x, y: at.y))))
    m.addItem(key(action("Paste", #selector(paste(_:))), "v", .command))
    m.addItem(insertBoardItem(at: at))
    m.addItem(.separator())
    m.addItem(key(action("Select All", #selector(selectAll(_:))), "a", .command))
    m.addItem(key(menuItem("Fit to Window") { [weak self] in self?.fitAll() }, "1", .shift))
    return m
  }

  /// Insert Board ▸: every other board of the vault, by name; one that holds this board (through its sub-boards) says
  /// so and makes nothing (subboards.ts insertBoard, wouldCycle)
  private func insertBoardItem(at p: CGPoint) -> NSMenuItem {
    guard let (here, vault) = shown, let tree = try? vault.tree() else { return submenu("Insert Board", []) }
    let others = tree.allBoards.filter { $0.id != here.id }
      .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    guard !others.isEmpty else {
      return submenu("Insert Board", [menuItem("No other boards yet", enabled: false) {}])
    }
    return submenu(
      "Insert Board",
      others.map { o in
        menuItem(o.title) { [weak self] in self?.insertBoard(o, at: p, in: vault, tree: tree) }
      })
  }

  private func insertBoard(_ child: VaultBoard, at p: CGPoint, in vault: Vault, tree: VaultFolder) {
    guard let doc = document, let (here, _) = shown else { return }
    // the boards each board shows as sub-boards, read once
    let byID = Dictionary(tree.allBoards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var seen: Set<BoardID> = []
    func holds(_ b: BoardID) -> Bool {
      guard seen.insert(b).inserted, let vb = byID[b],
        let file = try? vault.board(at: vb.path)
      else { return false }
      return file.cards.contains { c in
        guard case .own(let k) = c.content, case .board(let s) = k.body, case .board(let t) = s.target else {
          return false
        }
        return t == here.id || holds(t)
      }
    }
    if holds(child.id) {
      return toast("Can’t put \(child.title) inside \(here.title): \(here.title) is already inside \(child.title).")
    }
    let id = CardID(rawValue: Board.newID("c"))
    doc.edit("Insert Board", selection: [.card(id)]) {
      $0.cards.append(
        Card(
          id: id, x: p.x, y: p.y, width: 560, height: 360,
          content: .own(CardContent(body: .board(SubBoard(board: child.id))))))
    }
  }

  // MARK: The toolbar's ⋯

  /// The toolbar's ⋯ (Chrome.tsx more, the toolbar not narrow): Undo, Redo, Copy Path (the board's file), Settings…,
  /// Theme ▸; Settings and the themes are the app's own items, which answer them on the responder chain
  public func moreMenu() -> NSMenu {
    let m = NSMenu()
    m.addItem(key(action("Undo", #selector(undo(_:))), "z", .command))
    m.addItem(key(action("Redo", #selector(redo(_:))), "z", [.command, .shift]))
    m.addItem(.separator())
    m.addItem(copyPathItem([]))
    m.addItem(.separator())
    m.addItem(NSMenuItem(title: "Settings…", action: Selector(("showSettings:")), keyEquivalent: ","))
    let themes = Theme.all.map { t in
      let i = NSMenuItem(title: t.name, action: Selector(("chooseTheme:")), keyEquivalent: "")
      i.representedObject = t.id.rawValue
      return i
    }
    m.addItem(submenu("Theme", themes))
    return m
  }

  // MARK: Items

  /// Arrange ▸ (actions/edit.ts arrangeItem): the four orders, Front and Forward off when already in front, Backward
  /// and Back when at the back; a single card's Tilt and Lock after them
  func arrangeItem(_ ids: [CardID], tiltAndLock: Bool) -> NSMenuItem {
    let set = Set(ids)
    let front = atEdge(set, top: true)
    let back = atEdge(set, top: false)
    var items = [
      key(
        menuItem("Bring to Front", enabled: !front) { [weak self] in self?.arrange(set, .front) }, "f",
        [.command, .option, .shift]),
      menuItem("Bring Forward", enabled: !front) { [weak self] in self?.arrange(set, .forward) },
      menuItem("Send Backward", enabled: !back) { [weak self] in self?.arrange(set, .backward) },
      key(
        menuItem("Send to Back", enabled: !back) { [weak self] in self?.arrange(set, .back) }, "b",
        [.command, .option, .shift]),
    ]
    if tiltAndLock, let doc = document {
      let tilt = key(action("Tilt", #selector(tilt(_:))), "t", [.option, .shift])
      tilt.state = ids.allSatisfy { doc.board.card($0)?.tilted == true } ? .on : .off
      items += [.separator(), tilt, lockItem()]
    }
    return submenu("Arrange", items)
  }

  enum Order { case front, forward, backward, back }

  /// The cards in the stacking order (core arrangeCards): to the front or back, or one step past the next card that
  /// overlaps one of them (none: all the way)
  func arrange(_ ids: Set<CardID>, _ how: Order) {
    guard let doc = document, gesture == nil else { return }
    let rects = { [scene] (c: CardID) in scene?.placed[c]?.rect }
    let mine = ids.compactMap(rects)
    let name: String =
      switch how {
      case .front: "Bring to Front"
      case .forward: "Bring Forward"
      case .backward: "Send Backward"
      case .back: "Send to Back"
      }
    doc.edit(name) { b in
      let order = b.cards.map(\.id)
      let moving = b.cards.filter { ids.contains($0.id) }
      let rest = b.cards.filter { !ids.contains($0.id) }
      guard !moving.isEmpty else { return }
      func hit(_ i: Int) -> Bool {
        !ids.contains(order[i]) && rects(order[i]).map { r in mine.contains { $0.intersects(r) } } == true
      }
      let at: Int
      switch how {
      case .front: at = rest.count
      case .back: at = 0
      case .forward:
        let top = order.lastIndex { ids.contains($0) }!
        let next = order.indices.first { $0 > top && hit($0) }
        at = next.map { n in rest.firstIndex { $0.id == order[n] }! + 1 } ?? rest.count
      case .backward:
        let bottom = order.firstIndex { ids.contains($0) }!
        let prev = order.indices.last { $0 < bottom && hit($0) }
        at = prev.map { p in rest.firstIndex { $0.id == order[p] }! } ?? 0
      }
      b.cards = Array(rest[..<at]) + moving + Array(rest[at...])
    }
  }

  /// Whether these cards are all the topmost (or bottommost) ones already
  private func atEdge(_ ids: Set<CardID>, top: Bool) -> Bool {
    guard let cards = document?.board.cards else { return false }
    let n = cards.filter { ids.contains($0.id) }.count
    let edge = top ? cards.suffix(n) : cards.prefix(n)
    return n > 0 && edge.allSatisfy { ids.contains($0.id) }
  }

  /// Lock / Unlock ⇧⌘L: Unlock when everything selected is locked itself
  func lockItem() -> NSMenuItem {
    let sel = document?.selection ?? []
    let all = !sel.isEmpty && sel.allSatisfy(isOwnLock)
    return key(action(all ? "Unlock" : "Lock", #selector(lock(_:))), "l", [.command, .shift])
  }

  /// Copy Path(s): each item's file, a card or Section of this board as `board.json#<id>`, a sub-board card as its
  /// board's file, a shared card as its own file, one per line (host paths.ts itemPaths)
  func copyPathItem(_ ids: [String], title: String = "Copy Path") -> NSMenuItem {
    menuItem(title) { [weak self] in self?.copyPaths(ids) }
  }

  func copyPaths(_ ids: [String]) {
    guard let doc = document, let (here, vault) = shown else { return }
    let file = vault.url(of: here.path).appending(path: Vault.boardFileName).path(percentEncoded: false)
    // none: the board's own file
    var lines: [String] = ids.isEmpty ? [file] : []
    for id in ids {
      let line: String
      if let c = doc.board.card(CardID(rawValue: id)), case .shared = c.content {
        line = vault.sharedFolderURL.appending(path: "\(id).json").path(percentEncoded: false) + "#\(id)"
      } else if let b = subBoardTarget(CardID(rawValue: id)),
        let vb = (try? vault.tree())?.allBoards.first(where: { $0.id == b })
      {
        line = vault.url(of: vb.path).appending(path: Vault.boardFileName).path(percentEncoded: false)
      } else {
        line = "\(file)#\(id)"
      }
      if !lines.contains(line) { lines.append(line) }
    }
    guard !lines.isEmpty else { return }
    pasteboard.clearContents()
    pasteboard.setString(lines.joined(separator: "\n"), forType: .string)
    toast(lines.count > 1 ? "Copied \(lines.count) paths" : "Copied path")
  }

  /// An item that sends `selector` to this canvas (enabled as the canvas validates it)
  func action(_ title: String, _ selector: Selector) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: selector, keyEquivalent: "")
    i.target = self
    return i
  }

  /// The item showing main's key for it
  func key(_ i: NSMenuItem, _ k: String, _ mask: NSEvent.ModifierFlags = []) -> NSMenuItem {
    i.keyEquivalent = k
    i.keyEquivalentModifierMask = mask
    return i
  }
}
