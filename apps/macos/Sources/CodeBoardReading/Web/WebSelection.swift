import AppKit
import CodeBoardModel
import WebKit

// A selection on a web page, as the board takes it. On a page online the app's own script, in a world of its own,
// says what is selected; on a saved page the reader does (its `selection` message and `selection()`), by its blocks.

extension WebReading {
  /// The world the app's selection script runs in and posts to, out of the page's reach and the saving scripts'
  @MainActor static let selectionWorld = WKContentWorld.world(name: "codeboard")

  /// Says what is selected, `{text, markdown, rect, lines, scrollY, heading}` or null when nothing is (or only in a
  /// field being edited): once a frame at most while it changes, and not while the button is held, which would be on
  /// every move of a drag; let go, it says. The selection's HTML is reduced to Markdown (paragraphs, headings,
  /// emphasis, links, lists, code), anything else to its text; `heading` is the closest h1 to h6 before its start in
  /// document order. A page not shown draws no frames, and its selection still changes (from its scripts): it says
  /// after a frame's time instead
  static let selectionScript = """
    (() => {
      let queued = false, held = false, last = null
      const frame = f => document.visibilityState == "visible" ? requestAnimationFrame(f) : setTimeout(f, 16)
      const queue = () => {
        if (queued) return
        queued = true
        frame(() => { queued = false; send() })
      }
      const box = r => ({ x: r.x, y: r.y, width: r.width, height: r.height })
      const text = e => e.textContent.replace(/\\s+/g, " ").trim()
      const isHeading = e => /^H[1-6]$/.test(e.tagName)
      const heading = node => {
        for (let e = node.nodeType == 1 ? node : node.parentElement; e; e = e.parentElement) {
          if (isHeading(e)) return text(e)
        }
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT,
          { acceptNode: e => isHeading(e) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP })
        w.currentNode = node
        const h = w.previousNode()
        return h ? text(h) : null
      }
      const blocks =
        /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|NAV|BLOCKQUOTE|FIGURE|FIGCAPTION|TABLE|TR|DL|DT|DD|HR)$/
      const wrap = (inner, mark) => {
        const t = inner.trim()
        return t ? inner.match(/^\\s*/)[0] + mark + t + mark + inner.match(/\\s*$/)[0] : inner
      }
      const markdown = (fragment, top) => {
        const code = []
        const md = n => {
          if (n.nodeType == 3) return n.data.replace(/\\s+/g, " ").replace(/[\\\\`*_[\\]]/g, "\\\\$&")
          if (n.nodeType != 1 && n.nodeType != 11) return ""
          const tag = n.tagName ?? ""
          if (tag == "SCRIPT" || tag == "STYLE" || tag == "TEMPLATE") return ""
          if (tag == "BR") return "\\n"
          if (tag == "PRE") {
            code.push("```\\n" + n.textContent.replace(/\\n$/, "") + "\\n```")
            return "\\n\\n\\u0000" + (code.length - 1) + "\\u0000\\n\\n"
          }
          if (tag == "CODE") {
            const t = n.textContent
            const fence = t.includes("`") ? "`` " : "`"
            return fence + t + (fence == "`" ? "`" : " ``")
          }
          const inner = [...n.childNodes].map(md).join("")
          if (/^H[1-6]$/.test(tag)) return "\\n\\n" + "#".repeat(+tag[1]) + " " + inner.trim() + "\\n\\n"
          if (tag == "LI") {
            const ordered = (n.parentElement?.tagName ?? top) == "OL"
            return "\\n" + (ordered ? "1. " : "- ") + inner.trim()
          }
          if (tag == "EM" || tag == "I") return wrap(inner, "*")
          if (tag == "STRONG" || tag == "B") return wrap(inner, "**")
          if (tag == "A") {
            const href = n.getAttribute("href")
            const url = href == null ? null : new URL(href, document.baseURI)
            const linked = url && /^(https?|mailto):$/.test(url.protocol) && inner.trim()
            return linked ? "[" + inner.trim() + "](" + url.href + ")" : inner
          }
          if (tag == "UL" || tag == "OL") return "\\n\\n" + inner + "\\n\\n"
          return blocks.test(tag) ? "\\n\\n" + inner + "\\n\\n" : inner
        }
        return md(fragment).replace(/[ \\t]*\\n[ \\t]*/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim()
          .replace(/\\u0000(\\d+)\\u0000/g, (_, i) => code[+i])
      }
      const now = () => {
        const s = getSelection()
        if (!s || s.isCollapsed || !s.rangeCount) return null
        const field = document.activeElement
        if (field?.matches("input, textarea") || field?.isContentEditable) return null
        const plain = s.toString()
        if (!plain.trim()) return null
        const r = s.getRangeAt(0)
        const lines = [...r.getClientRects()].filter(l => l.width > 0 && l.height > 0)
        const top = r.commonAncestorContainer.nodeType == 1 ? r.commonAncestorContainer.tagName : null
        return { text: plain, markdown: markdown(r.cloneContents(), top), rect: box(r.getBoundingClientRect()),
          lines: lines.length ? [box(lines[0]), box(lines[lines.length - 1])] : [], scrollY,
          heading: heading(r.startContainer) }
      }
      const send = () => {
        const m = now()
        if (held && m) return
        const json = JSON.stringify(m)
        if (json == last) return
        last = json
        webkit.messageHandlers.selection.postMessage(m)
      }
      // a field's own selection changes at the field, without bubbling
      document.addEventListener("selectionchange", queue, true)
      addEventListener("pointerdown", e => { if (e.button == 0) held = true }, true)
      for (const t of ["pointerup", "pointercancel", "dragend"]) {
        addEventListener(t, () => { held = false; queue() }, true)
      }
    })()
    """
}

