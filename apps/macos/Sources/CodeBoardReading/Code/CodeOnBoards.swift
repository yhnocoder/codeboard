import AppKit
import CodeBoardModel

// Where a code tab's lines are on boards: a thin line at the far left of the line numbers, darker for lines on a card of
// the board in front, lighter for lines only on other boards; the cards a line is on listed beside it, and the
// selection's count of them on its bar. Which cards show which lines is the shell's to say (CodeHost.onBoards): it
// reads every board of the vault and follows a card's lines from its commit to the file as shown.

/// A card on a board showing lines of a file
public struct CodeOnBoard: Equatable, Sendable {
  public var board: BoardID
  public var boardName: String
  /// On the board in front
  public var here: Bool
  public var card: CardID
  public var title: String
  /// Its lines in the file as the tab shows it
  public var lines: ClosedRange<Int>
  /// The card's own lines, as its row says them ("25–40")
  public var range: String
  /// The commit the card is from, short, when it is not the one the file is shown at
  public var commit: String?

  public init(
    board: BoardID, boardName: String, here: Bool, card: CardID, title: String, lines: ClosedRange<Int>,
    range: String, commit: String? = nil
  ) {
    self.board = board
    self.boardName = boardName
    self.here = here
    self.card = card
    self.title = title
    self.lines = lines
    self.range = range
    self.commit = commit
  }
}

extension CodeReading {
  /// Posted with the pane as its object when what is on boards may have changed (the board in front, a card added,
  /// removed or changed, a board written by another window): its code tabs ask `CodeHost.onBoards` again
  public static let boardsChanged = Notification.Name("CodeReading.boardsChanged")

  /// The lines marked: on a card of the board in front, and only on other boards
  static func marks(_ on: [CodeOnBoard]) -> (here: Set<Int>, other: Set<Int>) {
    var here = Set<Int>()
    var other = Set<Int>()
    for c in on {
      if c.here { here.formUnion(c.lines) } else { other.formUnion(c.lines) }
    }
    return (here, other.subtracting(here))
  }

  /// Lines as runs of consecutive ones, in order
  static func runs(_ lines: Set<Int>) -> [ClosedRange<Int>] {
    var out: [ClosedRange<Int>] = []
    for l in lines.sorted() {
      if let last = out.last, last.upperBound == l - 1 {
        out[out.count - 1] = last.lowerBound...l
      } else {
        out.append(l...l)
      }
    }
    return out
  }

  /// The cards showing any of `lines`: the board in front's first, then the other boards in the shell's order; on each
  /// board by where their lines start
  static func cards(on lines: ClosedRange<Int>, _ on: [CodeOnBoard]) -> [CodeOnBoard] {
    let hit = on.enumerated().filter { $0.element.lines.overlaps(lines) }
    var boardOrder: [BoardID: Int] = [:]
    for (i, c) in hit where boardOrder[c.board] == nil { boardOrder[c.board] = i }
    return hit.sorted { a, b in
      let (x, y) = (a.element, b.element)
      if x.here != y.here { return x.here }
      if x.board != y.board { return boardOrder[x.board]! < boardOrder[y.board]! }
      return (x.lines.lowerBound, a.offset) < (y.lines.lowerBound, b.offset)
    }.map(\.element)
  }

  /// What a click on the line goes to with no list: the lines are on this one card of the board in front and nowhere
  /// else
  static func straight(_ cards: [CodeOnBoard]) -> CodeOnBoard? {
    cards.count == 1 && cards[0].here ? cards[0] : nil
  }

  /// The list's rows: each board's name (the board in front as This Board), then its cards with their lines; nil for
  /// a board's row
  static func rows(_ cards: [CodeOnBoard]) -> [(item: CodeList.Item, card: CodeOnBoard?)] {
    var out: [(CodeList.Item, CodeOnBoard?)] = []
    var board: BoardID?
    for c in cards {
      if c.board != board {
        board = c.board
        out.append((CodeList.Item(title: c.here ? "This Board" : c.boardName, detail: "", heading: true), nil))
      }
      let detail = [c.range, c.commit.map { "@ \($0)" }].compactMap { $0 }.joined(separator: " ")
      out.append((CodeList.Item(title: c.title, detail: detail), c))
    }
    return out
  }
}

