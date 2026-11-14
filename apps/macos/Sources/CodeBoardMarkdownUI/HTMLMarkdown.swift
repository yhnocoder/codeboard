import Foundation

/// HTML from the pasteboard read as Markdown, enough for what pages and mail put there: paragraphs and line breaks,
/// headings, list items, quotes, bold, italics, inline code, code blocks, links, and formulas a page drew (KaTeX,
/// MathJax, MathML: their TeX annotation, the drawn copy beside it left out; \( \) and \[ \] written as $ and $$, as
/// pastemath.ts reads them). A small reader of tags (no WebKit, which the component never starts); anything else keeps
/// its text
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
    /// inside a drawn formula: its TeX once read, whether it is shown as a block, and how deep the copy left out goes
    var math: (tex: String?, display: Bool)?
    var inAnnotation = false
    var hidden = 0
    func flush(_ gap: Bool = true) {
      let t = line.trimmingCharacters(in: .whitespaces)
      if !t.isEmpty || pre > 0 {
        out += (out.isEmpty ? "" : (gap ? "\n\n" : "\n")) + String(repeating: "> ", count: quote) + t
      }
      line = ""
    }
    for m in tag.matches(in: src, range: NSRange(location: 0, length: ns.length)) {
      if m.range(at: 4).location != NSNotFound {
        if inAnnotation {
          let sofar = math?.tex ?? ""
          math?.tex = sofar + decode(ns.substring(with: m.range(at: 4)))
          continue
        }
        if hidden > 0 || math != nil { continue }
        var t = decode(ns.substring(with: m.range(at: 4)))
        // a page's * _ ` [ ] are its characters (the formatting it wants is in its tags): written escaped, so they stay
        // characters; == ~~ and $ are read as Markdown, as pastemarks.ts and pastemath.ts read them
        if pre == 0, href.last == nil { t = escaped(t) }
        if pre == 0 { t = t.replacingOccurrences(of: "\n", with: " ") }
        line += t
        continue
      }
      let close = ns.substring(with: m.range(at: 1)) == "/"
      let name = ns.substring(with: m.range(at: 2)).lowercased()
      let attrs = ns.substring(with: m.range(at: 3))
      let selfClosing = attrs.hasSuffix("/") || ["br", "img", "hr", "meta", "input"].contains(name)
      // a drawn copy of a formula (aria-hidden): left out with all it holds
      if hidden > 0 {
        if !selfClosing { hidden += close ? -1 : 1 }
        continue
      }
      if !close, !selfClosing, attrs.range(of: #"aria-hidden\s*=\s*"true""#, options: .regularExpression) != nil {
        hidden = 1
        continue
      }
      // MathML: its TeX annotation is the formula
      if name == "math" {
        if close, let m = math {
          if let tex = m.tex?.trimmingCharacters(in: .whitespacesAndNewlines), !tex.isEmpty {
            if m.display {
              flush()
              line = "$$\n" + tex + "\n$$"
              flush()
            } else {
              line += "$" + tex + "$"
            }
          }
          math = nil
        } else if !close {
          math = (nil, attrs.range(of: #"display\s*=\s*"block""#, options: .regularExpression) != nil)
        }
        continue
      }
      if name == "annotation" {
        inAnnotation = !close && attrs.contains("tex")
        continue
      }
      if math != nil { continue }
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

  /// A text node's own characters written so they stay characters: formulas in it ($ $, $$ $$, and LaTeX's \( \) and
  /// \[ \], which become dollars) kept as they are, * _ ` [ ] between them escaped
  static func escaped(_ t: String) -> String {
    let math = try! NSRegularExpression(
      pattern: #"\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]"#)
    let ns = t as NSString
    var out = ""
    var at = 0
    func plain(_ s: String) -> String {
      s.replacingOccurrences(of: #"([*_`\[\]])"#, with: "\\\\$1", options: .regularExpression)
    }
    for m in math.matches(in: t, range: NSRange(location: 0, length: ns.length)) {
      out += plain(ns.substring(with: NSRange(location: at, length: m.range.location - at)))
      if m.range(at: 1).location != NSNotFound {
        out += "$" + ns.substring(with: m.range(at: 1)) + "$"
      } else if m.range(at: 2).location != NSNotFound {
        out += "$$" + ns.substring(with: m.range(at: 2)) + "$$"
      } else {
        out += ns.substring(with: m.range)
      }
      at = NSMaxRange(m.range)
    }
    return out + plain(ns.substring(from: at))
  }

  static func decode(_ s: String) -> String {
    var t = s
    for (a, b) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&amp;", "&")] {
      t = t.replacingOccurrences(of: a, with: b)
    }
    return t
  }
}