/// What is selected on the page, as its script last said; its rectangles in the viewport's CSS pixels
struct WebSelection: Equatable {
  /// On a saved page: a block's characters, as the reader counts them in its text (UTF-16)
  struct Range: Equatable {
    var id: String
    var start: Int
    var end: Int
    var text: String
    /// Selected in the block's translation: the board takes the whole original block
    var fromTranslation: Bool
  }

  var text: String
  var markdown: String
  /// The first and last lines, in reading order (one rectangle for all when the page gives no lines)
  var lines: [CGRect]
  /// The page's scroll when it said, for the rectangles to follow it
  var scrollY: Double
  /// The closest heading before the selection
  var heading: String?
  /// On a saved page, in its blocks
  var ranges: [Range] = []

  /// The selection script's message
  init?(script m: Any?) {
    guard let d = m as? [String: Any], let text = d["text"] as? String, let markdown = d["markdown"] as? String
    else { return nil }
    let lines = (d["lines"] as? [Any] ?? []).compactMap(Self.rect)
    self.text = text
    self.markdown = markdown
    self.lines = lines.isEmpty ? Self.rect(d["rect"]).map { [$0] } ?? [] : lines
    scrollY = (d["scrollY"] as? NSNumber)?.doubleValue ?? 0
    heading = (d["heading"] as? String).flatMap { $0.isEmpty ? nil : $0 }
  }

  /// The reader's `selection` message, `{ranges, rect}`, at the page's scroll `scrollY`; `blocks` the page's, for the
  /// heading before the first range
  init?(reader m: [String: Any], scrollY: Double, blocks: [WebBlock]) {
    let ranges = (m["ranges"] as? [Any] ?? []).compactMap { r -> Range? in
      guard let d = r as? [String: Any], let id = d["id"] as? String, let text = d["text"] as? String,
        let start = (d["start"] as? NSNumber)?.intValue, let end = (d["end"] as? NSNumber)?.intValue, start <= end
      else { return nil }
      return Range(id: id, start: start, end: end, text: text, fromTranslation: d["fromTranslation"] as? Bool ?? false)
    }
    guard let first = ranges.first, let rect = Self.rect(m["rect"]) else { return nil }
    text = ranges.map(\.text).joined(separator: "\n\n")
    markdown = text
    lines = [rect]
    self.scrollY = scrollY
    self.ranges = ranges
    let at = blocks.firstIndex { $0.id == first.id }
    heading = at.flatMap { i in blocks[...i].last { $0.kind == "heading" }?.text }
  }

  private static func rect(_ v: Any?) -> CGRect? {
    guard let d = v as? [String: Any], let x = d["x"] as? NSNumber, let y = d["y"] as? NSNumber,
      let w = d["width"] as? NSNumber, let h = d["height"] as? NSNumber
    else { return nil }
    return CGRect(x: x.doubleValue, y: y.doubleValue, width: w.doubleValue, height: h.doubleValue)
  }
}