/// The thin lines at the far left of the line numbers, in the page (they scroll with the code, and are drawn again
/// only when the cards change)
final class CodeMarks: NSView {
  let here = CAShapeLayer()
  let other = CAShapeLayer()
  /// Where the line is across the gutter's left padding, and how wide; the pointer is over it within `hit`
  static let x: CGFloat = 5
  static let width: CGFloat = 2.5
  static let hit: CGFloat = 13

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    for l in [other, here] { layer?.addSublayer(l) }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("CodeMarks is not loaded from nibs") }

  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  /// Each run of lines from the top of its first row to the bottom of its last (the code view's space)
  func draw(here h: [ClosedRange<CGFloat>], other o: [ClosedRange<CGFloat>], look: ReadingBarLook) {
    func path(_ spans: [ClosedRange<CGFloat>]) -> CGPath {
      let p = CGMutablePath()
      for s in spans {
        let r = CGRect(
          x: Self.x, y: s.lowerBound + 1.5, width: Self.width, height: max(0, s.upperBound - s.lowerBound - 3))
        p.addRoundedRect(in: r, cornerWidth: Self.width / 2, cornerHeight: Self.width / 2)
      }
      return p
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    here.path = path(h)
    other.path = path(o)
    here.fillColor = look.accent
    other.fillColor = look.accent.copy(alpha: 0.32)
    CATransaction.commit()
  }
}

extension CodeTabView {
  // MARK: Lines on boards

  @objc func boardsChanged(_ note: Notification) { readOnBoards() }

  /// What is on boards asked again for the file as it is shown; an answer for an older asking is dropped
  func readOnBoards() {
    guard let file, let t = text, let host = context.pane.codeHost else { return }
    boardsAsked += 1
    let asked = boardsAsked
    Task { [weak self] in
      let got = await host.onBoards(file, text: t.text)
      guard let self, asked == self.boardsAsked else { return }
      self.onBoards = got
      self.drawMarks()
      if self.listing == .places { self.closeList() }
      if self.barWanted { self.countOnSelection() }
    }
  }

  func drawMarks() {
    guard let v = code else { return }
    let (here, other) = CodeReading.marks(onBoards)
    func spans(_ ls: Set<Int>) -> [ClosedRange<CGFloat>] {
      CodeReading.runs(ls).compactMap { v.frame(ofLines: $0).map { $0.rect.minY...$0.rect.maxY } }
    }
    marks.frame = CGRect(x: 0, y: 0, width: CodeMarks.hit, height: v.height)
    marks.draw(here: spans(here), other: spans(other), look: context.bar)
  }

  /// The marked line whose thin line is under a point of this view; nil off it
  func markedLine(at p: CGPoint) -> Int? {
    guard let v = code, let t = text, floatArea.contains(p), scroll.frame.contains(p),
      list.isHidden || !list.frame.contains(p)
    else { return nil }
    let q = v.convert(p, from: self)
    guard q.x >= 0, q.x < CodeMarks.hit, q.y >= v.look.padTop, q.y < v.height - v.look.padBottom else { return nil }
    let line = t.place(v.layout.offset(at: q).offset).line
    return onBoards.contains { $0.lines.contains(line) } ? line : nil
  }

  /// The pointer over a marked line's thin line: the cards it is on listed beside it, unless a click goes straight
  /// to its one card; off it and off the list, a list it opened closes
  func hoverMarks(at p: CGPoint?) -> Bool {
    if let p, let line = markedLine(at: p) {
      let cs = CodeReading.cards(on: line...line, onBoards)
      if CodeReading.straight(cs) == nil, listing != .places || placesLine != line {
        showPlaces(cs, at: line, pinned: false)
      }
      NSCursor.pointingHand.set()
      return true
    }
    if listing == .places, !placesPinned, !(p.map { list.frame.contains($0) } ?? false) { closeList() }
    return false
  }

  /// A click on a marked line's thin line: straight to its one card of the board in front, else its cards listed
  func clickMark(_ line: Int) {
    let cs = CodeReading.cards(on: line...line, onBoards)
    if let c = CodeReading.straight(cs) { return context.pane.codeHost?.go(to: c) ?? () }
    showPlaces(cs, at: line, pinned: true)
  }

