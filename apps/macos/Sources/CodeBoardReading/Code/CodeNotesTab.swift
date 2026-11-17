import AppKit
import CodeBoardModel

// A code tab's Highlights and sidenotes: its repository's, the same every board's code cards of those lines show
// (CodeHost.annotations). The selection's bar highlights it or writes a sidenote on it (S too, as on the board); the
// highlighted lines are tinted behind the code, a sidenote's first line has a dot beside the line numbers, and a click
// on the dot opens the sidenotes there in the board's sidenote popup (ReadingPane.makePop), where they are written,
// answered, resolved and deleted, and the Highlight removed.

/// Behind the highlighted lines, in the page under the code (drawn again only when they change)
final class CodeHighlights: NSView {
  let bands = CAShapeLayer()

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.addSublayer(bands)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("CodeHighlights is not loaded from nibs") }

  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func draw(_ spans: [ClosedRange<CGFloat>], width: CGFloat, look: ReadingBarLook) {
    let p = CGMutablePath()
    for s in spans { p.addRect(CGRect(x: 0, y: s.lowerBound, width: width, height: s.upperBound - s.lowerBound)) }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    bands.path = p
    // the board's Highlight band (.hl): the accent, faint
    bands.fillColor = look.accent.copy(alpha: 0.1)
    CATransaction.commit()
  }
}

extension CodeTabView {
  /// Where a sidenote's dot is across the gutter's left padding (right of the thin lines of the cards), and how far
  /// the pointer is over it
  static let noteDotX: CGFloat = 17
  static let noteHit: ClosedRange<CGFloat> = CodeMarks.hit...(CodeMarks.hit + 10)

  // MARK: Reading them

  /// The annotations asked again for the file as it is shown; an answer for an older asking is dropped
  func readAnnotations() {
    guard let file, let t = text, let host = context.pane.codeHost else { return }
    annotationsAsked += 1
    let asked = annotationsAsked
    Task { [weak self] in
      let got = await host.annotations(file, text: t.text)
      guard let self, asked == self.annotationsAsked else { return }
      self.annotations = got
      self.drawAnnotations()
      self.refreshNotePop()
    }
  }

  func drawAnnotations() {
    guard let v = code else { return }
    let ranges = annotations.highlights.map(\.lines) + annotations.notes.map(\.lines)
    let lines = Set(ranges.flatMap { Array($0) })
    let spans = CodeReading.runs(lines).compactMap { v.frame(ofLines: $0).map { $0.rect.minY...$0.rect.maxY } }
    highlightView.frame = CGRect(x: 0, y: 0, width: page.bounds.width, height: v.height)
    highlightView.draw(spans, width: page.bounds.width, look: context.bar)
    let dots = Set(annotations.notes.map(\.lines.lowerBound)).sorted().compactMap { l in
      v.frame(ofLines: l...l).map { $0.rect.midY }
    }
    marks.drawNotes(at: dots, x: Self.noteDotX, look: context.bar)
  }

  /// The line whose sidenote dot is under a point of this view; nil off them
  func noteLine(at p: CGPoint) -> Int? {
    guard let v = code, let t = text, floatArea.contains(p), scroll.frame.contains(p),
      list.isHidden || !list.frame.contains(p)
    else { return nil }
    let q = v.convert(p, from: self)
    guard Self.noteHit.contains(q.x), q.y >= v.look.padTop, q.y < v.height - v.look.padBottom else { return nil }
    let line = t.place(v.layout.offset(at: q).offset).line
    return annotations.notes.contains { $0.lines.lowerBound == line } ? line : nil
  }

  /// The Highlight a line is in, else the lines of the sidenotes there
  func highlight(holding line: Int) -> ClosedRange<Int> {
    let rs = annotations.highlights.map(\.lines) + annotations.notes.map(\.lines)
    let hit = rs.filter { $0.contains(line) }
    guard let lo = hit.map(\.lowerBound).min(), let hi = hit.map(\.upperBound).max() else { return line...line }
    return lo...hi
  }

  // MARK: Writing them

  /// The selection's bar's Highlight: its lines highlighted in the repository's file
  func highlightSelection() {
    guard let file, let p = selectionPick, let host = context.pane.codeHost else { return NSSound.beep() }
    Task {
      if await host.annotate(file, p, note: nil, ask: false) { self.readAnnotations() } else { NSSound.beep() }
    }
  }

  /// The selection's bar's Sidenote, or S: the popup on its lines, ready to write
  func sidenoteSelection() {
    guard let p = selectionPick, context.pane.codeHost != nil else { return NSSound.beep() }
    openNotes(p.lines, write: true)
  }

  /// A click on a sidenote's dot: the sidenotes on its Highlight
  func clickNote(_ line: Int) { openNotes(highlight(holding: line), write: false) }

