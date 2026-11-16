import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit

// A PDF tab's highlights and what is written on them: highlighting the selection, a click on a highlight bringing its
// bar (Annotate, Remove), the annotation popup under it, and a mark at the end of a highlight that has annotations.
// A highlight made across pages is one Highlight a page in the entry, made at the same time: they are clicked,
// annotated and removed together.

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
        let m = PDFPlaces.mark(after: a.bounds, group[0].color, id: group[0].id)
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
  func annotate() {
    openPop()
    window?.makeFirstResponder(pop?.input)
  }

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

  /// The popup for the shown highlight, below its last line (above its first when there is no room), with its
  /// annotations
  func openPop() {
    guard let entry, !shownHighlight.isEmpty else { return }
    let ls = lines(of: shownHighlight)
    let notes = notes(of: shownHighlight, in: entry).map {
      AnnotationPop.Note(id: $0.id.rawValue, text: $0.note.text, question: $0.note.question != nil)
    }
    let p: AnnotationPop
    if let pop {
      p = pop
      p.notes = notes
    } else {
      p = AnnotationPop(notes: notes, width: min(360, bounds.width - 16), look: context.bar)
      p.onAdd = { [weak self] text, ask in self?.addNote(text, ask: ask) }
      p.onRemove = { [weak self] id in self?.removeNote(SidenoteID(rawValue: id)) }
      p.onClose = { [weak self] in self?.closePop() }
      addSubview(p)
      pop = p
    }
    guard let first = ls.min(by: { $0.1.minY < $1.1.minY }) else { return }
    pin(p, at: AnnotationPop.origin(size: p.size, lines: ls.map(\.1), visible: bounds), on: first.0)
  }

  func closePop() {
    guard let p = pop else { return }
    unpin(p)
    p.removeFromSuperview()
    pop = nil
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
    openPop()
  }

  func removeNote(_ id: SidenoteID) {
    guard let (e0, path, _) = madeEntry() else { return }
    var e = e0
    e.sidenotes.removeAll { $0.id == id }
    write(e, at: path)
    openPop()
  }
}
