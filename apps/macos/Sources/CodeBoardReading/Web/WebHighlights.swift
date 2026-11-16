import AppKit
import CodeBoardModel
import CodeBoardResources
import WebKit

// Highlights on a page saved whole. They are the entry's (`Entry.highlights`, each at a block of the saved version and
// a range of its text, as a PDF's are), made from the selection and drawn by the app's own script with the CSS Custom
// Highlight API, so that the saved page's own elements are left as they are. A click on one brings a bar with Remove.

extension WebReading {
  /// Draws the highlights it is given, each in its colour and one with something written on it underlined
  /// (`codeboardHighlights.set([{id, block, start, end, text, color, noted}])`: a block's text
  /// nodes in order, without a translation the reader put in it, cut at the offsets; when the text there is not
  /// `text`, where `text` is found in the block) and says which one a click was on (`{id, rect, scrollY}`, else null)
  static let highlightScript = """
    (() => {
      const style = document.createElement("style")
      const colors = { yellow: "255, 212, 0", green: "70, 200, 90", blue: "80, 160, 255", pink: "255, 110, 170",
        purple: "170, 120, 255" }
      style.textContent = Object.entries(colors).map(([name, rgb]) =>
        `::highlight(codeboard-${name}) { background-color: rgba(${rgb}, 0.45) }`).join(" ")
        + " ::highlight(codeboard-noted) { text-decoration: underline 2px rgba(120, 90, 0, 0.8) }"
      let marks = []
      const range = m => {
        const el = document.querySelector(`[data-shiyi-block="${CSS.escape(m.block)}"]`)
        if (!el) return null
        const nodes = []
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n; (n = walk.nextNode()); ) {
          if (!n.parentElement.closest("[data-shiyi-translation]")) nodes.push(n)
        }
        const whole = nodes.map(n => n.data).join("")
        let start = m.start, end = m.end ?? whole.length
        if (m.text != null && whole.slice(start, end) != m.text) {
          const i = whole.indexOf(m.text)
          if (i < 0) return null
          start = i
          end = i + m.text.length
        }
        const at = o => {
          let k = 0
          for (const n of nodes) {
            if (o <= k + n.data.length) return [n, o - k]
            k += n.data.length
          }
          return null
        }
        const a = at(start), b = at(end)
        if (!a || !b) return null
        const r = document.createRange()
        r.setStart(a[0], a[1])
        r.setEnd(b[0], b[1])
        return r
      }
      globalThis.codeboardHighlights = {
        set(list) {
          if (!style.isConnected) document.documentElement.append(style)
          marks = list.map(m => ({ ...m, range: range(m) })).filter(m => m.range)
          for (const name in colors) {
            CSS.highlights.set(`codeboard-${name}`,
              new Highlight(...marks.filter(m => (m.color in colors ? m.color : "yellow") == name).map(m => m.range)))
          }
          CSS.highlights.set("codeboard-noted", new Highlight(...marks.filter(m => m.noted).map(m => m.range)))
          return marks.map(m => m.id)
        }
      }
      addEventListener("click", e => {
        const s = getSelection()
        if (s && !s.isCollapsed) return
        const hit = marks.find(m => [...m.range.getClientRects()].some(r =>
          e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom))
        const r = hit && hit.range.getBoundingClientRect()
        webkit.messageHandlers.highlight.postMessage(
          hit ? { id: hit.id, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, scrollY } : null)
      }, true)
    })()
    """
}

/// Hands the highlight script's messages to the view
final class HighlightRelay: NSObject, WKScriptMessageHandler {
  weak var owner: WebPageView?

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    owner?.highlightClicked(message.body)
  }
}

extension WebPageView {
  /// The entry and saved version this tab shows
  private var shownEntry: (path: String, entry: Entry, version: VersionID)? {
    guard case .saved(let hash, _, _) = page, let (path, e, version) = savedVersion(hash) else { return nil }
    return (path, e, version)
  }

  private static var now: Double { (Date().timeIntervalSince1970 * 1000).rounded() }

  /// The selection highlighted: one highlight for each block it is in, kept in the entry and drawn
  func highlight() {
    guard let s = selection, let (path, e0, version) = shownEntry else { return }
    var e = e0
    let new = s.ranges.map { r in
      Highlight(
        id: Board.newID("h"),
        place: Place(version: version, block: .id(r.id), range: r.fromTranslation ? nil : r.start..<r.end),
        color: .yellow, at: Self.now)
    }.filter { h in !e.highlights.contains { $0.place == h.place } }
    guard !new.isEmpty else { return }
    e.highlights += new
    guard write(e, at: path) else { return }
    web.callAsyncJavaScript("getSelection().removeAllRanges()", in: nil, in: .defaultClient)
  }

