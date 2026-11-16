import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardReading
import CodeBoardResources

extension Shell {
  /// A reading tab's annotation popup: the board's sidenote popup, showing an entry's sidenotes as a card's. They are
  /// text and questions on no lines of code and on no board: no code search, Always Show, Place on Board or [[ list
  static func annotationPop(
    act: @escaping @MainActor (AnnotationPop.Action) -> Void, resized: @escaping @MainActor () -> Void
  ) -> AnnotationPop {
    let pop = SidenotePop()
    // one key while it is open: shown again, it is updated in place, what is being written kept; opened to write
    // (Annotate) it is shown afresh with its input
    var key = ""
    pop.onSize = { _ in resized() }
    pop.onAction = { a in
      let id = { SidenoteID(rawValue: $0) }
      switch a {
      case .add(let text, let ask): act(.add(text, ask: ask))
      case .write(let n, let text): act(.write(id(n), text))
      case .delete(let n): act(.delete(id(n)))
      case .done(let n, let done): act(.done(id(n), done))
      case .answer(let n, let text): act(.answer(id(n), text))
      case .writeAnswer(let n, let answer, let text): act(.writeAnswer(id(n), answer: answer, text))
      case .remove: act(.remove)
      case .close: act(.close)
      // as the canvas opens a link in a sidenote
      case .openLink(let s):
        if let u = URL(string: s), ["http", "https", "mailto"].contains(u.scheme?.lowercased() ?? "") {
          NSWorkspace.shared.open(u)
        }
      case .addCode, .place, .alwaysShow, .reviewed, .picked, .ref, .elsewhere: break
      }
    }
    return AnnotationPop(
      view: pop.view, size: { pop.size }, frame: { pop.frame(popupAt: $0, flipped: true) },
      show: { s in
        if s.write || key.isEmpty { key = UUID().uuidString }
        pop.show(shown(s, key: key), maxHeight: s.maxHeight)
        pop.view.alphaValue = 1
      },
      focus: { pop.focus() },
      end: {
        pop.end()
        pop.clear()
      })
  }

  /// What the sidenote popup shows of a passage's annotations, in the look the reading pane is in
  static func shown(_ s: AnnotationPop.Shown, key: String) -> SidenotePop.Shown {
    let look = s.look
    let theme = Theme.named(look == .inkWash(dark: look.dark) ? .inkWash : .warmInk, dark: look.dark)
    let notes = s.notes.map { n in
      let q = n.note.question.map { q in
        SidenotePop.Shown.Ask(done: q.done, answers: q.answers.map { .init(id: $0.id, md: $0.text) })
      }
      return SidenotePop.Shown.Note(id: n.id.rawValue, body: .text(n.note.text, q: q, lines: false, always: false))
    }
    return SidenotePop.Shown(
      key: key, theme: theme, range: s.range, title: s.title, remove: "Remove Highlight", notes: notes,
      write: s.write, folder: s.folder)
  }
}
