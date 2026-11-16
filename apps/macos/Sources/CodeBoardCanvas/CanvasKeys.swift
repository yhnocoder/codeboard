import AppKit
import CodeBoardDiagnostics
import CodeBoardModel

// The board's keys (the web board's keymap.ts KEYMAP, in its order: the first row that matches and applies takes the
// key). Keys the app menu shows (Undo, Redo, Cut, Copy, Paste, Duplicate, Select All, Lock, Back, Forward) are its items;
// these are the rest. Letters match what the key types (e.key), keys with ⌥ and digits and brackets the key itself
// (e.code), as there.

/// A key of the board (keymap.ts Bind): what presses it, how the shortcut list shows it, what it does and its group. A
/// row with no action is a gesture, only shown
struct BoardKey {
  enum Action {
    case newNote, newText, newBox, addSidenote, fitWindow, fitSelection, zoom100, zoomIn, zoomOut, pan, open
    case enterBoard, delete, deleteEverywhere, turnIntoBoard, fitContent, tidyUp, tilt, shelve, wrap, nudge, hide
    case escape, help
  }

  /// A press: its modifiers, and what it types (letters and symbols, as e.key) or else the key itself (e.code)
  struct Press {
    var mods: NSEvent.ModifierFlags = []
    var char: String?
    var code: UInt16?

    func matches(_ m: NSEvent.ModifierFlags, _ key: String, _ keyCode: UInt16) -> Bool {
      guard let char else { return m == mods && keyCode == code }
      // a symbol (? !): Shift is what types it, not compared
      let symbol = !char.allSatisfy { $0.isLetter || $0.isNumber }
      return key == char && (symbol ? m.subtracting(.shift) == mods.subtracting(.shift) : m == mods)
    }
  }

  var action: Action?
  var presses: [Press] = []
  var show: String
  var label: String
  var group: String

  static func char(_ c: String, _ m: NSEvent.ModifierFlags = []) -> Press { Press(mods: m, char: c) }
  static func code(_ c: UInt16, _ m: NSEvent.ModifierFlags = []) -> Press { Press(mods: m, code: c) }

  static let groups = ["Create", "View", "Cards", "Code", "Board"]

  /// The key a row with this label shows (keymap.ts kbd: its first)
  static func show(of label: String) -> String? { all.first { $0.label == label }?.show }