  /// The popup for these lines (the board's sidenote popup), beside them
  func openNotes(_ lines: ClosedRange<Int>, write: Bool) {
    guard let file else { return }
    if notePop == nil {
      guard let make = context.pane.makePop else { return }
      let p = make({ [weak self] in self?.noteAction($0) }, { [weak self] in self?.placeNotePop() })
      addSubview(p.view, positioned: .above, relativeTo: nil)
      p.view.nextResponder = self
      notePop = p
    }
    popLines = lines
    showNotePop(write: write, file: file)
    if write { notePop?.focus() }
  }

  private func showNotePop(write: Bool, file: CodeFile) {
    guard let lines = popLines else { return }
    let notes = annotations.notes.filter { $0.lines.overlaps(lines) }.map {
      AnnotationPop.Note(id: $0.id, note: $0.note)
    }
    let range = lines.count == 1 ? "\(lines.lowerBound)" : "\(lines.lowerBound)–\(lines.upperBound)"
    notePop?.show(
      AnnotationPop.Shown(
        title: file.title, range: range, notes: notes, write: write,
        folder: URL(filePath: file.repository, directoryHint: .isDirectory), look: context.bar,
        maxHeight: max(120, min(560, floatArea.height - 16))))
    placeNotePop()
  }

  /// The popup shown again with what is there now; gone once nothing is left on its lines
  func refreshNotePop() {
    guard notePop != nil, let file, let lines = popLines else { return }
    let any =
      annotations.notes.contains { $0.lines.overlaps(lines) }
      || annotations.highlights.contains { $0.lines.overlaps(lines) }
    guard any || notePopWriting else { return closeNotePop() }
    showNotePop(write: false, file: file)
  }

  /// A sidenote is being written in the popup (its first one, before it is in the file)
  private var notePopWriting: Bool { (window?.firstResponder as? NSView)?.isDescendant(of: notePop!.view) == true }

  /// Below the lines, else above them, inside the tab
  func placeNotePop() {
    guard let p = notePop, let v = code, let lines = popLines, let r = v.frame(ofLines: lines)?.rect else { return }
    let rect = convert(r, from: v)
    let size = p.size()
    let below =
      p.below ?? AnnotationPop.below(height: size.height + AnnotationPop.oneMoreNote, lines: [rect], visible: floatArea)
    notePop?.below = below
    let f = p.frame(AnnotationPop.origin(size: size, lines: [rect], visible: floatArea, below: below))
    if p.view.frame != f { p.view.frame = f }
  }

  func closeNotePop() {
    guard let p = notePop else { return }
    notePop = nil
    popLines = nil
    let had = (window?.firstResponder as? NSView)?.isDescendant(of: p.view) == true
    p.end()
    p.view.removeFromSuperview()
    if had, !isHiddenOrHasHiddenAncestor { window?.makeFirstResponder(self) }
  }

  /// What was done in the popup, written to the repository's file
  func noteAction(_ a: AnnotationPop.Action) {
    guard let file, let host = context.pane.codeHost, let lines = popLines, let t = text else { return }
    let now = (Date().timeIntervalSince1970 * 1000).rounded()
    func change(_ id: SidenoteID, _ f: @escaping (TextNote) -> TextNote?) {
      Task {
        await host.changeNote(file, id, f)
        self.readAnnotations()
      }
    }
    switch a {
    case .add(let s, let ask):
      Task {
        let pick = CodePick(text: t.text, lines: lines)
        if await host.annotate(file, pick, note: s, ask: ask) { self.readAnnotations() } else { NSSound.beep() }
      }
    // written empty it goes, as a board's sidenote does
    case .write(let id, let s):
      change(id) { n in
        guard !s.isEmpty else { return nil }
        var m = n
        m.text = s
        return m
      }
    case .delete(let id): change(id) { _ in nil }
    case .done(let id, let done):
      change(id) { n in
        var m = n
        m.question?.done = done
        return m
      }
    case .answer(let id, let s):
      change(id) { n in
        var m = n
        m.question?.answers.append(Question.Answer(id: Board.newID("a"), text: s, at: now))
        return m
      }
    case .writeAnswer(let id, let answer, let s):
      change(id) { n in
        var m = n
        if s.isEmpty {
          m.question?.answers.removeAll { $0.id == answer }
        } else if let i = m.question?.answers.firstIndex(where: { $0.id == answer }) {
          m.question?.answers[i].text = s
        }
        return m
      }
    case .remove:
      let hs = Set(
        annotations.highlights.filter { lines.contains($0.lines.lowerBound) && lines.contains($0.lines.upperBound) }
          .map(\.id))
      let ns = Set(
        annotations.notes.filter { lines.contains($0.lines.lowerBound) && lines.contains($0.lines.upperBound) }.map(
          \.id))
      closeNotePop()
      Task {
        await host.remove(file, highlights: hs, notes: ns)
        self.readAnnotations()
      }
    case .close: closeNotePop()
    }
  }
}