  /// The entry with its highlights or annotations changed written, known to the pane and drawn; a beep when it
  /// cannot be written
  @discardableResult
  private func write(_ e: Entry, at path: String) -> Bool {
    do {
      try context.pane.vault?.write(e, at: path)
    } catch {
      NSSound.beep()
      return false
    }
    context.pane.entries.update(e, at: path)
    drawHighlights()
    return true
  }

  /// The entry's highlights on the saved version this tab shows, drawn by the page's script: each with the text its
  /// range has in the block as the reader read it, for the script to find when the page's own text is cut otherwise
  func drawHighlights() {
    guard let (_, e, version) = shownEntry else { return }
    let texts = Dictionary((blocks?.list ?? []).map { ($0.id, $0.text) }, uniquingKeysWith: { a, _ in a })
    let list = e.highlights.filter { $0.place.version == version }.compactMap { h -> [String: Any]? in
      guard case .id(let block) = h.place.block else { return nil }
      var m: [String: Any] = [
        "id": h.id, "block": block, "start": h.place.range?.lowerBound ?? 0, "color": h.color.rawValue,
        "noted": e.sidenotes.contains { $0.place == h.place },
      ]
      if let r = h.place.range {
        m["end"] = r.upperBound
        if let t = texts[block]?.utf16, r.upperBound <= t.count {
          let from = t.index(t.startIndex, offsetBy: r.lowerBound)
          m["text"] = String(t[from..<t.index(t.startIndex, offsetBy: r.upperBound)]) ?? ""
        }
      }
      return m
    }
    if shownHighlight.map({ id in !list.contains { $0["id"] as? String == id } }) == true { showHighlight(nil) }
    web.callAsyncJavaScript(
      "return typeof codeboardHighlights == 'object' ? codeboardHighlights.set(list) : null",
      arguments: ["list": list], in: nil, in: WebReading.selectionWorld)
  }

  /// The page's script said which highlight a click was on, and where it is; nil: on none
  func highlightClicked(_ m: Any?) {
    guard let d = m as? [String: Any], let id = d["id"] as? String, let r = d["rect"] as? [String: Any],
      let x = (r["x"] as? NSNumber)?.doubleValue, let y = (r["y"] as? NSNumber)?.doubleValue,
      let w = (r["width"] as? NSNumber)?.doubleValue, let h = (r["height"] as? NSNumber)?.doubleValue
    else { return showHighlight(nil) }
    let k = web.pageZoom * web.magnification
    showHighlight(id, over: CGRect(x: x * k, y: y * k, width: w * k, height: h * k))
  }

  /// The bar over the clicked highlight, and what is written on it under it when there is some, the popup taking the
  /// keys; nil: neither (the page scrolled, a click elsewhere, the highlight gone)
  func showHighlight(_ id: String?, over rect: CGRect = .zero) {
    closePop()
    shownHighlight = id
    shownHighlightRect = rect
    highlightBar.isHidden = id == nil
    guard let id else { return }
    highlightBar.frame = CGRect(
      origin: SelectionBar.origin(size: highlightBar.size, lines: [rect], visible: floatArea),
      size: highlightBar.size)
    if let e = shownEntry?.entry, !notes(of: id, in: e).isEmpty {
      openPop()
      pop?.focus()
    }
  }

  /// Where the bars and the popup may be: this view, above the web bar when it shows
  private var floatArea: CGRect {
    barShown ? CGRect(x: 0, y: 0, width: bounds.width, height: max(0, bar.frame.minY - 6)) : bounds
  }

  /// The annotations on a highlight's place
  private func notes(of id: String, in e: Entry) -> [EntrySidenote] {
    guard let place = e.highlights.first(where: { $0.id == id })?.place else { return [] }
    return e.sidenotes.filter { $0.place == place }
  }

  /// The clicked highlight gone from the entry, with what was written on it; Undo brings both back
  func removeShownHighlight() {
    guard let id = shownHighlight else { return }
    showHighlight(nil)
    removeHighlight(id)
  }

  func removeHighlight(_ id: String) {
    guard let (path, e0, _) = shownEntry else { return }
    var e = e0
    let places = e.highlights.filter { $0.id == id }.map(\.place)
    let highlights = e.highlights.enumerated().filter { $0.element.id == id }.map { ($0.offset, $0.element) }
    let notes = e.sidenotes.enumerated().filter { places.contains($0.element.place) }.map { ($0.offset, $0.element) }
    guard !highlights.isEmpty else { return }
    e.highlights.removeAll { $0.id == id }
    e.sidenotes.removeAll { places.contains($0.place) }
    guard write(e, at: path) else { return }
    undoManager?.registerUndo(withTarget: self) { $0.restore(highlights, notes) }
    undoManager?.setActionName("Remove Highlight")
  }