  /// In keymap.ts's order, groups and words, the rows the app has: the first row that matches and applies takes the key.
  /// The rows with no action are shown only: gestures, and the keys the app menu answers (Mac-only ones among them:
  /// tabs, the sidebar, the vault), which CodeBoardShellTests holds to the menu
  static let all: [BoardKey] = [
    BoardKey(action: .newNote, presses: [char("n")], show: "N", label: "New Note", group: "Create"),
    BoardKey(action: .newText, presses: [char("t")], show: "T", label: "New Text", group: "Create"),
    BoardKey(action: .newBox, presses: [char("r")], show: "R", label: "New Box", group: "Create"),
    BoardKey(show: "Double-click empty space", label: "New Text", group: "Create"),
    BoardKey(action: .addSidenote, presses: [char("s")], show: "S", label: "Add Sidenote", group: "Create"),
    BoardKey(show: "⌘V", label: "Paste code, link or image", group: "Create"),
    BoardKey(show: "⌥⌘V", label: "Paste as Copy", group: "Create"),
    BoardKey(show: "⌘K", label: "Search", group: "View"),
    BoardKey(show: "⌘F", label: "Search This Board", group: "View"),
    BoardKey(show: "⌘L", label: "Open Location", group: "View"),
    BoardKey(action: .fitWindow, presses: [code(18, .shift)], show: "⇧1", label: "Fit to Window", group: "View"),
    BoardKey(action: .fitSelection, presses: [code(19, .shift)], show: "⇧2", label: "Fit Selection", group: "View"),
    BoardKey(action: .fitWindow, presses: [code(29, .command)], show: "⌘0", label: "Fit All", group: "View"),
    BoardKey(action: .zoom100, presses: [code(18, .command)], show: "⌘1", label: "Zoom to 100%", group: "View"),
    BoardKey(show: "⌃- / ⌘[", label: "Back after a jump", group: "View"),
    BoardKey(show: "⌃⇧- / ⌘]", label: "Forward after a jump", group: "View"),
    BoardKey(
      action: .zoomIn, presses: [code(24, .command), code(24, [.command, .shift])], show: "⌘+", label: "Zoom In",
      group: "View"),
    BoardKey(action: .zoomOut, presses: [code(27, .command)], show: "⌘−", label: "Zoom Out", group: "View"),
    BoardKey(show: "⌘ + scroll / pinch", label: "Zoom", group: "View"),
    BoardKey(action: .pan, presses: [code(49)], show: "Space + drag / two fingers", label: "Pan", group: "View"),
    BoardKey(show: "⌃⌘S", label: "Hide Sidebar", group: "View"),
    BoardKey(show: "⌃⌘R", label: "Show Reading Pane", group: "View"),
    BoardKey(show: "⇧⌘[ / ⌃⇧⇥", label: "Show Previous Tab", group: "View"),
    BoardKey(show: "⇧⌘] / ⌃⇥", label: "Show Next Tab", group: "View"),
    BoardKey(show: "⌃⌘F", label: "Enter Full Screen", group: "View"),
    BoardKey(show: "Drag empty space", label: "Select with a box", group: "Cards"),
    BoardKey(show: "⌘A", label: "Select All", group: "Cards"),
    BoardKey(show: "Drag title bar", label: "Move", group: "Cards"),
    BoardKey(
      action: .open, presses: [code(36), code(76)], show: "↵",
      label: "Open the card selected (an arrow alone: its label)", group: "Cards"),
    BoardKey(
      action: .enterBoard, presses: [code(36, .command), code(76, .command)], show: "⌘↵",
      label: "Open the selected board frame", group: "Cards"),
    BoardKey(show: "⌘D", label: "Duplicate", group: "Cards"),
    // not ⇧⌘] / ⇧⌘[: the system's tab keys here
    BoardKey(show: "⌥⇧⌘F", label: "Bring to Front", group: "Cards"),
    BoardKey(show: "⌥⇧⌘B", label: "Send to Back", group: "Cards"),
    BoardKey(show: "⌘X", label: "Cut", group: "Cards"),
    BoardKey(show: "⌘C", label: "Copy", group: "Cards"),
    BoardKey(action: .delete, presses: [code(51), code(117)], show: "⌫", label: "Delete", group: "Cards"),
    BoardKey(
      action: .deleteEverywhere, presses: [code(51, .command), code(117, .command)], show: "⌘⌫",
      label: "Delete Everywhere (linked card)", group: "Cards"),
    BoardKey(show: "⇧⌘L", label: "Lock / Unlock", group: "Cards"),
    BoardKey(
      action: .turnIntoBoard, presses: [char("b", [.command, .shift])], show: "⇧⌘B", label: "Turn into Board",
      group: "Cards"),
    BoardKey(action: .fitContent, presses: [code(3, .option)], show: "⌥F", label: "Fit Content", group: "Cards"),
    BoardKey(action: .tidyUp, presses: [code(17, .option)], show: "⌥T", label: "Tidy Up", group: "Cards"),
    BoardKey(action: .tilt, presses: [code(17, [.option, .shift])], show: "⌥⇧T", label: "Tilt", group: "Cards"),
    BoardKey(action: .shelve, presses: [code(1, .option)], show: "⌥S", label: "Move to Shelf", group: "Cards"),
    BoardKey(action: .wrap, presses: [code(6, .option)], show: "⌥Z", label: "Wrap Lines", group: "Cards"),
    BoardKey(
      action: .nudge, presses: [123, 124, 125, 126].flatMap { [code($0), code($0, .shift)] }, show: "Arrows",
      label: "Nudge (⇧ = 10px on screen)", group: "Cards"),
    BoardKey(show: "Click line numbers", label: "Select lines (⇧ extends)", group: "Code"),
    BoardKey(action: .hide, presses: [char("h")], show: "H", label: "Hide lines", group: "Code"),
    BoardKey(show: "⌘Z", label: "Undo", group: "Board"),
    BoardKey(show: "⇧⌘Z", label: "Redo", group: "Board"),
    BoardKey(show: "⌘,", label: "Settings", group: "Board"),
    BoardKey(action: .help, presses: [char("?")], show: "?", label: "Keyboard Shortcuts", group: "Board"),
    BoardKey(
      action: .escape, presses: [code(53)], show: "Esc", label: "Cancel · Deselect · Back to the parent board",
      group: "Board"),
    BoardKey(show: "⌘O", label: "Open Vault…", group: "Board"),
    BoardKey(show: "⇧⌘I", label: "Import Old Boards…", group: "Board"),
    BoardKey(show: "⌘W", label: "Close Tab", group: "Board"),
    BoardKey(show: "⇧⌘W", label: "Close Window", group: "Board"),
  ]
}