  /// The cards listed: beside a line's thin line, or under the selection's bar
  func showPlaces(_ cs: [CodeOnBoard], at line: Int?, pinned: Bool) {
    closeList()
    let rows = CodeReading.rows(cs)
    guard !rows.isEmpty else { return }
    placesShown = rows.map(\.card)
    placesLine = line
    placesPinned = pinned
    if let line, let v = code, let r = v.frame(ofLines: line...line)?.first {
      let row = convert(r, from: v)
      offeredAt = CGRect(
        x: convert(CGPoint(x: CodeMarks.hit, y: 0), from: v).x, y: row.minY, width: 0, height: row.height)
    } else {
      offeredAt = selectionBar.frame
    }
    listing = .places
    list.show(rows.map(\.item), bottomUp: false, id: "ui-codeplaces")
    if pinned { list.select(rows.firstIndex { $0.card != nil }) }
    needsLayout = true
    layoutSubtreeIfNeeded()
  }

  /// The cards showing the selection's lines: their number on its bar, beside Add to Board; none, no number
  func countOnSelection() {
    let b = selectionBar.buttons[1]
    let n = selectionPick.map { CodeReading.cards(on: $0.lines, onBoards).count } ?? 0
    b.isHidden = n == 0
    b.title = "\(n)"
    b.toolTip = n == 1 ? "On 1 card: show where" : "On \(n) cards: show where"
    b.setAccessibilityLabel(b.toolTip)
    placeFloats()
  }

  func showSelectionPlaces() {
    guard let p = selectionPick else { return }
    showPlaces(CodeReading.cards(on: p.lines, onBoards), at: nil, pinned: true)
  }

  /// Where the cards' list goes: right of the thin lines from the line's top, or under the selection's bar; with no
  /// room below, up to the line's bottom (the pointer still goes straight into it), or over the bar
  func placePlaces() {
    let b = barFrame(shown: true)
    let w = min(bounds.width - 16, 340)
    let beside = placesLine != nil
    let top = beside ? offeredAt.minY - 4 : offeredAt.maxY + 4
    let room = b.minY - 6 - Self.topInset
    let h = min(list.height, max(0, room))
    var y = top
    if y + h > b.minY - 6 { y = beside ? offeredAt.maxY + 4 - h : offeredAt.minY - 4 - h }
    let x = beside ? offeredAt.minX + 2 : offeredAt.minX
    list.frame = CGRect(x: max(8, min(x, bounds.width - 8 - w)), y: max(Self.topInset, y), width: w, height: h)
  }

  // MARK: Opened at a card's lines

  /// A card's lines brought into view in the tab and marked a moment, now or once the file is read; `note`: a quiet
  /// line on the bar (the commit the card is from)
  static func locate(_ lines: ClosedRange<Int>?, note: String?, in tab: ReadingTab.ID) {
    if let v = live[tab]?.view {
      v.locate(lines, note: note)
    } else {
      pendingLocate[tab] = (lines, note)
    }
  }

  func locate(_ lines: ClosedRange<Int>?, note: String?) {
    bar.note = note ?? ""
    guard let lines else { return }
    let top = max(1, lines.lowerBound - 3)
    guard code != nil else {
      pending = top
      flashWanted = lines
      return
    }
    if let here, topLine != top { CodePlaces.of(context.pane).places.jumped(from: here) }
    go(to: top)
    historyChanged()
    flash(lines)
  }

  /// Behind the lines, under the code: shown, held, faded (no layout of the code)
  func flash(_ lines: ClosedRange<Int>) {
    guard let code, let r = code.frame(ofLines: lines)?.rect else { return }
    flashView.frame = CGRect(x: 0, y: r.minY, width: page.bounds.width, height: r.height)
    flashed = lines
    flashView.layer?.backgroundColor = context.bar.accent.copy(alpha: 0.13)
    let a = CAKeyframeAnimation(keyPath: "opacity")
    a.values = [0, 1, 1, 0]
    a.keyTimes = [0, 0.08, 0.6, 1]
    a.duration = 1.8
    flashView.layer?.opacity = 0
    flashView.layer?.add(a, forKey: "flash")
  }
}
