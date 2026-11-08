// A Note's Markdown as an attributed string for display: Foundation's Markdown parser for the structure (headings, paragraphs,
// lists, code blocks, quotes, inline emphasis and code), set in the board's Note typography (styles.css .card.note .nbody: 13.5px
// body, headings in the system font, code blocks on --nc-bg). Editing a Note is the web editor's job (an edit card, M2); this is
// the resting look. Math, tables and images stay as their source text or a placeholder for now.
import AppKit

enum Markdown {
  struct Style {
    var body: CGFloat = 13.5
    var font: (CGFloat, NSFont.Weight) -> NSFont = { Theme.sys($0, weight: $1) }
    var ink: NSColor = Theme.ink
  }

  /** The leading "# Heading" line a Note shows in its header is not repeated in the body */
  static func body(_ md: String, droppingHeading title: String?) -> String {
    guard let title, !title.isEmpty else { return md }
    var lines = md.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    if let i = lines.firstIndex(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }),
      let m = lines[i].range(of: #"^#{1,6}\s+"#, options: .regularExpression),
      lines[i][m.upperBound...].trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"[*_`~]"#, with: "", options: .regularExpression).hasPrefix(title.prefix(12))
    {
      lines.remove(at: i)
      return lines.joined(separator: "\n")
    }
    return md
  }

  static func render(_ md: String, style: Style = Style()) -> NSAttributedString {
    let out = NSMutableAttributedString()
    let parsed: AttributedString
    do {
      parsed = try AttributedString(
        markdown: md,
        options: .init(allowsExtendedAttributes: true, interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible))
    } catch {
      return NSAttributedString(string: md, attributes: [.font: style.font(style.body, .regular), .foregroundColor: style.ink])
    }
    var lastBlock: Int? = nil
    var first = true
    for run in parsed.runs {
      let intent = run.presentationIntent
      let blockId = intent?.components.first?.identity
      var text = String(parsed[run.range].characters)
      // block boundaries: a newline between blocks, the block's own paragraph style
      let para = NSMutableParagraphStyle()
      para.paragraphSpacing = 6
      para.lineSpacing = 2
      var font = style.font(style.body, .regular)
      var color = style.ink
      var bg: NSColor? = nil
      var prefix = ""
      var isCode = false
      for c in intent?.components ?? [] {
        switch c.kind {
        case .header(let level):
          let sizes: [CGFloat] = [0, 20, 17, 15, 14, 13.5, 13.5]
          font = style.font(sizes[min(level, 6)], .semibold)
          para.paragraphSpacingBefore = 6
        case .codeBlock:
          isCode = true
          font = Theme.mono(11.5)
          bg = Theme.noteCode
          para.lineSpacing = 1
          para.firstLineHeadIndent = 8
          para.headIndent = 8
          text = text.hasSuffix("\n") ? String(text.dropLast()) : text
        case .listItem(let ordinal):
          var ordered = false
          for d in intent?.components ?? [] { if case .orderedList = d.kind { ordered = true } }
          prefix = ordered ? "\(ordinal). " : "•  "
          para.headIndent = 18
          para.firstLineHeadIndent = 4
          para.paragraphSpacing = 2
        case .blockQuote:
          color = Theme.ink2
          para.headIndent = 12
          para.firstLineHeadIndent = 12
        case .thematicBreak:
          text = "────────"
          color = Theme.ink3
        default: break
        }
      }
      if let inline = run.inlinePresentationIntent {
        var traits: NSFontDescriptor.SymbolicTraits = []
        if inline.contains(.stronglyEmphasized) { traits.insert(.bold) }
        if inline.contains(.emphasized) { traits.insert(.italic) }
        if !traits.isEmpty, let d = font.fontDescriptor.withSymbolicTraits(traits) as NSFontDescriptor?, let f = NSFont(descriptor: d, size: font.pointSize) { font = f }
        if inline.contains(.code) && !isCode {
          font = Theme.mono(font.pointSize - 1)
          bg = Theme.noteCode
        }
      }
      if run.imageURL != nil, text.isEmpty { text = "[image]" }
      if run.link != nil { color = Theme.accent }
      var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: para]
      if let bg { attrs[.backgroundColor] = bg }
      if let inline = run.inlinePresentationIntent, inline.contains(.strikethrough) { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      if blockId != lastBlock {
        if !first { out.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: para])) }
        if !prefix.isEmpty { out.append(NSAttributedString(string: prefix, attributes: [.font: font, .foregroundColor: Theme.ink2, .paragraphStyle: para])) }
        lastBlock = blockId
      }
      first = false
      out.append(NSAttributedString(string: text, attributes: attrs))
    }
    return out
  }

  static func height(_ s: NSAttributedString, width: CGFloat) -> CGFloat {
    let r = s.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading])
    return ceil(r.height)
  }
}
