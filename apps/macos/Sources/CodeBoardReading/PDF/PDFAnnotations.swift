import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit

// A PDF tab's highlights and what is written on them: highlighting the selection, a click on a highlight bringing its
// bar (Annotate, Remove), the annotation popup under it (the board's sidenote popup, which the shell makes), and a mark
// at the end of a highlight that has annotations. A highlight made across pages is one Highlight a page in the entry,
// made at the same time: they are clicked, annotated and removed together.

extension PDFTabView {
  /// A yellow highlight on each page of the selection, in the entry's file (a file alone becomes an entry first);
  /// one already there for the same text and colour is not added again
  func highlight() {
    guard let s = pdf.currentSelection, selectedText != nil else { return }
    let now = Self.now
    func marks(_ version: VersionID) -> [Highlight] {
      places(s, version: version).map {
        Highlight(id: Board.newID("h"), place: $0, color: .yellow, at: now)
      }
    }
    let fileAlone = if case .file? = target { true } else { false }
    guard let (e0, path, version) = madeEntry(highlights: marks), !fileAlone else { return }
    var e = e0
    let new = marks(version).filter { h in !e.highlights.contains { $0.place == h.place && $0.color == h.color } }
    guard !new.isEmpty else { return }
    e.highlights += new
    write(e, at: path)
  }

  /// The entry's highlights on this version drawn again, a mark at the end of each that has annotations
  func draw(_ entry: Entry) {
    for (page, a) in drawn { page.removeAnnotation(a) }
    drawn = []
    guard case .entry(_, let version)? = target, pdf.document != nil else { return }
    for group in PDFPlaces.groups(entry.highlights) where group[0].place.version == version {
      var last: (PDFPage, PDFAnnotation)?
      for h in group {
        for (page, a) in PDFPlaces.annotations(h, on: selection([h.place])) {
          page.addAnnotation(a)
          drawn.append((page, a))
          last = (page, a)
        }
      }
      if let (page, a) = last, !notes(of: group, in: entry).isEmpty {
        let m = PDFPlaces.mark(after: a.bounds, on: page, group[0].color, id: group[0].id)
        page.addAnnotation(m)
        drawn.append((page, m))
      }
    }
  }

  /// The annotations on a highlight's places
  func notes(of group: [Highlight], in entry: Entry) -> [EntrySidenote] {
    entry.sidenotes.filter { n in group.contains { $0.place == n.place } }
  }

  /// The highlights made together drawn under a point of the PDF view (or its mark)
  func highlight(at point: CGPoint) -> [Highlight]? {
    guard let entry, let page = pdf.page(for: point, nearest: false),
      let id = PDFPlaces.highlight(at: pdf.convert(point, to: page), on: page)
    else { return nil }
    return PDFPlaces.groups(entry.highlights).first { $0.contains { $0.id == id } }
  }

  /// A highlight's lines in this view
  func lines(of group: [Highlight]) -> [(PDFPage, CGRect)] {
    let ids = Set(group.map(\.id))
    return inView(
      drawn.filter { $0.1.type == "Highlight" && ids.contains($0.1.userName ?? "") }.map { ($0.0, $0.1.bounds) })
  }

  /// A click on a highlight: its bar over it, and its annotations under it when it has some
  func showHighlight(_ group: [Highlight]) {
    shownHighlight = group
    show(highlightBar, over: lines(of: group))
    if let entry, !notes(of: group, in: entry).isEmpty { openPop() }
  }

  /// Annotate: the popup under the highlight, ready to write
  func annotate() { openPop(write: true) }

  /// Remove: the highlights made together go from the entry, with what was written on them
  func removeShown() {
    let group = shownHighlight
    guard !group.isEmpty, let (e0, path, _) = madeEntry() else { return }
    var e = e0
    let ids = Set(group.map(\.id))
    let gone = notes(of: group, in: e).map(\.id)
    e.highlights.removeAll { ids.contains($0.id) }
    e.sidenotes.removeAll { gone.contains($0.id) }
    dismiss()
    write(e, at: path)
  }