extension CanvasView {
  /// A key the board answers, with or without ⌘ / ⌃; whether it did
  func boardKey(_ e: NSEvent) -> Bool {
    guard document != nil else { return false }
    let mods = e.modifierFlags.intersection([.command, .control, .option, .shift])
    let key = e.charactersIgnoringModifiers?.lowercased() ?? ""
    for k in BoardKey.all where k.presses.contains(where: { $0.matches(mods, key, e.keyCode) }) {
      if let a = k.action, run(a, e) { return true }
    }
    return false
  }

  /// A key's action; whether it applied (when not, a later row may take the key)
  private func run(_ a: BoardKey.Action, _ e: NSEvent) -> Bool {
    guard let doc = document else { return false }
    let cards = doc.selection.compactMap(\.card)
    switch a {
    case .newNote: newWriting(.note)
    case .newText: newWriting(.text(.text))
    case .newBox: newWriting(.text(.box))
    case .addSidenote: addSidenoteFromKey()
    case .fitWindow: fitAll()
    case .fitSelection: fitSelection()
    case .zoom100: zoom(by: 1 / zoomTarget.zoom)
    case .zoomIn: zoom(by: 1.25)
    case .zoomOut: zoom(by: 0.8)
    case .pan: holdSpace(e)
    case .open:
      // an arrow alone, its label; else the first card selected opens
      if doc.selection.count == 1, let a = doc.selection.first?.arrow { editLabel(a) } else { return open(cards) }
    case .enterBoard:
      guard let c = cards.first, case .board? = scene?.parts[c]?.content.body else { return false }
      openSubBoard(c)
    case .delete: delete(nil)
    case .deleteEverywhere:
      guard !cards.isEmpty else { return false }
      deleteEverywhere(cards)
    case .turnIntoBoard: turnIntoBoard(nil)
    case .fitContent: fitContentKey()
    case .tidyUp:
      guard canTidyUp else { return false }
      tidyUp()
    case .tilt:
      guard !cards.isEmpty else { return false }
      tilt(nil)
    case .shelve:
      guard !doc.selection.isEmpty else { return false }
      moveToShelf(nil)
    case .wrap: toggleWrap(cards)
    case .nudge:
      guard !cards.isEmpty else { return false }
      nudge(e)
    case .hide:
      guard let l = lineSel else { return false }
      hideLines(l)
    case .help: toggleKeys()
    case .escape: escape()
    }
    return true
  }

  /// N, T, R: a new Note, Text or Box with its top left at the pointer (create.ts newWriting at atPointer()), in the
  /// middle of the view when the pointer is not over the board
  private func newWriting(_ kind: Board.Writing) {
    guard let p = pointerOnBoard else { return createInView(kind) }
    editSoon { await self.create(kind, at: p) }
  }

  /// The pointer on the board, while it is over the view
  var pointerOnBoard: CGPoint? {
    guard let w = pointerInWindow ?? window?.mouseLocationOutsideOfEventStream else { return nil }
    let v = convert(w, from: nil)
    return bounds.contains(v) ? camera.board(v) : nil
  }

  /// Return on a card (keymap.ts open): a Note, Text or Box is written in, a Web card's page opens, a sub-board opens
  private func open(_ cards: [CardID]) -> Bool {
    guard let c = cards.first, let doc = document else { return false }
    if isWriting(c) {
      beginEditing(c)
    } else if case .own(let k)? = doc.board.card(c)?.content, case .web(let w) = k.body {
      openLink(w.url)
    } else if !openSubBoard(c) {
      return false
    }
    return true
  }

