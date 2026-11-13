import Foundation

/// marked's block lexer (Lexer.blockTokens and the block methods of its Tokenizer), with the block extensions the
/// TypeScript package registers that this package supports: TipTap's table pre-pass, `$$` math blocks and TipTap's task
/// lists. Footnotes, `<details>` and `[toc]` are not supported (they read as the paragraphs and HTML CommonMark makes of
/// them), so their tokenizers are left out. Inline content is not tokenized here: blocks that have it are marked
/// `inline` and their text is read by InlineLexer when the document is built.
struct BlockLexer {
  private var top = true
  /// link definitions seen: a later definition of the same label is dropped, as marked does
  private var links: Set<String> = []

  static func lex(_ source: String) -> [Token] {
    var lx = BlockLexer()
    // marked reads \r\n and \r as \n; the mapped text keeps pointing at the original source
    var text = Mapped(source)
    if source.utf16.contains(0x0D) { text = text.replacing(carriageReturn, template: "\n") }
    return lx.blockTokens(text, [])
  }

  private static let carriageReturn = JSRegex(#"\r\n|\r"#, flags: "g")

  mutating func blockTokens(_ input: Mapped, _ start: [Token], lastParagraphClipped clippedIn: Bool = false) -> [Token]
  {
    var tokens = start
    var src = input
    var lastParagraphClipped = clippedIn
    func take(_ t: Token) {
      src = src.dropFirst(t.raw.count)
    }
    while !src.isEmpty {
      // extensions run first, the last registered first (marked unshifts them)
      if let t = tableExtension(src) ?? blockMath(src) ?? taskList(src) {
        take(t)
        tokens.append(t)
        continue
      }
      if let t = space(src) {
        take(t)
        if t.raw.count == 1, let last = tokens.last {
          // a single \n ends the line before: it joins the last token
          last.raw = last.raw + t.raw
        } else {
          tokens.append(t)
        }
        continue
      }
      if let t = code(src) {
        take(t)
        if let last = tokens.last, last.type == "paragraph" || last.type == "text" {
          // an indented code block cannot interrupt a paragraph
          last.raw = last.raw.hasSuffix("\n") ? last.raw + t.raw : last.raw + newline(after: last.raw) + t.raw
          last.text = last.text + newline(after: last.text) + t.text
        } else {
          tokens.append(t)
        }
        continue
      }
      if let t = fences(src) ?? heading(src) ?? hr(src) {
        take(t)
        tokens.append(t)
        continue
      }
      if let t = blockquote(src) {
        take(t)
        tokens.append(t)
        continue
      }
      if let t = list(src) ?? html(src) {
        take(t)
        tokens.append(t)
        continue
      }
      if let t = def(src) {
        take(t)
        if let last = tokens.last, last.type == "paragraph" || last.type == "text" {
          last.raw = last.raw.hasSuffix("\n") ? last.raw + t.raw : last.raw + newline(after: last.raw) + t.raw
          last.text = last.text + newline(after: last.text) + t.raw
        } else if !links.contains(t.tag) {
          links.insert(t.tag)
          tokens.append(t)
        }
        continue
      }
      if let t = table(src) ?? lheading(src) {
        take(t)
        tokens.append(t)
        continue
      }
      // a paragraph stops where an extension could start (tables, $$ lines, task lists)
      var cut = src
      if let s = Self.extensionStart(src.dropFirst(1)) { cut = src.prefix(s + 1) }
      if top, let t = paragraph(cut) {
        if lastParagraphClipped, let last = tokens.last, last.type == "paragraph" {
          last.raw = last.raw.hasSuffix("\n") ? last.raw + t.raw : last.raw + newline(after: last.raw) + t.raw
          last.text = last.text + newline(after: last.text) + t.text
        } else {
          tokens.append(t)
        }
        lastParagraphClipped = cut.count != src.count
        take(t)
        continue
      }
      if let t = text(src) {
        take(t)
        if let last = tokens.last, last.type == "text" {
          last.raw = last.raw.hasSuffix("\n") ? last.raw + t.raw : last.raw + newline(after: last.raw) + t.raw
          last.text = last.text + newline(after: last.text) + t.text
        } else {
          tokens.append(t)
        }
        continue
      }
      // marked throws "Infinite loop"; every input is consumed by text above, so this is unreachable
      break
    }
    top = true
    return tokens
  }

  /// the \n marked writes between two pieces it joins: the source's line break after `m`
  private func newline(after m: Mapped) -> Mapped { .synthetic("\n", at: m.source.upperBound) }

  // MARK: marked's block tokenizers

  private func space(_ src: Mapped) -> Token? {
    guard let m = MarkedRules.Block.newline.exec(src.ns), m.range.length > 0 else { return nil }
    return Token("space", raw: src.prefix(m.range.length))
  }

  private func code(_ src: Mapped) -> Token? {
    guard let m = MarkedRules.Block.code.exec(src.ns) else { return nil }
    let raw = src.prefix(m.range.length)
    let t = Token("code", raw: raw, text: raw.replacing(Other.codeRemoveIndent, template: "").trimmingEnd(0x0A))
    t.codeIndented = true
    return t
  }

  private func fences(_ src: Mapped) -> Token? {
    let s = src.ns
    guard let m = MarkedRules.Block.fences.exec(s) else { return nil }
    let raw = src.prefix(m.range.length)
    let body = m.groups[3].map { src[$0.location..<$0.upperBound] } ?? Mapped("", at: raw.source.upperBound)
    let t = Token("code", raw: raw, text: indentCodeCompensation(raw: raw, text: body))
    if let info = m.group(2, in: s) {
      let trimmed = Mapped(info).trimmed().string
      t.lang = trimmed.isEmpty ? "" : MarkedRules.Inline.anyPunctuation.replace(trimmed, template: "$1")
    }
    return t
  }

  private func indentCodeCompensation(raw: Mapped, text: Mapped) -> Mapped {
    guard let m = Other.indentCodeCompensation.exec(raw.ns) else { return text }
    let indent = m.groups[1]!.length
    let lines = text.lines().map { line -> Mapped in
      guard let s = Other.beginningSpace.exec(line.ns) else { return line }
      return s.range.length >= indent ? line.dropFirst(indent) : line
    }
    return Mapped.join(lines)
  }

  private func heading(_ src: Mapped) -> Token? {
    let s = src.ns
    guard let m = MarkedRules.Block.heading.exec(s) else { return nil }
    let raw = src.prefix(m.range.length)
    var text = src[m.groups[2]!.location..<m.groups[2]!.upperBound].trimmed()
    if text.hasSuffix("#") {
      let trimmed = text.trimmingEnd(0x23)
      // CommonMark needs a space before the closing #s
      if trimmed.isEmpty || trimmed.hasSuffix(" ") { text = trimmed.trimmed() }
    }
    let t = Token("heading", raw: raw, text: text)
    t.depth = m.groups[1]!.length
    t.inline = true
    return t
  }

  private func hr(_ src: Mapped) -> Token? {
    guard let m = MarkedRules.Block.hr.exec(src.ns) else { return nil }
    return Token("hr", raw: src.prefix(m.range.length).trimmingEnd(0x0A))
  }

  private mutating func blockquote(_ src: Mapped) -> Token? {
    guard let m = MarkedRules.Block.blockquote.exec(src.ns) else { return nil }
    var lines = src.prefix(m.range.length).trimmingEnd(0x0A).lines()
    var raw: Mapped?
    var text: Mapped?
    var tokens: [Token] = []
    while !lines.isEmpty {
      var inBlockquote = false
      var current: [Mapped] = []
      var i = 0
      while i < lines.count {
        if Other.blockquoteStart.test(lines[i].ns) {
          current.append(lines[i])
          inBlockquote = true
        } else if !inBlockquote {
          current.append(lines[i])
        } else {
          break
        }
        i += 1
      }
      lines = Array(lines[i...])
      let currentRaw = Mapped.join(current)
      let currentText =
        currentRaw
        .replacing(Other.blockquoteSetextReplace) { m, s in "\n    " + (m.group(1, in: s) ?? "") }
        .replacing(Other.blockquoteSetextReplace2, template: "")
      raw = raw.map { Mapped.join([$0, currentRaw]) } ?? currentRaw
      text = text.map { Mapped.join([$0, currentText]) } ?? currentText
      // the quote's lines are read as top-level blocks; a paragraph continues across a lazy continuation
      let wasTop = top
      top = true
      tokens = blockTokens(currentText, tokens, lastParagraphClipped: true)
      top = wasTop
      if lines.isEmpty { break }
      guard let last = tokens.last else { continue }
      if last.type == "code" {
        break
      } else if last.type == "blockquote" {
        let newText = Mapped.join([last.raw] + lines)
        guard let nt = blockquote(newText) else { break }
        tokens[tokens.count - 1] = nt
        raw = raw!.prefix(raw!.count - last.raw.count) + nt.raw
        text = text!.prefix(text!.count - last.text.count) + nt.text
        break
      } else if last.type == "list" {
        let newText = Mapped.join([last.raw] + lines)
        guard let nt = list(newText) else { break }
        tokens[tokens.count - 1] = nt
        raw = raw!.prefix(raw!.count - last.raw.count) + nt.raw
        text = text!.prefix(text!.count - last.raw.count) + nt.raw
        lines = newText.dropFirst(nt.raw.count).lines()
        continue
      }
    }
    let t = Token("blockquote", raw: raw ?? src.prefix(0), text: text)
    t.tokens = tokens
    return t
  }

  private mutating func list(_ input: Mapped) -> Token? {
    var src = input
    guard let first = MarkedRules.Block.list.exec(src.ns) else { return nil }
    let bullet = Mapped(src.ns.substring(with: first.groups[1]!)).trimmed().string
    let ordered = bullet.utf16.count > 1
    let list = Token("list", raw: input.prefix(0))
    list.ordered = ordered
    list.start = ordered ? Int(bullet.dropLast()) : nil
    let bull =
      ordered
      ? #"\d{1,9}\"# + String(bullet.last!)
      : "\\" + bullet
    let itemRegex = Other.listItem(bull)
    var endsWithBlankLine = false
    var items: [Token] = []
    var listEnd = 0
    while !src.isEmpty {
      var endEarly = false
      let s = src.ns
      guard let cap = itemRegex.exec(s) else { break }
      if MarkedRules.Block.hr.test(s) { break }
      let itemStart = input.count - src.count
      var consumed = cap.range.length
      var rawLen = cap.range.length
      src = src.dropFirst(cap.range.length)
      let cap1 = cap.groups[1]!.length
      let g2 = cap.groups[2]!
      let cap2 = input[itemStart + g2.location..<itemStart + g2.upperBound]
      var line = (cap2.lines().first ?? cap2).expandingTabs(from: cap1)
      var nextLine = src.lines().first ?? src
      var blankLine = line.trimmed().isEmpty
      var indent = 0
      var contents: Mapped
      if blankLine {
        indent = cap1 + 1
        contents = Mapped("", at: line.source.lowerBound)
      } else {
        indent = Other.nonSpaceChar.exec(line.ns)?.range.location ?? -1
        if indent > 4 { indent = 1 }
        contents = line.dropFirst(indent)
        indent += cap1
      }
      if blankLine && Other.blankLine.test(nextLine.ns) {
        // an item starts with at most one blank line
        rawLen += nextLine.count + 1
        consumed += nextLine.count + 1
        src = src.dropFirst(nextLine.count + 1)
        endEarly = true
      }
      if !endEarly {
        let nextBullet = Other.nextBullet(indent)
        let hrRe = Other.hrAt(indent)
        let fencesBegin = Other.fencesBegin(indent)
        let headingBegin = Other.headingBegin(indent)
        let htmlBegin = Other.htmlBegin(indent)
        let quoteBegin = Other.blockquoteBegin(indent)
        while !src.isEmpty {
          let rawLine = src.lines().first ?? src
          nextLine = rawLine
          let noTabs = nextLine.replacing(Other.tabCharGlobal, template: "    ")
          let nl = nextLine.ns
          if fencesBegin.test(nl) || headingBegin.test(nl) || htmlBegin.test(nl) || quoteBegin.test(nl)
            || nextBullet.test(nl) || hrRe.test(nl)
          {
            break
          }
          let lineBreak = Mapped.synthetic("\n", at: rawLine.source.lowerBound - 1)
          if (Other.nonSpaceChar.exec(noTabs.ns)?.range.location ?? -1) >= indent || nextLine.trimmed().isEmpty {
            contents = contents + lineBreak + noTabs.dropFirst(indent)
          } else {
            if blankLine { break }
            let lineNoTabs = line.replacing(Other.tabCharGlobal, template: "    ")
            if (Other.nonSpaceChar.exec(lineNoTabs.ns)?.range.location ?? -1) >= 4 { break }
            let l = line.ns
            if fencesBegin.test(l) || headingBegin.test(l) || hrRe.test(l) { break }
            contents = contents + lineBreak + nextLine
          }
          blankLine = nextLine.trimmed().isEmpty
          rawLen += rawLine.count + 1
          consumed += rawLine.count + 1
          src = src.dropFirst(rawLine.count + 1)
          line = noTabs.dropFirst(indent)
        }
      }
      let raw = input[itemStart..<min(input.count, itemStart + rawLen)]
      if !list.loose {
        if endsWithBlankLine {
          list.loose = true
        } else if Other.doubleBlankLine.test(raw.ns) {
          endsWithBlankLine = true
        }
      }
      let item = Token("list_item", raw: raw, text: contents)
      item.task = Other.listIsTask.test(contents.ns)
      items.append(item)
      listEnd = min(input.count, itemStart + consumed)
    }
    guard let last = items.last else { return nil }
    last.raw = last.raw.trimmedEnd()
    last.text = last.text.trimmedEnd()
    list.raw = input.prefix(listEnd).trimmedEnd()
    for item in items {
      top = false
      item.tokens = blockTokens(item.text, [])
      if item.task {
        item.text = item.text.replacing(Other.listReplaceTask, template: "")
        if let f = item.tokens.first, f.type == "text" || f.type == "paragraph" {
          f.raw = f.raw.replacing(Other.listReplaceTask, template: "")
          f.text = f.text.replacing(Other.listReplaceTask, template: "")
        }
        if let m = Other.listTaskCheckbox.exec(item.raw.ns) {
          let box = item.raw.ns.substring(with: m.range)
          item.checked = box != "[ ]"
          // in a list that is loose by now, marked puts the checkbox's source back in front of the first paragraph
          // (its inline content still starts after it)
          if list.loose, let f = item.tokens.first, f.type == "paragraph" || f.type == "text" {
            f.inlineText = f.text
            let at = f.raw.source.lowerBound
            f.raw = .synthetic(box + " ", at: at) + f.raw
            f.text = .synthetic(box + " ", at: at) + f.text
          } else if list.loose {
            let p = Token("paragraph", raw: .synthetic(box + " ", at: item.raw.source.lowerBound))
            p.inline = true
            p.inlineText = Mapped("", at: item.raw.source.lowerBound)
            item.tokens.insert(p, at: 0)
          }
        }
      }
      if !list.loose {
        let spacers = item.tokens.filter { $0.type == "space" }
        list.loose = spacers.contains { Other.anyLine.test($0.raw.ns) }
      }
    }
    if list.loose {
      for item in items {
        item.loose = true
        for t in item.tokens where t.type == "text" { t.type = "paragraph" }
      }
    }
    list.items = items
    return list
  }

  private func html(_ src: Mapped) -> Token? {
    // the package's override: a tag HTML has no element for (vector<int>, <T>) is not HTML
    if HTMLNames.notHTMLTag(src) { return nil }
    guard let m = MarkedRules.Block.html.exec(src.ns) else { return nil }
    return Token("html", raw: src.prefix(m.range.length))
  }

  private func def(_ src: Mapped) -> Token? {
    let s = src.ns
    guard let m = MarkedRules.Block.def.exec(s) else { return nil }
    let t = Token("def", raw: src.prefix(m.range.length))
    t.tag = Other.multipleSpaceGlobal.replace(m.group(1, in: s)!.lowercased(), template: " ")
    return t
  }

  private func table(_ src: Mapped) -> Token? {
    let s = src.ns
    guard let m = MarkedRules.Block.table.exec(s) else { return nil }
    let alignRow = m.group(2, in: s)!
    if !Other.tableDelimiter.test(alignRow) { return nil }
    let headerText = src[m.groups[1]!.location..<m.groups[1]!.upperBound]
    let headers = Self.splitCells(headerText)
    let aligns = Other.tableAlignChars.replace(alignRow, template: "").components(separatedBy: "|")
    var rows: [Mapped] = []
    if let r = m.groups[3], !src[r.location..<r.upperBound].trimmed().isEmpty {
      rows = src[r.location..<r.upperBound].replacing(Other.tableRowBlankLine, template: "").lines()
    }
    if headers.count != aligns.count { return nil }
    let t = Token("table", raw: src.prefix(m.range.length))
    t.align = aligns.map { a in
      if Other.tableAlignRight.test(a) { return "right" }
      if Other.tableAlignCenter.test(a) { return "center" }
      if Other.tableAlignLeft.test(a) { return "left" }
      return nil
    }
    t.header = headers.map { cell($0) }
    t.rows = rows.map { Self.splitCells($0, count: headers.count).map { cell($0) } }
    return t
  }
  private func cell(_ text: Mapped) -> Token {
    let c = Token("cell", raw: text, text: text)
    c.inline = true
    return c
  }

  /// marked's splitCells, on mapped text
  static func splitCells(_ row: Mapped, count: Int? = nil) -> [Mapped] {
    // every unescaped | gets a space before it, then the row splits on " |"
    var spaced = Mapped("", at: row.source.lowerBound)
    var last = 0
    for (i, u) in row.units.enumerated() where u == 0x7C {
      var escaped = false
      var k = i - 1
      while k >= 0, row.units[k] == 0x5C {
        escaped.toggle()
        k -= 1
      }
      if !escaped {
        spaced = spaced + row[last..<i] + .synthetic(" ", at: row.sourceOffset(i))
        last = i
      }
    }
    spaced = spaced + row[last..<row.count]
    var cells: [Mapped] = []
    var start = 0
    let u = spaced.units
    var i = 0
    while i + 1 < u.count {
      if u[i] == 0x20, u[i + 1] == 0x7C {
        cells.append(spaced[start..<i])
        start = i + 2
        i += 2
      } else {
        i += 1
      }
    }
    cells.append(spaced[start..<spaced.count])
    if let f = cells.first, f.trimmed().isEmpty { cells.removeFirst() }
    if let l = cells.last, l.trimmed().isEmpty { cells.removeLast() }
    if let count {
      if cells.count > count {
        cells.removeLast(cells.count - count)
      } else {
        while cells.count < count { cells.append(Mapped("", at: row.source.upperBound)) }
      }
    }
    return cells.map { $0.trimmed().replacing(Other.slashPipe, template: "|") }
  }

  private func lheading(_ src: Mapped) -> Token? {
    let s = src.ns
    guard let m = MarkedRules.Block.lheading.exec(s) else { return nil }
    let t = Token(
      "heading", raw: src.prefix(m.range.length), text: src[m.groups[1]!.location..<m.groups[1]!.upperBound].trimmed())
    t.depth = s.substring(with: m.groups[2]!).hasPrefix("=") ? 1 : 2
    t.inline = true
    return t
  }

  private func paragraph(_ src: Mapped) -> Token? {
    guard let m = MarkedRules.Block.paragraph.exec(src.ns) else { return nil }
    let body = src.prefix(m.groups[1]!.length)
    let t = Token(
      "paragraph", raw: src.prefix(m.range.length), text: body.hasSuffix("\n") ? body.prefix(body.count - 1) : body)
    t.inline = true
    return t
  }

  private func text(_ src: Mapped) -> Token? {
    guard let m = MarkedRules.Block.text.exec(src.ns) else { return nil }
    let t = Token("text", raw: src.prefix(m.range.length))
    t.inline = true
    return t
  }

  // MARK: the package's block extensions

  /// Where the next block extension could start in src (marked's startBlock): -1 functions and the unsupported
  /// extensions' (footnotes, details, toc) are left out; they never change where a paragraph ends in the result
  static func extensionStart(_ src: Mapped) -> Int? {
    var best: Int?
    let s = src.ns
    // taskList: a line that starts a task item
    if let m = Ext.taskStart.exec(s) { best = m.range.location }
    // blockMath: a $$ line after a line break
    if let m = Ext.blockMathStart.exec(s) { best = min(best ?? .max, m.range.location + 1) }
    // TipTap's table: the first line holds a | and the second is a delimiter row
    let lines = src.lines()
    if lines.count >= 2, Ext.tableSeparator.test(lines[1].ns), lines[1].firstIndex(of: "|") != nil,
      lines[0].firstIndex(of: "|") != nil
    {
      best = 0
    }
    return best
  }

  private func blockMath(_ src: Mapped) -> Token? {
    let s = src.ns
    guard let m = Ext.blockMath.exec(s) else { return nil }
    let t = Token("blockMath", raw: src.prefix(m.range.length))
    t.latex = Mapped(m.group(1, in: s)!).trimmed().string
    return t
  }

  /// TipTap's table tokenizer: when a line of the table has a | inside inline code, the pipes there are escaped first,
  /// so marked does not split the cell on them
  private mutating func tableExtension(_ src: Mapped) -> Token? {
    let blank = src.firstIndex(of: "\n\n")
    let candidate = blank.map { src.prefix($0) } ?? src
    let lines = candidate.lines()
    guard lines.count >= 2, Ext.tableSeparator.test(lines[1].ns), lines[1].firstIndex(of: "|") != nil else {
      return nil
    }
    let pre = Mapped.join(
      lines.map { line in
        line.firstIndex(of: "|") != nil && line.firstIndex(of: "`") != nil ? Self.escapeTableCellPipes(line) : line
      })
    if pre.units == candidate.units { return nil }
    var inner = BlockLexer()
    inner.links = links
    guard let t = inner.blockTokens(pre, []).first, t.type == "table", !t.raw.isEmpty else { return nil }
    let lineCount = t.raw.lines().count
    t.raw = Mapped.join(Array(src.lines().prefix(lineCount)))
    return t
  }

  /// TipTap's escapeTableCellPipes: | inside a code span becomes \| (one that is already \| stays)
  static func escapeTableCellPipes(_ line: Mapped) -> Mapped {
    let u = line.units
    var out = Mapped("", at: line.source.lowerBound)
    var i = 0
    var last = 0
    while i < u.count {
      if u[i] == 0x5C, i + 1 < u.count {
        i += 2
        continue
      }
      if u[i] != 0x60 {
        i += 1
        continue
      }
      var run = 0
      while i + run < u.count, u[i + run] == 0x60 { run += 1 }
      var j = i + run
      var found = false
      while j < u.count {
        if u[j] != 0x60 {
          j += 1
          continue
        }
        var close = 0
        while j + close < u.count, u[j + close] == 0x60 { close += 1 }
        if close == run {
          // inside the span: \| stays, | gets a backslash
          var k = i + run
          while k < j {
            if u[k] == 0x5C, k + 1 < j, u[k + 1] == 0x7C {
              k += 2
            } else if u[k] == 0x7C {
              out = out + line[last..<k] + .synthetic("\\", at: line.sourceOffset(k))
              last = k
              k += 1
            } else {
              k += 1
            }
          }
          i = j + run
          found = true
          break
        }
        j += close
      }
      if !found { i += run }
    }
    return out + line[last..<u.count]
  }

  /// TipTap's taskList tokenizer (its parseIndentedBlocks with the package's TASK_ITEM pattern)
  private mutating func taskList(_ src: Mapped) -> Token? {
    guard let r = taskBlocks(src) else { return nil }
    let t = Token("taskList", raw: r.raw)
    t.items = r.items
    t.phantom = r.phantom
    return t
  }

  /// phantom: how much longer TipTap's raw is than the source it took (the \n it adds after a last line that has none)
  private mutating func taskBlocks(_ src: Mapped) -> (raw: Mapped, items: [Token], phantom: Int)? {
    let lines = src.lines()
    var items: [Token] = []
    var rawLen = 0
    var i = 0
    // TipTap adds a \n after every line it takes, also after the last one when the source has none
    func takeLine(_ k: Int) { rawLen += lines[k].count + 1 }
    while i < lines.count {
      let line = lines[i]
      guard let m = Ext.taskItem.exec(line.ns) else {
        if !items.isEmpty { break }
        if line.trimmed().isEmpty {
          takeLine(i)
          i += 1
          continue
        }
        return nil
      }
      let indentLevel = m.groups[1]!.length
      let main = m.groups[4].map { line[$0.location..<$0.upperBound] } ?? Mapped("", at: line.source.upperBound)
      takeLine(i)
      var nested: [Mapped] = []
      i += 1
      while i < lines.count {
        let next = lines[i]
        if next.trimmed().isEmpty {
          guard let k = lines[(i + 1)...].firstIndex(where: { !$0.trimmed().isEmpty }) else { break }
          if Self.leadingSpace(lines[k]) > indentLevel {
            nested.append(next)
            takeLine(i)
            i += 1
            continue
          }
          break
        }
        if Self.leadingSpace(next) > indentLevel {
          nested.append(next)
          takeLine(i)
          i += 1
        } else {
          break
        }
      }
      let item = Token("taskItem", raw: line, text: main)
      item.checked = line.ns.substring(with: m.groups[3]!).lowercased() == "x"
      item.inline = true
      if !nested.isEmpty {
        let dedented = Mapped.join(nested.map { $0.dropFirst(indentLevel + 2) })
        if !dedented.trimmed().isEmpty {
          if let sub = taskBlocks(dedented) {
            let list = Token("taskList", raw: sub.raw)
            list.items = sub.items
            list.phantom = sub.phantom
            let rest = dedented.dropFirst(sub.raw.count)
            item.nested = [list] + (rest.trimmed().isEmpty ? [] : blockTokens(rest, []))
          } else {
            item.nested = blockTokens(dedented, [])
          }
        }
      }
      items.append(item)
    }
    if items.isEmpty { return nil }
    return (src.prefix(rawLen), items, max(0, rawLen - src.count))
  }

  /// the length of /^(\s*)/ (JavaScript's \s)
  static func leadingSpace(_ m: Mapped) -> Int {
    var n = 0
    while n < m.count, Mapped.isJSSpace(m.units[n]) { n += 1 }
    return n
  }
}
