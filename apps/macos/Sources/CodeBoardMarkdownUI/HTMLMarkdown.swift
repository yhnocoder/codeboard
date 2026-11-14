import Foundation

/// HTML from the pasteboard read as Markdown, enough for what pages and mail put there: paragraphs and line breaks,
/// headings, list items, quotes, bold, italics, inline code, code blocks, links. A small reader of tags (no WebKit, which
/// the component never starts); anything else keeps its text
enum HTMLMarkdown {
  static func markdown(_ html: String) -> String? {
    // only the fragment a page marks as copied, when it says
    var src = html
    if let a = src.range(of: "<!--StartFragment-->"), let b = src.range(of: "<!--EndFragment-->") {
      src = String(src[a.upperBound..<b.lowerBound])
    }
    let tag = try! NSRegularExpression(pattern: #"<(/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)"#)
    let ns = src as NSString
    var out = ""
    var line = ""
    var list: [String] = []
    var counters: [Int] = []
    var pre = 0
    var href: [String?] = []
    var quote = 0
    /// the next item starts a list: a blank line before it
    var listStart = false
    func flush(_ gap: Bool = true) {
      let t = line.trimmingCharacters(in: .whitespaces)
      if !t.isEmpty || pre > 0 {
        out += (out.isEmpty ? "" : (gap ? "\n\n" : "\n")) + String(repeating: "> ", count: quote) + t
      }
      line = ""
    }
    for m in tag.matches(in: src, range: NSRange(location: 0, length: ns.length)) {
      if m.range(at: 4).location != NSNotFound {
        var t = decode(ns.substring(with: m.range(at: 4)))
        if pre == 0 { t = t.replacingOccurrences(of: "\n", with: " ") }
        line += t
        continue
      }
      let close = ns.substring(with: m.range(at: 1)) == "/"
      let name = ns.substring(with: m.range(at: 2)).lowercased()
      let attrs = ns.substring(with: m.range(at: 3))
      switch name {
      case "p", "div":
        if close || !line.isEmpty { flush() }
      case "br": line += pre > 0 ? "\n" : "<br>"
      case "h1", "h2", "h3", "h4", "h5", "h6":
        if close {
          line =
            String(repeating: "#", count: Int(name.dropFirst()) ?? 1) + " " + line.trimmingCharacters(in: .whitespaces)
          flush()
        } else if !line.isEmpty {
          flush()
        }
      case "ul", "ol":
        if close {
          if !list.isEmpty {
            list.removeLast()
            counters.removeLast()
          }
        } else {
          flush()
          listStart = true
          list.append(name)
          counters.append(0)
        }
      case "li":
        if close {
          flush(listStart)
          listStart = false
        } else {
          if !line.isEmpty {
            flush(listStart)
            listStart = false
          }
          let depth = String(repeating: "  ", count: max(0, list.count - 1))
          if list.last == "ol" {
            counters[counters.count - 1] += 1
            line = depth + "\(counters.last!). "
          } else {
            line = depth + "- "
          }
        }
      case "blockquote":
        flush()
        quote += close ? -1 : 1
        quote = max(0, quote)
      case "strong", "b": line += "**"
      case "em", "i": line += "*"
      case "code": if pre == 0 { line += "`" }
      case "pre":
        if close {
          out += (out.isEmpty ? "" : "\n\n") + "```\n" + line.trimmingCharacters(in: .newlines) + "\n```"
          line = ""
          pre -= 1
        } else {
          flush()
          pre += 1
        }
      case "a":
        if close {
          if let h = href.popLast(), let h { line += "](\(h))" }
        } else {
          let h = attrs.range(of: #"href\s*=\s*"([^"]*)""#, options: .regularExpression).map {
            String(attrs[$0]).replacingOccurrences(of: #"^href\s*=\s*""#, with: "", options: .regularExpression)
              .dropLast()
          }.map(String.init)
          href.append(h)
          if h != nil { line += "[" }
        }
      default: break
      }
    }
    flush()
    let md = out.trimmingCharacters(in: .whitespacesAndNewlines)
    return md.isEmpty ? nil : md
  }

  static func decode(_ s: String) -> String {
    var t = s
    for (a, b) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&amp;", "&")] {
      t = t.replacingOccurrences(of: a, with: b)
    }
    return t
  }
}