  /// Esc: a ref's preview, the mode, else the popup, else the selection, else back to the parent board
  private func escape() {
    if keysPanel != nil { return toggleKeys() }
    if refPeek != nil { return closeRefPeek() }
    if placing != nil { return cancelPlacing() }
    if stickerPalette != nil { return closeStickerPalette() }
    if previewing != nil { return closePreview() }
    if cancelMode() { return }
    if openPop != nil { return openPop(nil) }
    if lineSel != nil { return clearLineSel() }
    // over a sub-board with nothing selected: back to the parent board (subboards.ts canLeave)
    if gesture == nil, !crumbs.isEmpty, document?.selection.isEmpty == true { return leaveBoard() }
    if gesture == nil { document?.select([]) }
  }

  /// H (keymap.ts hide, core hideLines): the lines selected hidden; hidden runs they overlap or touch merge into one,
  /// in line order
  func hideLines(_ l: Lines) {
    editCode(l.card, "Hide Lines") { c in
      guard let i = c.segments.firstIndex(where: { $0.id == l.segment }) else { return }
      var r = l.range
      var keep: [ClosedRange<Int>] = []
      for h in c.segments[i].hidden {
        if h.upperBound < r.lowerBound - 1 || h.lowerBound > r.upperBound + 1 {
          keep.append(h)
        } else {
          r = min(h.lowerBound, r.lowerBound)...max(h.upperBound, r.upperBound)
        }
      }
      c.segments[i].hidden = (keep + [r]).sorted { $0.lowerBound < $1.lowerBound }
    }
    clearLineSel()
  }

  /// ⌥F (keymap.ts fitContent): the card under the pointer, else the cards selected fit their content; else the
  /// Sections selected fit what is in them
  private func fitContentKey() {
    guard let doc = document else { return }
    if let p = pointerOnBoard, let id = hitCard(p) { return fitCards([id]) }
    let cards = doc.selection.compactMap(\.card)
    if !cards.isEmpty { return fitCards(cards) }
    let fit = fittable(doc.selection.compactMap(\.section))
    if !fit.isEmpty { fitContent(fit) }
  }

  /// Fit Content of cards (actions/common.ts fitContent, core fitCardSizes): a code card as wide as its longest line
  /// shown (240 to 1600), its height stored only when its code is taller than a card grows to by itself; an image as
  /// wide as its picture; a Note's and a Web card's height follows their content. Text, Box and sub-board cards are as
  /// they are. One step
  func fitCards(_ ids: [CardID]) {
    guard let doc = document, let s = scene else { return }
    let m = theme.metrics
    var sizes: [(CardID, width: Double, height: Double?)] = []
    for id in ids {
      guard let c = doc.board.card(id), let body = s.parts[id]?.content.body else { continue }
      switch body {
      case .code(let code):
        // laid out without wrapping: its longest line
        let wide = CodeLayout(code, width: 1_000_000, metrics: m)
        var longest = 12
        for p in wide.rows {
          if case .line(_, _, let text, _) = p.row {
            longest = max(longest, text.count - text.reversed().prefix(while: \.isWhitespace).count)
          }
        }
        let w = min(
          1600, max(240, (wide.gutter + wide.shift + CGFloat(longest) * m.charWidth + m.padRight).rounded(.up)))
        // with its Always Show sidenotes as tall as they were measured (at the width it had)
        let h = CodeLayout(code, width: w, metrics: m, always: s.parts[id]?.always ?? []).height
        sizes.append((id, Double(w), h > m.maxAutoHeight ? Double(h) : nil))
      case .image(let img):
        guard case .file(let f) = img.source, let folder = imagesFolder,
          let px = DecodeCache.pixelSize(folder.appending(path: f))
        else { continue }
        sizes.append((id, Double(min(1600, max(240, px.width))), nil))
      case .note, .web: sizes.append((id, c.width, nil))
      default: continue
      }
    }
    let change = sizes.filter { id, w, h in doc.board.card(id).map { $0.width != w || $0.height != h } ?? false }
    guard !change.isEmpty else { return }
    doc.edit("Fit Content") { b in
      for (id, w, h) in change {
        guard let c = b.card(id) else { continue }
        b.resize(id, x: c.x, y: c.y, width: w, height: h)
      }
    }
  }