  /// A removed highlight and its annotations back where they were in the entry's lists (Undo); Redo removes them again
  func restore(_ highlights: [(Int, Highlight)], _ notes: [(Int, EntrySidenote)]) {
    guard let (path, e0, _) = shownEntry, let id = highlights.first?.1.id else { return }
    var e = e0
    for (i, h) in highlights { e.highlights.insert(h, at: min(i, e.highlights.count)) }
    for (i, n) in notes { e.sidenotes.insert(n, at: min(i, e.sidenotes.count)) }
    guard write(e, at: path) else { return }
    undoManager?.registerUndo(withTarget: self) { $0.removeHighlight(id) }
    undoManager?.setActionName("Remove Highlight")
  }

  // MARK: What is written on a highlight

  /// The popup for the clicked highlight (the board's sidenote popup, as a PDF's highlight has it) under it, with what
  /// is written on it; opened to write: its input has the keys
  func openPop(write: Bool = false) {
    guard let id = shownHighlight, let (path, e, _) = shownEntry, let vault = context.pane.vault else { return }
    if pop == nil {
      guard let make = context.pane.makePop else { return }
      let p = make({ [weak self] in self?.popAction($0) }, { [weak self] in self?.placePop() })
      // over the window, where no pane clips it (in a narrow pane it reaches over the board), as a PDF's is
      (window?.contentView ?? self).addSubview(p.view, positioned: .above, relativeTo: nil)
      p.view.nextResponder = self
      pop = p
    }
    highlightBar.isHidden = true
    let shown = AnnotationPop.Shown(
      title: web.title.flatMap { $0.isEmpty ? nil : $0 } ?? e.title, range: nil, notes: notes(of: id, in: e),
      write: write, folder: vault.url(of: path), look: context.bar,
      maxHeight: max(120, min(560, floatArea.height - 16)))
    pop?.show(shown)
    placePop()
    if write { pop?.focus() }
  }

  /// The popup beside the highlight: the side chosen once, with room for one more note, and kept
  func placePop() {
    guard let p = pop else { return }
    let size = p.size()
    let lines = [shownHighlightRect]
    let below =
      p.below ?? AnnotationPop.below(height: size.height + AnnotationPop.oneMoreNote, lines: lines, visible: floatArea)
    pop?.below = below
    var o = AnnotationPop.origin(size: size, lines: lines, visible: floatArea, below: below)
    if size.width > floatArea.width {
      // wider than the tab: its right edge the tab's, reaching left inside the window
      let room = window?.contentView.map { convert($0.bounds, from: $0) } ?? bounds
      o.x = max(room.minX + 8, floatArea.maxX - 8 - size.width)
    }
    let f = p.frame(o)
    p.view.frame = p.view.superview.map { $0 === self ? f : $0.convert(f, from: self) } ?? f
  }

  /// The popup closed: what is being written in it is added first; the keys it had go back to the page
  func closePop() {
    guard let p = pop else { return }
    pop = nil
    let had = (window?.firstResponder as? NSView)?.isDescendant(of: p.view) == true
    p.end()
    p.view.removeFromSuperview()
    if had, !isHiddenOrHasHiddenAncestor { window?.makeFirstResponder(web) }
  }

  /// What was done in the popup, written to the entry
  private func popAction(_ a: AnnotationPop.Action) {
    switch a {
    case .add(let text, let ask):
      guard let id = shownHighlight, let (path, e0, _) = shownEntry,
        let place = e0.highlights.first(where: { $0.id == id })?.place
      else { return }
      var e = e0
      e.sidenotes.append(
        EntrySidenote(
          id: SidenoteID(rawValue: Board.newID("n")), place: place,
          note: TextNote(text: text, question: ask ? Question(at: Self.now) : nil)))
      if write(e, at: path), pop != nil { openPop() }
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
    case .remove: removeShownHighlight()
    case .close:
      closePop()
      highlightBar.isHidden = shownHighlight == nil
    }
  }

  /// An annotation changed by `f`, or deleted (nil), in the entry
  private func change(_ id: SidenoteID, _ f: ((inout EntrySidenote) -> Void)?) {
    guard let (path, e0, _) = shownEntry, let i = e0.sidenotes.firstIndex(where: { $0.id == id }) else { return }
    var e = e0
    if let f { f(&e.sidenotes[i]) } else { e.sidenotes.remove(at: i) }
    if write(e, at: path), pop != nil { openPop() }
  }
}
