import Foundation

// Every source offset of the model moved by the same amount: blocks after an edit, and blocks parsed from a window of
// the source (MarkdownDocument.reparse), keep their structure and move with the text around them.

extension Range where Bound == Int {
  @inline(__always) func shifted(_ d: Int) -> Range<Int> { (lowerBound + d)..<(upperBound + d) }
}

extension MDBlock {
  /// The block as it is after an edit `d` units longer or shorter before it
  public func shifted(_ d: Int) -> MDBlock {
    if d == 0 { return self }
    let kind: Kind =
      switch kind {
      case .paragraph, .heading, .math, .rule, .html: kind
      case .quote(let children): .quote(children: children.map { $0.shifted(d) })
      case .list(let l): .list(l.shifted(d))
      case .code(let language, let body): .code(language: language, body: body.shifted(d))
      case .mermaid(let body): .mermaid(body: body.shifted(d))
      case .table(let t): .table(t.shifted(d))
      }
    return MDBlock(
      kind: kind, range: range.shifted(d), inlines: inlines.map { $0.shifted(d) }, inlineText: inlineText?.shifted(d))
  }
}

extension MDText {
  func shifted(_ d: Int) -> MDText {
    if d == 0 { return self }
    return MDText(string: string, offsets: offsets.map { $0 + d })
  }
}

extension MDList {
  func shifted(_ d: Int) -> MDList {
    MDList(
      marker: marker, tight: tight,
      items: items.map {
        MDListItem(
          range: $0.range.shifted(d), markerRange: $0.markerRange.shifted(d), checked: $0.checked,
          children: $0.children.map { $0.shifted(d) })
      })
  }
}

extension MDTable {
  func shifted(_ d: Int) -> MDTable {
    MDTable(align: align, rows: rows.map { $0.map { $0.shifted(d) } }, caption: caption?.shifted(d))
  }
}

extension MDCell {
  func shifted(_ d: Int) -> MDCell {
    MDCell(range: range.shifted(d), inlines: inlines.map { $0.shifted(d) }, text: text.shifted(d))
  }
}

extension MDInline {
  func shifted(_ d: Int) -> MDInline {
    var kind = kind
    if case .atom(.image(var img)) = kind {
      img.url = img.url.shifted(d)
      img.attributes = img.attributes?.shifted(d)
      kind = .atom(.image(img))
    }
    return MDInline(
      kind: kind, range: range.shifted(d), markers: markers.map { $0.shifted(d) }, inner: inner?.shifted(d),
      children: children.map { $0.shifted(d) })
  }
}