  /// The popup for the shown highlight (the board's sidenote popup), below its last line (above its first when there
  /// is no room for it with one more note), with its annotations; opened to write: its input has the keys
  func openPop(write: Bool = false) {
    guard let entry, !shownHighlight.isEmpty, let path = entryPath, let vault = context.pane.vault else { return }
    if pop == nil {
      guard let make = context.pane.makePop else { return }
      let p = make({ [weak self] in self?.popAction($0) }, { [weak self] in self?.placePop() })
      // over the window, where no pane clips it (in a narrow pane it reaches over the board); the keys it does not
      // take come to this tab
      let host = window?.contentView ?? self
      host.addSubview(p.view, positioned: .above, relativeTo: nil)
      p.view.nextResponder = self
      pop = p
    }
    // it offers what the bar does: its input, and Remove Highlight in its title bar
    unpin(highlightBar)
    let ls = lines(of: shownHighlight)
    let pages = Set(ls.compactMap { pdf.document?.index(for: $0.0) }).map { $0 + 1 }.sorted()
    let range = label(shownHighlight.map(\.place), pages: pages)
    let shown = AnnotationPop.Shown(
      title: title, range: range, notes: notes(of: shownHighlight, in: entry), write: write,
      folder: vault.url(of: path), look: context.bar, maxHeight: max(120, min(560, floatArea.height - 16)))
    pop?.show(shown)
    placePop()
    if write { pop?.focus() }
  }

  /// The popup beside the shown highlight's lines; the side is chosen once, with room for one more note, and kept: a
  /// note added grows it away from the highlight. In a tab too narrow for it, its right edge is the tab's and it
  /// reaches left over the board, inside the window
  func placePop() {
    guard let p = pop else { return }
    let ls = lines(of: shownHighlight)
    guard let first = ls.min(by: { $0.1.minY < $1.1.minY }) else { return }
    let size = p.size()
    let area = floatArea
    let below =
      p.below ?? AnnotationPop.below(height: size.height + AnnotationPop.oneMoreNote, lines: ls.map(\.1), visible: area)
    pop?.below = below
    var o = AnnotationPop.origin(size: size, lines: ls.map(\.1), visible: area, below: below)
    if size.width > area.width {
      let room = window?.contentView.map { convert($0.bounds, from: $0) } ?? bounds
      o.x = max(room.minX + Self.popMargin, area.maxX - Self.popMargin - size.width)
    }
    let f = p.frame(o)
    p.view.setFrameSize(f.size)
    pin(p.view, at: f.origin, on: first.0)
  }

  /// How far a popup wider than the tab stays in from the tab's right edge and the window's left
  static let popMargin: CGFloat = 8

  /// The popup closed: what is being written in it is added first
  func closePop() {
    guard let p = pop else { return }
    pop = nil
    p.end()
    unpin(p.view)
    p.view.removeFromSuperview()
  }

  /// What was done in the popup, written to the entry's file
  func popAction(_ a: AnnotationPop.Action) {
    switch a {
    case .add(let text, let ask): addNote(text, ask: ask)
    // written empty it goes, as a board's sidenote does
    case .write(let id, let text) where text.isEmpty: change(id, nil)
    case .write(let id, let text): change(id) { $0.note.text = text }
    case .delete(let id): change(id, nil)
    case .done(let id, let done): change(id) { $0.note.question?.done = done }
    case .answer(let id, let text):
      change(id) { $0.note.question?.answers.append(Question.Answer(id: Board.newID("a"), text: text, at: Self.now)) }
    case .writeAnswer(let id, let answer, let text):
      change(id) { n in
        if text.isEmpty {
          n.note.question?.answers.removeAll { $0.id == answer }
        } else if let i = n.note.question?.answers.firstIndex(where: { $0.id == answer }) {
          n.note.question?.answers[i].text = text
        }
      }
    case .remove: removeShown()
    case .close:
      closePop()
      window?.makeFirstResponder(self)
    }
  }

  /// What was written on the shown highlight, as an annotation at its first place (a question when asked)
  func addNote(_ text: String, ask: Bool) {
    guard let h = shownHighlight.first, let (e0, path, _) = madeEntry() else { return }
    var e = e0
    let question = ask ? Question(at: Self.now) : nil
    e.sidenotes.append(
      EntrySidenote(
        id: SidenoteID(rawValue: Board.newID("n")), place: h.place, note: TextNote(text: text, question: question)))
    write(e, at: path)
    if pop != nil { openPop() }
  }

  /// An annotation changed by `f`, or deleted (nil), in the entry's file
  func change(_ id: SidenoteID, _ f: ((inout EntrySidenote) -> Void)?) {
    guard let (e0, path, _) = madeEntry(), let i = e0.sidenotes.firstIndex(where: { $0.id == id }) else { return }
    var e = e0
    if let f { f(&e.sidenotes[i]) } else { e.sidenotes.remove(at: i) }
    write(e, at: path)
    if pop != nil { openPop() }
  }
}