/// The page's view: ⌥↵ and a drag of the selection go through its tab first
final class PageWebView: WKWebView {
  /// A key down; true: the tab took it
  var onKey: ((NSEvent) -> Bool)?
  /// A drag starting with a press at that point of this view: the selection's text when it is a drag of the
  /// selection the board can take
  var dragsSelection: ((CGPoint) -> String?)?
  /// The selection as the board takes it, asked when a drop asks for it
  var collecting: (() -> Collected?)?

  override init(frame: CGRect, configuration: WKWebViewConfiguration) {
    Self.hookTextDrags
    super.init(frame: frame, configuration: configuration)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("PageWebView is not loaded from nibs") }

  override func keyDown(with event: NSEvent) {
    if onKey?(event) != true { super.keyDown(with: event) }
  }

  /// A drag of the selection keeps what WebKit put on its pasteboard (text, HTML, RTF: what other apps take) and
  /// carries the collected passage too, shown as a drag from a PDF is; any other drag is WebKit's alone. `picture`: the
  /// drag's picture in place of WebKit's, and where its bottom left goes in this view
  private func selectionDrag(_ event: NSEvent) -> (picture: NSImage, at: CGPoint)? {
    let at = convert(event.locationInWindow, from: nil)
    guard let text = dragsSelection?(at) else { return nil }
    let picture = Collected.dragImage(text)
    let h = picture.size.height
    return (picture, CGPoint(x: at.x - 12, y: isFlipped ? at.y - 12 + h : at.y + 12 - h))
  }

  /// The collected passage promised on `pasteboard` beside what is there: made only when a drop asks for it, so that a
  /// drag to another app saves nothing
  func carry(on pasteboard: NSPasteboard) {
    pasteboard.addTypes([.collected], owner: self)
  }

  override func beginDraggingSession(
    with items: [NSDraggingItem], event: NSEvent, source: any NSDraggingSource
  ) -> NSDraggingSession {
    // what goes on the pasteboard is written when the session begins: the passage is added after
    let drag = items.count == 1 ? selectionDrag(event) : nil
    if let drag, let item = items.first {
      let at = isFlipped ? CGPoint(x: drag.at.x, y: drag.at.y - drag.picture.size.height) : drag.at
      item.setDraggingFrame(CGRect(origin: at, size: drag.picture.size), contents: drag.picture)
    }
    let session = super.beginDraggingSession(with: items, event: event, source: source)
    if drag != nil { carry(on: session.draggingPasteboard) }
    return session
  }

  /// WebKit begins a drag of selected text with NSView's dragImage(…pasteboard:…), which Swift cannot override (it is
  /// unavailable there): this class gets its own method for it, which carries the passage and calls NSView's
  private static let hookTextDrags: Void = {
    let sel = NSSelectorFromString("dragImage:at:offset:event:pasteboard:source:slideBack:")
    guard let method = class_getInstanceMethod(NSView.self, sel), let types = method_getTypeEncoding(method) else {
      return
    }
    typealias Drag =
      @convention(c) (
        AnyObject, Selector, NSImage, NSPoint, NSSize, NSEvent, NSPasteboard, AnyObject, ObjCBool
      ) -> Void
    let original = unsafeBitCast(class_getMethodImplementation(WKWebView.self, sel), to: Drag.self)
    // AppKit calls it on the main thread, as WebKit's drags all are
    let block:
      @MainActor @convention(block) (
        PageWebView, NSImage, NSPoint, NSSize, NSEvent, NSPasteboard, AnyObject, ObjCBool
      ) -> Void = { view, image, at, offset, event, pasteboard, source, slide in
        let drag = view.selectionDrag(event)
        if drag != nil { view.carry(on: pasteboard) }
        original(view, sel, drag?.picture ?? image, drag?.at ?? at, offset, event, pasteboard, source, slide)
      }
    class_addMethod(PageWebView.self, sel, imp_implementationWithBlock(block), types)
  }()
}

extension PageWebView: @preconcurrency NSPasteboardTypeOwner {
  func pasteboard(_ sender: NSPasteboard, provideDataForType type: NSPasteboard.PasteboardType) {
    guard type == .collected, let data = try? collecting?()?.data() else { return }
    sender.setData(data, forType: .collected)
  }
}

/// Hands the selection script's messages to the view without the content controller keeping the view alive
final class SelectionRelay: NSObject, WKScriptMessageHandler {
  weak var owner: WebPageView?

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    owner?.selected(WebSelection(script: message.body))
  }
}