  /// ⌥Z, Wrap Lines (commands/code.ts toggleWrap): the code cards selected wrap, or all stop when all do
  func toggleWrap(_ ids: [CardID]) {
    guard let doc = document else { return }
    func code(_ c: Card) -> CodeCard? {
      if case .own(let k) = c.content, case .code(let code) = k.body { code } else { nil }
    }
    let cs = Set(ids.filter { doc.board.card($0).flatMap(code) != nil })
    guard !cs.isEmpty else { return }
    let on = !cs.allSatisfy { doc.board.card($0).flatMap(code)?.wrap == true }
    doc.edit("Wrap Lines") { b in
      for i in b.cards.indices where cs.contains(b.cards[i].id) {
        guard case .own(var k) = b.cards[i].content, case .code(var c) = k.body else { continue }
        c.wrap = on
        k.body = .code(c)
        b.cards[i].content = .own(k)
      }
    }
  }

  // MARK: The camera

  /// Where the camera is going: a move under way counts as there (camera.ts camTarget)
  var zoomTarget: Camera {
    if case .fly(let f) = motion.phase { f.to } else { camera }
  }

  /// ⌘= / ⌘+, ⌘-, ⌘1: the zoom times `f` about the middle of the view, eased (camera.ts zoomAt)
  func zoom(by f: CGFloat) {
    Diag.event("zoom.key", ["by": "\(f)"])
    var c = zoomTarget
    let mid = CGPoint(x: bounds.midX, y: bounds.midY)
    c.zoom(to: limits.clamp(c.zoom * f), at: mid)
    motion.fly(to: c)
    moved()
  }

  /// ⇧1, ⌘0, Fit to Window (common.ts fitAll): everything on the board in view, at most 100 %; an empty board at 100 %
  /// with its origin 80 in
  public func fitAll() {
    guard let r = scene?.bounds, !r.isNull, !r.isEmpty else {
      motion.fly(to: Camera(origin: CGPoint(x: -80, y: -80), zoom: 1))
      return moved()
    }
    motion.fly(to: fitRect(r, maxZoom: 1))
    moved()
  }

  /// ⇧2, Fit Selection (common.ts fitSelection): the cards selected in view, at most 140 %; nothing selected, all
  func fitSelection() {
    let ids = Set(document?.selection.compactMap(\.card) ?? [])
    let rs = (scene?.items ?? []).filter { if case .card(let c)? = $0.owner { ids.contains(c) } else { false } }.map(
      \.rect)
    guard let first = rs.first else { return fitAll() }
    motion.fly(to: fitRect(rs.dropFirst().reduce(first) { $0.union($1) }, maxZoom: 1.4))
    moved()
  }
}

// MARK: Space + drag (keymap.ts pan, interact.ts startPan)

extension CanvasView {
  /// Space held: a drag anywhere on the board, cards and Sections too, pans it
  func holdSpace(_ e: NSEvent) {
    guard !e.isARepeat else { return }
    spaceHeld = true
    if spacePan == nil { NSCursor.openHand.set() }
  }

  func releaseSpace() {
    spaceHeld = false
    if spacePan == nil { NSCursor.arrow.set() }
  }

  @objc func windowResignedKey() {
    releaseSpace()
    stopNudge()
  }

  /// A press with Space held starts a pan: the board follows the pointer as it does two fingers, and glides on from
  /// how fast it went when let go
  func spacePanDown(_ e: NSEvent) -> Bool {
    guard spaceHeld, document != nil else { return false }
    spacePan = convert(e.locationInWindow, from: nil)
    NSCursor.closedHand.set()
    scroll(by: .zero, at: e.timestamp, began: true, ended: false)
    return true
  }

  func spacePanDragged(_ e: NSEvent) -> Bool {
    guard let last = spacePan else { return false }
    let v = convert(e.locationInWindow, from: nil)
    spacePan = v
    scroll(by: CGVector(dx: v.x - last.x, dy: v.y - last.y), at: e.timestamp, began: false, ended: false)
    return true
  }

  func spacePanUp(_ e: NSEvent) -> Bool {
    guard spacePan != nil else { return false }
    _ = spacePanDragged(e)
    spacePan = nil
    scroll(by: .zero, at: e.timestamp, began: false, ended: true)
    (spaceHeld ? NSCursor.openHand : NSCursor.arrow).set()
    return true
  }
}
