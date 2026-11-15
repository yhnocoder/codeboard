import Foundation

/// Markdown as plain HTML for another app's paste (what the web editor's copy puts on text/html): headings, paragraphs,
/// lists, quotes, code blocks and tables as their elements, strong, emphasis, code, strike, highlight and links inside;
/// formulas and pictures as their source
public enum MarkdownHTML {
  public static func render(_ md: String) -> String {
    let d = MarkdownDocument(md)
    let ns = md as NSString
    func esc(_ s: String) -> String {
      s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
    }
    func inline(_ t: MDText, _ ins: [MDInline]) -> String {
      let u = Array(t.string.utf16)
      func idx(_ q: Int) -> Int { t.offsets.firstIndex { $0 >= q } ?? u.count }
      func text(_ a: Int, _ b: Int) -> String {
        esc(String(decoding: u[max(0, a)..<min(u.count, max(a, b))], as: UTF16.self))
      }
      func emit(_ ins: [MDInline], _ a: Int, _ b: Int) -> String {
        var out = ""
        var at = a
        for i in ins {
          let x = idx(i.range.lowerBound)
          let y = idx(i.range.upperBound)
          if x > at { out += text(at, x) }
          let inner = i.inner.map { (idx($0.lowerBound), idx($0.upperBound)) } ?? (x, y)
          let body = i.children.isEmpty ? text(inner.0, inner.1) : emit(i.children, inner.0, inner.1)
          switch i.kind {
          case .strong: out += "<strong>\(body)</strong>"
          case .emphasis: out += "<em>\(body)</em>"
          case .code: out += "<code>\(body)</code>"
          case .strike: out += "<s>\(body)</s>"
          case .highlight: out += "<mark>\(body)</mark>"
          case .underline: out += "<u>\(body)</u>"
          case .link(let url), .autolink(let url): out += "<a href=\"\(esc(url))\">\(body)</a>"
          case .text: out += body
          default: out += text(x, y)
          }
          at = max(at, y)
        }
        if at < b { out += text(at, b) }
        return out
      }
      return emit(ins, 0, u.count)
    }
    func block(_ b: MDBlock) -> String {
      switch b.kind {
      case .paragraph: return b.inlineText.map { "<p>" + inline($0, b.inlines) + "</p>" } ?? ""
      case .heading(let l): return b.inlineText.map { "<h\(l)>" + inline($0, b.inlines) + "</h\(l)>" } ?? ""
      case .quote(let c): return "<blockquote>" + c.map(block).joined() + "</blockquote>"
      case .list(let l):
        let tag = { if case .ordered = l.marker { "ol" } else { "ul" } }()
        return "<\(tag)>" + l.items.map { "<li>" + $0.children.map(block).joined() + "</li>" }.joined() + "</\(tag)>"
      case .code(_, let body), .mermaid(let body):
        return "<pre><code>"
          + esc(b.code?.string ?? ns.substring(with: NSRange(location: body.lowerBound, length: body.count)))
          + "</code></pre>"
      case .table(let t):
        return "<table>"
          + t.rows.enumerated().map { r, row in
            "<tr>"
              + row.map { c in (r == 0 ? "<th>" : "<td>") + inline(c.text, c.inlines) + (r == 0 ? "</th>" : "</td>") }
              .joined() + "</tr>"
          }.joined() + "</table>"
      case .rule: return "<hr>"
      case .math, .html:
        return "<p>" + esc(ns.substring(with: NSRange(location: b.range.lowerBound, length: b.range.count))) + "</p>"
      }
    }
    return d.blocks.map(block).joined()
  }
}
